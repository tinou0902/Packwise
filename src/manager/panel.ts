import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { addPackage, listSources, loadLatestPrerelease, removePackage } from '../dotnet.ts';
import { FeedClient, NUGET_ORG, type SearchHit, type Source, type VersionDetails } from '../nuget.ts';
import { errorMessage, type PackagesProvider } from '../tree.ts';
import { ALL_SOURCES, type ProjectState, type Tab, type ToHost, type ToWebview } from './protocol.ts';
import { WEBVIEW_STRINGS } from './strings.ts';

const PAGE_SIZE = 25;
const LOAD_CONCURRENCY = 4;

/** Feed clients by service index URL, shared by every panel (their registration cache too). */
const clients = new Map<string, FeedClient>();

function client(source: Source): FeedClient {
  let c = clients.get(source.url);
  if (!c) clients.set(source.url, (c = new FeedClient(source)));
  return c;
}

export function resetFeedCaches(): void {
  clients.clear();
}

export interface ShowOptions {
  tab?: Tab;
  select?: string;
}

/** "Manage NuGet Packages" editor, for the whole workspace (solution) or one project, like Visual Studio's. */
export class ManagerPanel {
  private static readonly panels = new Map<string, ManagerPanel>();

  static show(context: vscode.ExtensionContext, provider: PackagesProvider, project: vscode.Uri | undefined, options: ShowOptions = {}): void {
    const key = project?.toString() ?? 'solution';
    const existing = ManagerPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      if (options.tab || options.select) existing.post({ ...existing.initMessage(), ...options });
      return;
    }
    const title = project
      ? vscode.l10n.t('NuGet: {0}', path.basename(project.fsPath, '.csproj'))
      : vscode.l10n.t('NuGet: Solution');
    const panel = vscode.window.createWebviewPanel('nukeeper.manager', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'nukeeper.svg');
    ManagerPanel.panels.set(key, new ManagerPanel(context, provider, panel, project, options, key));
  }

  private readonly disposables: vscode.Disposable[] = [];
  private projects: vscode.Uri[] = [];
  private readonly states = new Map<string, ProjectState>();
  private readonly prereleaseLatest = new Map<string, Promise<Map<string, string>>>();
  private prerelease = false;
  private sources: Source[] = [NUGET_ORG];
  private readonly pendingReload = new Set<string>();
  private reloadTimer: NodeJS.Timeout | undefined;
  private busy = false;

  private readonly provider: PackagesProvider;
  private readonly panel: vscode.WebviewPanel;
  private readonly project: vscode.Uri | undefined;
  private options: ShowOptions;
  private readonly key: string;

  private constructor(
    context: vscode.ExtensionContext,
    provider: PackagesProvider,
    panel: vscode.WebviewPanel,
    project: vscode.Uri | undefined,
    options: ShowOptions,
    key: string,
  ) {
    this.provider = provider;
    this.panel = panel;
    this.project = project;
    this.options = options;
    this.key = key;
    panel.webview.html = this.html(context);
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: ToHost) => void this.onMessage(m)),
      provider.onDidInvalidate(uri => this.scheduleReload(uri)),
    );
  }

  private dispose(): void {
    ManagerPanel.panels.delete(this.key);
    clearTimeout(this.reloadTimer);
    this.disposables.forEach(d => d.dispose());
  }

  private post(message: ToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  private initMessage(): Extract<ToWebview, { type: 'init' }> {
    return {
      type: 'init',
      mode: this.project ? 'project' : 'solution',
      title: this.project
        ? path.basename(this.project.fsPath, '.csproj')
        : (vscode.workspace.name ?? vscode.l10n.t('Workspace')),
      sources: this.sources.map(s => ({ name: s.name })),
      strings: Object.fromEntries(WEBVIEW_STRINGS.map(k => [k, vscode.l10n.t(k)])),
      tab: this.options.tab ?? 'browse',
      select: this.options.select,
    };
  }

  private async onMessage(m: ToHost): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.post(this.initMessage());
        this.options = {};
        await Promise.all([this.loadSources(), this.loadAll()]);
        return;
      case 'search':
        return this.search(m.seq, m.query, m.prerelease, m.source, m.skip);
      case 'summary':
        return this.summary(m.id, m.prerelease, m.source);
      case 'prerelease':
        this.prerelease = m.on;
        if (m.on) await this.forEachLimited(this.projects, uri => this.loadProject(uri));
        return;
      case 'install':
        return this.run(m.projects.map(uri => ({ uri, id: m.id, version: m.version, remove: false })));
      case 'update':
        if (m.updates.length > 1) {
          const update = vscode.l10n.t('Update');
          const answer = await vscode.window.showInformationMessage(
            vscode.l10n.t('Update {0} packages?', m.updates.length),
            { modal: true, detail: m.updates.map(u => `${u.id} → ${u.version}`).join('\n') },
            update,
          );
          if (answer !== update) return;
        }
        return this.run(m.updates.flatMap(u => u.projects.map(uri => ({ uri, id: u.id, version: u.version, remove: false }))));
      case 'uninstall': {
        const uninstall = vscode.l10n.t('Uninstall');
        const names = m.projects.map(uri => this.states.get(uri)?.name ?? uri);
        const answer = await vscode.window.showWarningMessage(
          vscode.l10n.t('Uninstall {0} from {1}?', m.id, names.join(', ')),
          { modal: true },
          uninstall,
        );
        if (answer !== uninstall) return;
        return this.run(m.projects.map(uri => ({ uri, id: m.id, version: '', remove: true })));
      }
      case 'refresh':
        resetFeedCaches();
        if (this.project) this.provider.invalidate(this.project);
        else this.provider.refresh();
        await this.loadSources();
        return;
      case 'openProject':
        await vscode.window.showTextDocument(vscode.Uri.parse(m.uri));
        return;
      case 'openUrl':
        if (/^https?:\/\//i.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
    }
  }

  // ---------- Projects ----------

  private async loadSources(): Promise<void> {
    const dir = this.project ? path.dirname(this.project.fsPath) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    try {
      const sources = dir ? await listSources(dir) : [];
      this.sources = sources.length > 0 ? sources : [NUGET_ORG];
    } catch {
      this.sources = [NUGET_ORG];
    }
    this.post({ type: 'sources', sources: this.sources.map(s => ({ name: s.name })) });
  }

  private async loadAll(): Promise<void> {
    this.projects = this.project ? [this.project] : (await this.provider.findProjects()).map(p => p.file);
    const keep = new Set(this.projects.map(String));
    for (const k of this.states.keys()) if (!keep.has(k)) this.states.delete(k);
    this.prereleaseLatest.clear();
    for (const uri of this.projects) this.setState(uri, { loading: true });
    this.postProjects();
    await this.forEachLimited(this.projects, uri => this.loadProject(uri));
  }

  private setState(uri: vscode.Uri, patch: Partial<ProjectState>): void {
    const key = uri.toString();
    const current: ProjectState = this.states.get(key) ?? {
      uri: key,
      name: path.basename(uri.fsPath, '.csproj'),
      path: vscode.workspace.asRelativePath(uri),
      loading: true,
      error: '',
      warnings: [],
      packages: [],
    };
    this.states.set(key, { ...current, ...patch });
  }

  private postProjects(): void {
    this.post({ type: 'projects', projects: this.projects.map(u => this.states.get(u.toString())!).filter(Boolean) });
  }

  private async loadProject(uri: vscode.Uri): Promise<void> {
    try {
      const { data, warnings } = await this.provider.load(uri);
      let pre = new Map<string, string>();
      const preWarnings: string[] = [];
      if (this.prerelease) {
        const key = uri.toString();
        let p = this.prereleaseLatest.get(key);
        if (!p) {
          p = loadLatestPrerelease(uri.fsPath);
          this.prereleaseLatest.set(key, p);
          p.catch(() => this.prereleaseLatest.delete(key));
        }
        pre = await p.catch(() => {
          preWarnings.push(vscode.l10n.t('latest prereleases'));
          return new Map<string, string>();
        });
      }
      this.setState(uri, {
        loading: false,
        error: '',
        warnings: [
          ...warnings.map(w => (w === 'outdated' ? vscode.l10n.t('latest versions') : vscode.l10n.t('vulnerabilities'))),
          ...preWarnings,
        ],
        packages: [...data.packages.values()].map(p => ({ ...p, latestPrerelease: pre.get(p.id.toLowerCase()) ?? '' })),
      });
    } catch (e) {
      this.setState(uri, { loading: false, error: errorMessage(e), warnings: [], packages: [] });
    }
    this.postProjects();
  }

  private scheduleReload(uri: vscode.Uri | undefined): void {
    if (uri && !this.projects.some(p => p.toString() === uri.toString())) return;
    this.pendingReload.add(uri?.toString() ?? '*');
    clearTimeout(this.reloadTimer);
    // Our own changes invalidate twice (explicitly and through the file watcher): coalesce.
    this.reloadTimer = setTimeout(() => {
      const keys = [...this.pendingReload];
      this.pendingReload.clear();
      if (keys.includes('*')) {
        void this.loadAll();
        return;
      }
      const uris = this.projects.filter(p => keys.includes(p.toString()));
      for (const u of uris) {
        this.prereleaseLatest.delete(u.toString());
        this.setState(u, { loading: true });
      }
      this.postProjects();
      void this.forEachLimited(uris, u => this.loadProject(u));
    }, 300);
  }

  private async forEachLimited<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items];
    await Promise.all(
      Array.from({ length: Math.min(LOAD_CONCURRENCY, queue.length) }, async () => {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
      }),
    );
  }

  // ---------- Feeds ----------

  private clientsFor(source: string): FeedClient[] {
    const selected = source === ALL_SOURCES ? this.sources : this.sources.filter(s => s.name === source);
    return (selected.length > 0 ? selected : this.sources).map(client);
  }

  private async search(seq: number, query: string, prerelease: boolean, source: string, skip: number): Promise<void> {
    const results = await Promise.allSettled(this.clientsFor(source).map(c => c.search(query, skip, PAGE_SIZE, prerelease)));
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    const errors: string[] = [];
    let hasMore = false;
    for (const r of results) {
      if (r.status === 'rejected') {
        errors.push(errorMessage(r.reason));
        continue;
      }
      hasMore ||= r.value.hits.length === PAGE_SIZE && skip + PAGE_SIZE < r.value.total;
      for (const h of r.value.hits) {
        const key = h.id.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          hits.push(h);
        }
      }
    }
    this.post({ type: 'searchResults', seq, append: skip > 0, hits, hasMore, errors });
  }

  /** First source (in configured order) that knows the package wins. */
  private async summary(id: string, prerelease: boolean, source: string): Promise<void> {
    let firstError: string | undefined;
    for (const c of this.clientsFor(source)) {
      const [hit, versions] = await Promise.allSettled([c.find(id, prerelease), c.versions(id)]);
      if (versions.status === 'rejected') {
        firstError ??= errorMessage(versions.reason);
        continue;
      }
      if (!versions.value) continue;
      const found: VersionDetails[] = versions.value;
      this.post({ type: 'summary', id, prerelease, source, hit: hit.status === 'fulfilled' ? hit.value : undefined, versions: found, nugetOrg: c.isNuGetOrg });
      return;
    }
    this.post({ type: 'summary', id, prerelease, source, error: firstError ?? vscode.l10n.t('{0} was not found in the selected package source.', id) });
  }

  // ---------- Changes ----------

  private async run(changes: { uri: string; id: string; version: string; remove: boolean }[]): Promise<void> {
    if (this.busy || changes.length === 0) return;
    this.busy = true;
    const failures: string[] = [];
    const touched = new Set<string>();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'NuGet', cancellable: true },
        async (progress, token) => {
          for (const [i, c] of changes.entries()) {
            if (token.isCancellationRequested) break;
            const project = this.states.get(c.uri)?.name ?? c.uri;
            const text = c.remove
              ? vscode.l10n.t('Uninstalling {0} from {1}…', c.id, project)
              : vscode.l10n.t('Installing {0} {1} in {2}…', c.id, c.version, project);
            progress.report({ message: text, increment: i === 0 ? 0 : 100 / changes.length });
            this.post({ type: 'busy', text });
            const file = vscode.Uri.parse(c.uri).fsPath;
            try {
              if (c.remove) await removePackage(file, c.id);
              else await addPackage(file, c.id, c.version);
            } catch (e) {
              failures.push(`${project}: ${errorMessage(e)}`);
            }
            touched.add(c.uri);
          }
        },
      );
    } finally {
      this.busy = false;
      this.post({ type: 'busy', text: '' });
      // Central package management changes Directory.Packages.props, which the .csproj watcher misses.
      for (const uri of touched) this.provider.invalidate(vscode.Uri.parse(uri));
    }
    if (failures.length > 0) void vscode.window.showErrorMessage(failures.join('\n'));
  }

  private html(context: vscode.ExtensionContext): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'manager.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      // Package icons come from the feeds.
      `img-src ${webview.cspSource} https: data:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
