import * as path from 'node:path';
import * as vscode from 'vscode';
import { loadProject, type LoadResult } from './dotnet.ts';
import { getInfo } from './feed.ts';
import { isOutdated, isVulnerable, type Package } from './model.ts';

export type Filter = 'all' | 'outdated' | 'vulnerable';

export interface ProjectNode {
  kind: 'project';
  file: vscode.Uri;
}

export interface PackageNode {
  kind: 'package';
  project: ProjectNode;
  pkg: Package;
}

interface MessageNode {
  kind: 'message';
  text: string;
  icon: string;
  color?: string;
}

export type Node = ProjectNode | PackageNode | MessageNode;

const EXCLUDE = '**/{bin,obj,node_modules,packages}/**';

export class PackagesProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private projects: ProjectNode[] | undefined;
  private readonly cache = new Map<string, Promise<LoadResult>>();
  private readonly disposables: vscode.Disposable[] = [this.changed];
  filter: Filter = 'all';

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.csproj');
    this.disposables.push(
      watcher,
      watcher.onDidCreate(() => this.refresh()),
      watcher.onDidDelete(() => this.refresh()),
      // Our own add/remove and external edits both land here.
      watcher.onDidChange(uri => this.invalidate(uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
    );
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  /** Re-scans the workspace and drops every cached project. */
  refresh(): void {
    this.projects = undefined;
    this.cache.clear();
    this.changed.fire(undefined);
  }

  /** Reloads one project (after an update, a removal or an edit of its file). */
  invalidate(file: vscode.Uri): void {
    this.cache.delete(file.toString());
    this.changed.fire(this.projects?.find(p => p.file.toString() === file.toString()));
  }

  setFilter(filter: Filter): void {
    this.filter = filter;
    this.changed.fire(undefined);
  }

  async findProjects(): Promise<ProjectNode[]> {
    if (!this.projects) {
      const files = await vscode.workspace.findFiles('**/*.csproj', EXCLUDE);
      files.sort((a, b) => vscode.workspace.asRelativePath(a).localeCompare(vscode.workspace.asRelativePath(b)));
      this.projects = files.map(file => ({ kind: 'project', file }));
      await vscode.commands.executeCommand('setContext', 'nukeeper.hasProjects', files.length > 0);
    }
    return this.projects;
  }

  private load(project: ProjectNode): Promise<LoadResult> {
    const key = project.file.toString();
    let p = this.cache.get(key);
    if (!p) {
      p = loadProject(project.file.fsPath);
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key)); // Retry on next expansion.
    }
    return p;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) return this.findProjects();
    if (node.kind !== 'project') return [];

    let result: LoadResult;
    try {
      result = await this.load(node);
    } catch (e) {
      return [{ kind: 'message', text: errorMessage(e), icon: 'error', color: 'errorForeground' }];
    }

    const children: Node[] = [];
    if (result.warnings.length > 0) {
      const what = result.warnings
        .map(w => (w === 'outdated' ? vscode.l10n.t('latest versions') : vscode.l10n.t('vulnerabilities')))
        .join(', ');
      children.push({ kind: 'message', text: vscode.l10n.t('Unavailable: {0}', what), icon: 'warning', color: 'list.warningForeground' });
    }
    const packages = [...result.data.packages.values()]
      .filter(p => this.filter === 'all' || (this.filter === 'outdated' ? isOutdated(p) : isVulnerable(p)))
      .sort((a, b) => Number(b.isDirect) - Number(a.isDirect) || a.id.localeCompare(b.id));
    children.push(...packages.map(pkg => ({ kind: 'package', project: node, pkg }) as const));
    if (packages.length === 0)
      children.push({ kind: 'message', text: vscode.l10n.t('No packages'), icon: 'info' });
    return children;
  }

  getParent(node: Node): Node | undefined {
    return node.kind === 'package' ? node.project : undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'project': {
        const item = new vscode.TreeItem(
          path.basename(node.file.fsPath, '.csproj'),
          this.projects?.length === 1 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = node.file.toString();
        item.resourceUri = node.file;
        item.description = path.dirname(vscode.workspace.asRelativePath(node.file));
        if (item.description === '.') item.description = '';
        item.iconPath = new vscode.ThemeIcon('project');
        item.contextValue = 'project';
        item.tooltip = node.file.fsPath;
        return item;
      }
      case 'package':
        return packageItem(node);
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon(node.icon, node.color ? new vscode.ThemeColor(node.color) : undefined);
        return item;
      }
    }
  }

  async resolveTreeItem(item: vscode.TreeItem, node: Node, token: vscode.CancellationToken): Promise<vscode.TreeItem> {
    if (node.kind !== 'package' || !node.pkg.resolved) return item;
    const md = item.tooltip instanceof vscode.MarkdownString ? item.tooltip : new vscode.MarkdownString();
    try {
      const info = await getInfo(node.pkg.id, node.pkg.resolved);
      if (token.isCancellationRequested) return item;
      md.appendMarkdown('\n\n---\n\n');
      if (info.description) md.appendText(info.description.replace(/\s+/g, ' ').trim()).appendMarkdown('\n\n');
      const meta: string[] = [];
      if (info.authors) meta.push(vscode.l10n.t('Authors: {0}', info.authors));
      if (info.downloads !== undefined) meta.push(vscode.l10n.t('Downloads: {0}', info.downloads.toLocaleString()));
      if (meta.length) md.appendText(meta.join(' · ')).appendMarkdown('\n\n');
      if (info.projectUrl) md.appendMarkdown(`[${vscode.l10n.t('Project site')}](${info.projectUrl})\n\n`);
      const groups = info.dependencies.filter(g => g.packages.length > 0);
      if (groups.length) {
        md.appendMarkdown(`**${vscode.l10n.t('Dependencies')}**\n\n`);
        for (const g of groups)
          md.appendMarkdown(`- \`${g.framework}\`: `).appendText(g.packages.map(d => `${d.id} ${d.range}`).join(', ')).appendMarkdown('\n');
      }
    } catch {
      // Metadata is a bonus; the summary is already there.
    }
    item.tooltip = md;
    return item;
  }
}

function packageItem(node: PackageNode): vscode.TreeItem {
  const { pkg } = node;
  const outdated = isOutdated(pkg);
  const vulnerable = isVulnerable(pkg);
  const item = new vscode.TreeItem(pkg.id);
  item.id = `${node.project.file.toString()}#${pkg.id.toLowerCase()}`;

  const parts = [outdated ? `${pkg.resolved} → ${pkg.latest}` : pkg.resolved];
  if (!pkg.isDirect) parts.push(vscode.l10n.t('transitive'));
  if (pkg.requested && pkg.requested !== pkg.resolved) parts.push(vscode.l10n.t('requested {0}', pkg.requested));
  item.description = parts.join(' · ');

  item.iconPath = vulnerable
    ? new vscode.ThemeIcon('shield', new vscode.ThemeColor('list.errorForeground'))
    : outdated
      ? new vscode.ThemeIcon('arrow-circle-up', new vscode.ThemeColor('list.warningForeground'))
      : new vscode.ThemeIcon('package', pkg.isDirect ? undefined : new vscode.ThemeColor('descriptionForeground'));

  item.contextValue = ['package', pkg.isDirect ? 'direct' : 'transitive', outdated && 'outdated', vulnerable && 'vulnerable']
    .filter(Boolean)
    .join(' ');

  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${pkg.id}** — ${pkg.isDirect ? vscode.l10n.t('direct') : vscode.l10n.t('transitive')}\n\n`);
  if (pkg.requested) md.appendMarkdown(`${vscode.l10n.t('Requested')}: \`${pkg.requested}\`  \n`);
  md.appendMarkdown(`${vscode.l10n.t('Resolved')}: \`${pkg.resolved || '?'}\`  \n`);
  if (outdated) md.appendMarkdown(`${vscode.l10n.t('Latest stable')}: \`${pkg.latest}\`  \n`);
  for (const v of pkg.vulnerabilities)
    md.appendMarkdown(`\n$(shield) ${vscode.l10n.t('Vulnerable ({0})', v.severity)}: ${v.advisoryUrl ? `[${v.advisoryUrl}](${v.advisoryUrl})` : ''}\n`);
  md.supportThemeIcons = true;
  item.tooltip = md;
  return item;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
