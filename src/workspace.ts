import * as vscode from 'vscode';
import { PromiseCache } from './cache.ts';
import type { Ecosystem, EcosystemId, LoadResult } from './ecosystem.ts';
import { globToRegExp } from './glob.ts';
import { withoutGitIgnored } from './ignored.ts';

/** A root file of the workspace (solution, package.json…) and the ecosystem managing it. */
export interface Root {
  readonly ecosystem: Ecosystem;
  readonly uri: vscode.Uri;
}

/** `packwise.ecosystems` setting: ecosystem id → enabled (missing ids are enabled). */
const SETTING = 'packwise.ecosystems';

/**
 * Roots of the workspace for every enabled ecosystem, their projects and the packages of each project
 * (cached, shared by every panel).
 */
export class Roots implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  /** The list of roots may have changed. */
  readonly onDidChange = this.changed.event;
  private readonly invalidated = new vscode.EventEmitter<vscode.Uri | undefined>();
  /** A project (or every project and root when undefined) must be reloaded. */
  readonly onDidInvalidate = this.invalidated.event;

  private roots: Promise<Root[]> | undefined;
  private readonly cache = new PromiseCache<string, LoadResult>();
  private readonly disposables: vscode.Disposable[] = [this.changed, this.invalidated];
  /** Watchers of the enabled ecosystems, rebuilt when the setting changes. */
  private watchers: vscode.Disposable[] = [];
  private readonly all: readonly Ecosystem[];
  private enabled: readonly Ecosystem[] = [];

  constructor(ecosystems: readonly Ecosystem[]) {
    this.all = ecosystems;
    this.configure();
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.rescan()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration(SETTING)) return;
        this.configure();
        this.refresh();
      }),
    );
  }

  dispose(): void {
    this.watchers.forEach(d => d.dispose());
    this.disposables.forEach(d => d.dispose());
  }

  /** Enabled ecosystems, in registration order. */
  get ecosystems(): readonly Ecosystem[] {
    return this.enabled;
  }

  private configure(): void {
    const setting = vscode.workspace.getConfiguration().get<Partial<Record<EcosystemId, boolean>>>(SETTING) ?? {};
    this.enabled = this.all.filter(e => setting[e.id] !== false);
    this.watchers.forEach(d => d.dispose());
    this.watchers = this.enabled.flatMap(e => {
      const rootWatcher = vscode.workspace.createFileSystemWatcher(e.rootGlob);
      const projectWatcher = vscode.workspace.createFileSystemWatcher(e.projectGlob);
      return [
        rootWatcher,
        projectWatcher,
        rootWatcher.onDidCreate(() => this.rescan()),
        rootWatcher.onDidDelete(() => this.rescan()),
        // Projects added to or removed from a root: panels re-read it, package caches stay valid.
        rootWatcher.onDidChange(() => this.invalidated.fire(undefined)),
        // Our own add/remove and external edits both land here.
        projectWatcher.onDidChange(uri => this.invalidate(uri)),
      ];
    });
  }

  /** Roots of the workspace, sorted by ecosystem then path. */
  find(): Promise<Root[]> {
    this.roots ??= (async () => {
      const relative = (u: vscode.Uri) => vscode.workspace.asRelativePath(u);
      const found = await Promise.all(
        this.enabled.map(async ecosystem => {
          const found = await vscode.workspace.findFiles(ecosystem.rootGlob, ecosystem.excludeGlob);
          // Build outputs (.next/, dist/…) copy manifests around: git-ignored files are never roots.
          const kept = await withoutGitIgnored(found.map(u => u.fsPath));
          const files = (await ecosystem.filterRoots(kept)).map(f => vscode.Uri.file(f));
          files.sort((a, b) => relative(a).localeCompare(relative(b)));
          return files.map(uri => ({ ecosystem, uri }));
        }),
      );
      const roots = found.flat();
      await vscode.commands.executeCommand('setContext', 'packwise.hasRoots', roots.length > 0);
      return roots;
    })();
    return this.roots;
  }

  /** The root of a file: the file itself when it is a root, else the first root it is a project of. */
  async rootOf(uri: vscode.Uri): Promise<Root | undefined> {
    const roots = await this.find();
    const key = uri.toString();
    const exact = roots.find(r => r.uri.toString() === key);
    if (exact) return exact;
    const file = vscode.workspace.asRelativePath(uri, false);
    for (const root of roots) {
      if (!globToRegExp(root.ecosystem.projectGlob).test(file)) continue;
      const projects = await this.projectsOf(root).catch(() => []);
      if (projects.some(p => p.toString() === key)) return root;
    }
    return undefined;
  }

  /** Project files of a root that exist on disk. */
  async projectsOf(root: Root): Promise<vscode.Uri[]> {
    return (await root.ecosystem.projectsOf(root.uri.fsPath)).map(f => vscode.Uri.file(f));
  }

  /** Packages of a project. */
  load(ecosystem: Ecosystem, file: vscode.Uri): Promise<LoadResult> {
    return this.cache.get(file.toString(), () => ecosystem.load(file.fsPath));
  }

  /** Reloads one project (after an update, a removal or an edit of its file). */
  invalidate(file: vscode.Uri): void {
    this.cache.delete(file.toString());
    this.invalidated.fire(file);
  }

  /** Re-scans the workspace and drops every cached project. */
  refresh(): void {
    this.cache.clear();
    this.rescan();
  }

  private rescan(): void {
    this.roots = undefined;
    this.changed.fire();
    this.invalidated.fire(undefined);
  }
}
