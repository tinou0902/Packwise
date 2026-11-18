import * as path from 'node:path';
import * as vscode from 'vscode';
import { nuget } from './ecosystems/index.ts';
import { setLogger } from './log.ts';
import { ManagerPanel } from './manager/panel.ts';
import { Solutions } from './workspace.ts';

const LAST_SOLUTION = 'packwise.lastSolution';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Packwise', { log: true });
  setLogger(line => output.info(line));
  const solutions = new Solutions(nuget);
  const list = new SolutionList(solutions);
  const view = vscode.window.createTreeView('packwise.solutions', { treeDataProvider: list });
  context.subscriptions.push(output, solutions, list, view);
  void solutions.find();

  const open = (solution: vscode.Uri) => {
    void context.workspaceState.update(LAST_SOLUTION, solution.toString());
    ManagerPanel.show(context, solutions, solution);
  };

  // Clicking the activity bar icon shows the view: open the manager right away, like a button.
  const onVisible = async () => {
    const all = await solutions.find();
    const last = context.workspaceState.get<string>(LAST_SOLUTION);
    const solution = all.length === 1 ? all[0] : all.find(s => s.toString() === last);
    if (!solution) return; // Several solutions and none opened yet: the list lets the user pick.
    open(solution);
    // With a single solution the list is useless: give the room back to the editor.
    if (all.length === 1) await vscode.commands.executeCommand('workbench.action.closeSidebar');
  };
  context.subscriptions.push(view.onDidChangeVisibility(e => e.visible && void onVisible()));
  if (view.visible) void onVisible();

  context.subscriptions.push(
    // From the list, the Explorer or the editor title (.sln/.slnx resource), or the palette.
    vscode.commands.registerCommand('packwise.manageSolution', async (arg?: vscode.Uri) => {
      const solution = arg instanceof vscode.Uri ? arg : await pickSolution(solutions);
      if (solution) open(solution);
    }),
    vscode.commands.registerCommand('packwise.refresh', () => solutions.refresh()),
  );
}

export function deactivate(): void {}

async function pickSolution(solutions: Solutions): Promise<vscode.Uri | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && /\.slnx?$/i.test(active.fsPath)) return active;
  const all = await solutions.find();
  if (all.length <= 1) {
    if (all.length === 0) void vscode.window.showInformationMessage(vscode.l10n.t('No .sln or .slnx file in the workspace.'));
    return all[0];
  }
  const picked = await vscode.window.showQuickPick(
    all.map(file => ({ label: path.basename(file.fsPath), description: path.dirname(vscode.workspace.asRelativePath(file)), file })),
    { title: vscode.l10n.t('Manage NuGet packages of…') },
  );
  return picked?.file;
}

/** Solution files of the workspace; selecting one opens its package manager. */
class SolutionList implements vscode.TreeDataProvider<vscode.Uri>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;
  private readonly solutions: Solutions;

  constructor(solutions: Solutions) {
    this.solutions = solutions;
    this.subscription = solutions.onDidChange(() => this.changed.fire());
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  getChildren(element?: vscode.Uri): Promise<vscode.Uri[]> | vscode.Uri[] {
    return element ? [] : this.solutions.find();
  }

  getTreeItem(file: vscode.Uri): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(file.fsPath));
    item.resourceUri = file;
    const dir = path.dirname(vscode.workspace.asRelativePath(file));
    item.description = dir === '.' ? '' : dir;
    item.iconPath = new vscode.ThemeIcon('package');
    item.tooltip = file.fsPath;
    item.command = { command: 'packwise.manageSolution', title: vscode.l10n.t('Manage NuGet Packages for Solution'), arguments: [file] };
    return item;
  }
}
