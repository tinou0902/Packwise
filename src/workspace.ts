import * as vscode from 'vscode';
import { PromiseCache } from './cache.ts';
import { loadProject, type LoadResult } from './dotnet.ts';
import { parseSolution } from './solution.ts';

const EXCLUDE = '**/{bin,obj,node_modules,packages}/**';

/** Solutions of the workspace, their projects and the packages of each project (cached, shared by every panel). */
export class Solutions implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  /** The list of solutions may have changed. */
  readonly onDidChange = this.changed.event;
  private readonly invalidated = new vscode.EventEmitter<vscode.Uri | undefined>();
  /** A project (or every project and solution when undefined) must be reloaded. */
  readonly onDidInvalidate = this.invalidated.event;

  private solutions: Promise<vscode.Uri[]> | undefined;
  private readonly cache = new PromiseCache<string, LoadResult>();
  private readonly disposables: vscode.Disposable[] = [this.changed, this.invalidated];

  constructor() {
    const solutionWatcher = vscode.workspace.createFileSystemWatcher('**/*.{sln,slnx}');
    const projectWatcher = vscode.workspace.createFileSystemWatcher('**/*.csproj');
    this.disposables.push(
      solutionWatcher,
      projectWatcher,
      solutionWatcher.onDidCreate(() => this.rescan()),
      solutionWatcher.onDidDelete(() => this.rescan()),
      // Projects added to or removed from a solution: panels re-read it, package caches stay valid.
      solutionWatcher.onDidChange(() => this.invalidated.fire(undefined)),
      // Our own add/remove and external edits both land here.
      projectWatcher.onDidChange(uri => this.invalidate(uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.rescan()),
    );
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  /** Solution files of the workspace, sorted by path. */
  find(): Promise<vscode.Uri[]> {
    this.solutions ??= (async () => {
      const files = await vscode.workspace.findFiles('**/*.{sln,slnx}', EXCLUDE);
      files.sort((a, b) => vscode.workspace.asRelativePath(a).localeCompare(vscode.workspace.asRelativePath(b)));
      await vscode.commands.executeCommand('setContext', 'packwise.hasSolutions', files.length > 0);
      return files;
    })();
    return this.solutions;
  }

  /** Project files of a solution that exist on disk. */
  async projectsOf(solution: vscode.Uri): Promise<vscode.Uri[]> {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(solution));
    const files = parseSolution(text, solution.fsPath).map(f => vscode.Uri.file(f));
    const exists = await Promise.all(files.map(f => vscode.workspace.fs.stat(f).then(() => true, () => false)));
    return files.filter((_, i) => exists[i]);
  }

  /** Packages of a project. */
  load(file: vscode.Uri): Promise<LoadResult> {
    return this.cache.get(file.toString(), () => loadProject(file.fsPath));
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
    this.solutions = undefined;
    this.changed.fire();
    this.invalidated.fire(undefined);
  }
}
