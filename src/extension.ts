import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Ecosystem } from './ecosystem.ts';
import { ECOSYSTEMS } from './ecosystems/index.ts';
import { setLogger } from './log.ts';
import { ManagerPanel } from './manager/panel.ts';
import { type Root, Roots } from './workspace.ts';

const LAST_ROOT = 'packwise.lastRoot';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Packwise', { log: true });
  setLogger(line => output.info(line));
  const roots = new Roots(ECOSYSTEMS);
  const list = new RootList(roots);
  const view = vscode.window.createTreeView('packwise.roots', { treeDataProvider: list });
  context.subscriptions.push(output, roots, list, view);
  void roots.find();

  const open = (root: Root) => {
    void context.workspaceState.update(LAST_ROOT, root.uri.toString());
    ManagerPanel.show(context, roots, root);
  };

  // Clicking the activity bar icon shows the view: open the manager right away, like a button.
  const onVisible = async () => {
    const all = await roots.find();
    const last = context.workspaceState.get<string>(LAST_ROOT);
    const root = all.length === 1 ? all[0] : all.find(r => r.uri.toString() === last);
    if (!root) return; // Several roots and none opened yet: the list lets the user pick.
    open(root);
    // With a single root the list is useless: give the room back to the editor.
    if (all.length === 1) await vscode.commands.executeCommand('workbench.action.closeSidebar');
  };
  context.subscriptions.push(view.onDidChangeVisibility(e => e.visible && void onVisible()));
  if (view.visible) void onVisible();

  context.subscriptions.push(
    // From the list, the Explorer or the editor title (root file), or the palette.
    vscode.commands.registerCommand('packwise.manage', async (arg?: vscode.Uri) => {
      const root = arg instanceof vscode.Uri ? await rootOrWarn(roots, arg) : await pickRoot(roots);
      if (root) open(root);
    }),
    vscode.commands.registerCommand('packwise.refresh', () => roots.refresh()),
  );
}

export function deactivate(): void {}

async function rootOrWarn(roots: Roots, uri: vscode.Uri): Promise<Root | undefined> {
  const root = await roots.rootOf(uri);
  if (!root) void vscode.window.showInformationMessage(vscode.l10n.t('{0} has no packages managed by Packwise.', path.basename(uri.fsPath)));
  return root;
}

async function pickRoot(roots: Roots): Promise<Root | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  const activeRoot = active && (await roots.rootOf(active));
  if (activeRoot) return activeRoot;
  const all = await roots.find();
  if (all.length <= 1) {
    if (all.length === 0) void vscode.window.showInformationMessage(vscode.l10n.t('No project with packages found in the workspace.'));
    return all[0];
  }
  const several = new Set(all.map(r => r.ecosystem)).size > 1;
  const picked = await vscode.window.showQuickPick(
    all.map(root => ({
      label: path.basename(root.uri.fsPath),
      description: [several ? root.ecosystem.label : '', location(root.uri)].filter(Boolean).join(' · '),
      root,
    })),
    { title: vscode.l10n.t('Manage packages of…') },
  );
  return picked?.root;
}

/** Folder of a file relative to the workspace ("" at its top). */
function location(uri: vscode.Uri): string {
  const dir = path.dirname(vscode.workspace.asRelativePath(uri));
  return dir === '.' ? '' : dir;
}

/** Tree node: an ecosystem heading (when several are present) or a root. */
type Node = { group: Ecosystem } | Root;

/** Roots of the workspace, grouped by ecosystem when there are several; selecting one opens its package manager. */
class RootList implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;
  private readonly roots: Roots;

  constructor(roots: Roots) {
    this.roots = roots;
    this.subscription = roots.onDidChange(() => this.changed.fire());
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const all = await this.roots.find();
    if (node) return 'group' in node ? all.filter(r => r.ecosystem === node.group) : [];
    const ecosystems = [...new Set(all.map(r => r.ecosystem))];
    return ecosystems.length > 1 ? ecosystems.map(group => ({ group })) : all;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if ('group' in node) {
      const item = new vscode.TreeItem(node.group.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${node.group.id}`;
      return item;
    }
    const item = new vscode.TreeItem(path.basename(node.uri.fsPath));
    item.id = node.uri.toString();
    item.resourceUri = node.uri;
    item.description = location(node.uri);
    item.iconPath = new vscode.ThemeIcon('package');
    item.tooltip = node.uri.fsPath;
    item.command = { command: 'packwise.manage', title: vscode.l10n.t('Manage Packages'), arguments: [node.uri] };
    return item;
  }
}
