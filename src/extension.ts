import * as vscode from 'vscode';
import { addPackage, removePackage, setLogger } from './dotnet.ts';
import { advisoriesFor, getVersions, getVulnerabilityDb, resetVulnerabilityDb, type VulnerableRange } from './feed.ts';
import { ManagerPanel } from './manager/panel.ts';
import { compareVersions, isPrerelease } from './semver.ts';
import { errorMessage, PackagesProvider, type Filter, type PackageNode, type ProjectNode } from './tree.ts';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('NuKeeper', { log: true });
  setLogger(line => output.info(line));
  const provider = new PackagesProvider();
  context.subscriptions.push(output);
  const view = vscode.window.createTreeView('nukeeper.packages', { treeDataProvider: provider, showCollapseAll: true });
  context.subscriptions.push(provider, view);
  void provider.findProjects();

  const command = <T>(id: string, fn: (arg: T) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  command<ProjectNode | undefined>('nukeeper.refresh', node => {
    if (node?.kind === 'project') provider.invalidate(node.file);
    else {
      resetVulnerabilityDb();
      provider.refresh();
    }
  });

  command('nukeeper.filter', async () => {
    const options: { label: string; filter: Filter }[] = [
      { label: vscode.l10n.t('All packages'), filter: 'all' },
      { label: vscode.l10n.t('Outdated'), filter: 'outdated' },
      { label: vscode.l10n.t('Vulnerable'), filter: 'vulnerable' },
    ];
    const picked = await vscode.window.showQuickPick(
      options.map(o => ({ ...o, picked: o.filter === provider.filter, description: o.filter === provider.filter ? '✓' : '' })),
      { title: vscode.l10n.t('Show packages') },
    );
    if (!picked) return;
    provider.setFilter(picked.filter);
    view.description = picked.filter === 'all' ? undefined : picked.label;
  });

  command<PackageNode>('nukeeper.updateToLatest', async node => {
    let version = node.pkg.latest;
    if (!version) {
      // Not reported as outdated (missing info): ask the feed.
      version = (await getVersions(node.pkg.id)).find(v => !isPrerelease(v)) ?? '';
    }
    if (!version || compareVersions(node.pkg.resolved, version) >= 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('{0} is already up to date ({1}).', node.pkg.id, node.pkg.resolved));
      return;
    }
    await setVersion(provider, node, version);
  });

  command<PackageNode>('nukeeper.chooseVersion', node => chooseVersion(provider, node));

  command<PackageNode>('nukeeper.remove', async node => {
    const remove = vscode.l10n.t('Remove');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Remove {0} from {1}?', node.pkg.id, vscode.workspace.asRelativePath(node.project.file)),
      { modal: true },
      remove,
    );
    if (answer !== remove) return;
    await runWithProgress(vscode.l10n.t('Removing {0}…', node.pkg.id), () =>
      removePackage(node.project.file.fsPath, node.pkg.id),
    );
    provider.invalidate(node.project.file);
  });

  command<PackageNode>('nukeeper.openOnNuGet', node =>
    vscode.env.openExternal(vscode.Uri.parse(`https://www.nuget.org/packages/${encodeURIComponent(node.pkg.id)}/${encodeURIComponent(node.pkg.resolved)}`)),
  );

  command<ProjectNode>('nukeeper.openProjectFile', node => vscode.window.showTextDocument(node.file));

  command('nukeeper.manageSolution', () => ManagerPanel.show(context, provider, undefined));

  // From the tree (project node), the Explorer or the editor title (.csproj resource), or the palette (active editor).
  command<ProjectNode | vscode.Uri | undefined>('nukeeper.manageProject', async arg => {
    const file = arg instanceof vscode.Uri ? arg : arg?.kind === 'project' ? arg.file : await pickProject(provider);
    if (file) ManagerPanel.show(context, provider, file);
  });

  command<PackageNode>('nukeeper.manageProjectPackage', node =>
    ManagerPanel.show(context, provider, node.project.file, { tab: 'installed', select: node.pkg.id }),
  );
}

export function deactivate(): void {}

async function pickProject(provider: PackagesProvider): Promise<vscode.Uri | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.fsPath.endsWith('.csproj')) return active;
  const projects = await provider.findProjects();
  if (projects.length <= 1) return projects[0]?.file;
  const picked = await vscode.window.showQuickPick(
    projects.map(p => ({ label: vscode.workspace.asRelativePath(p.file), file: p.file })),
    { title: vscode.l10n.t('Manage NuGet packages of…') },
  );
  return picked?.file;
}

async function runWithProgress(title: string, task: () => Promise<void>): Promise<boolean> {
  try {
    await vscode.window.withProgress({ location: { viewId: 'nukeeper.packages' }, title }, task);
    return true;
  } catch (e) {
    void vscode.window.showErrorMessage(errorMessage(e));
    return false;
  }
}

async function setVersion(provider: PackagesProvider, node: PackageNode, version: string): Promise<void> {
  if (!node.pkg.isDirect) {
    const update = vscode.l10n.t('Update');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('{0} is transitive: setting its version adds a direct reference to the project file.', node.pkg.id),
      { modal: true },
      update,
    );
    if (answer !== update) return;
  }
  const ok = await runWithProgress(vscode.l10n.t('{0} → {1}…', node.pkg.id, version), () =>
    addPackage(node.project.file.fsPath, node.pkg.id, version),
  );
  if (ok) provider.invalidate(node.project.file);
}

interface VersionItem extends vscode.QuickPickItem {
  version: string;
}

async function chooseVersion(provider: PackagesProvider, node: PackageNode): Promise<void> {
  const { pkg } = node;
  const qp = vscode.window.createQuickPick<VersionItem>();
  qp.title = vscode.l10n.t('{0} — choose a version', pkg.id);
  qp.placeholder = vscode.l10n.t('Current version: {0}', pkg.resolved);
  qp.busy = true;
  qp.show();

  const chosen = new Promise<string | undefined>(resolve => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]?.version));
    qp.onDidHide(() => resolve(undefined));
  });

  try {
    const [versions, db] = await Promise.all([
      getVersions(pkg.id),
      // Without the advisory database the list is still useful.
      getVulnerabilityDb().catch(() => undefined),
    ]);
    const latestStable = versions.find(v => !isPrerelease(v));
    qp.items = versions.map(v => versionItem(v, pkg.resolved, latestStable, db ? advisoriesFor(db, pkg.id, v) : []));
    const current = qp.items.find(i => i.version.toLowerCase() === pkg.resolved.toLowerCase());
    if (current) qp.activeItems = [current];
  } catch (e) {
    qp.hide();
    void vscode.window.showErrorMessage(vscode.l10n.t('Versions unavailable for {0}: {1}', pkg.id, errorMessage(e)));
    return;
  } finally {
    qp.busy = false;
  }

  const version = await chosen;
  qp.dispose();
  if (version && version.toLowerCase() !== pkg.resolved.toLowerCase()) await setVersion(provider, node, version);
}

function versionItem(version: string, resolved: string, latestStable: string | undefined, advisories: VulnerableRange[]): VersionItem {
  const tags: string[] = [];
  if (version.toLowerCase() === resolved.toLowerCase()) tags.push(vscode.l10n.t('current'));
  if (version === latestStable) tags.push(vscode.l10n.t('latest stable'));
  if (isPrerelease(version)) tags.push(vscode.l10n.t('prerelease'));
  const worst = advisories.map(a => a.severity).sort((a, b) => severityRank(b) - severityRank(a))[0];
  return {
    version,
    label: `${advisories.length ? '$(shield)' : '$(tag)'} ${version}`,
    description: tags.join(' · '),
    detail: advisories.length ? vscode.l10n.t('Vulnerable ({0}): avoid', worst) : undefined,
  };
}

function severityRank(severity: string): number {
  return ['Low', 'Moderate', 'High', 'Critical'].indexOf(severity);
}
