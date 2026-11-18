import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { forEachLimited, PromiseCache } from '../cache.ts';
import { errorMessage } from '../errors.ts';
import type { Ecosystem } from '../ecosystem.ts';
import { Feeds } from '../feeds.ts';
import type { Root, Roots } from '../workspace.ts';
import { ALL_SOURCES, type ProjectState, type ToHost, type ToWebview } from './protocol.ts';
import { WEBVIEW_STRINGS } from './strings.ts';

const PAGE_SIZE = 25;
const LOAD_CONCURRENCY = 4;
/** Our own changes invalidate a project twice (explicitly and through the file watcher): coalesce them. */
const RELOAD_DELAY_MS = 300;

/** One package addition, update or removal to run. */
interface Change {
  /** Project file URI. */
  uri: string;
  id: string;
  /** Version to install ("" for a removal). */
  version: string;
  remove: boolean;
}

/** Package manager editor, like Visual Studio's "Manage NuGet Packages for Solution". One per root file. */
export class ManagerPanel {
  private static readonly panels = new Map<string, ManagerPanel>();

  static show(context: vscode.ExtensionContext, roots: Roots, root: Root): void {
    const key = root.uri.toString();
    const existing = ManagerPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const title = vscode.l10n.t('Packwise: {0}', root.ecosystem.rootName(root.uri.fsPath));
    const panel = vscode.window.createWebviewPanel('packwise.manager', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'packwise.svg');
    ManagerPanel.panels.set(key, new ManagerPanel(context, roots, panel, root));
  }

  private readonly disposables: vscode.Disposable[] = [];
  private projects: vscode.Uri[] = [];
  private readonly states = new Map<string, ProjectState>();
  /** Latest prerelease of each package, per project (fetched once the prerelease box is ticked). */
  private readonly prereleaseLatest = new PromiseCache<string, Map<string, string>>();
  private prerelease = false;
  private readonly pendingReload = new Set<string>();
  private reloadTimer: NodeJS.Timeout | undefined;
  private busy = false;

  private readonly roots: Roots;
  private readonly ecosystem: Ecosystem;
  private readonly feeds: Feeds;
  private readonly panel: vscode.WebviewPanel;
  /** Root file of the panel. */
  private readonly root: vscode.Uri;

  private constructor(context: vscode.ExtensionContext, roots: Roots, panel: vscode.WebviewPanel, root: Root) {
    this.roots = roots;
    this.ecosystem = root.ecosystem;
    this.feeds = new Feeds(this.ecosystem);
    this.panel = panel;
    this.root = root.uri;
    panel.webview.html = this.html(context);
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: ToHost) => void this.onMessage(m)),
      roots.onDidInvalidate(uri => this.scheduleReload(uri)),
    );
  }

  private dispose(): void {
    ManagerPanel.panels.delete(this.root.toString());
    clearTimeout(this.reloadTimer);
    this.disposables.forEach(d => d.dispose());
  }

  private post(message: ToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  private initMessage(): Extract<ToWebview, { type: 'init' }> {
    return {
      type: 'init',
      ecosystem: this.ecosystem.id,
      title: vscode.l10n.t(
        '{0} Package Manager: {1}',
        this.ecosystem.label,
        vscode.l10n.t(this.ecosystem.rootLabel, this.ecosystem.rootName(this.root.fsPath)),
      ),
      sources: this.sourceList(),
      strings: Object.fromEntries(WEBVIEW_STRINGS.map(k => [k, vscode.l10n.t(k)])),
    };
  }

  private async onMessage(m: ToHost): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.post(this.initMessage());
        await Promise.all([this.loadSources(), this.loadAll()]);
        return;
      case 'search': {
        const page = await this.feeds.search(m.query, m.prerelease, sourceName(m.source), m.skip, PAGE_SIZE);
        this.post({ type: 'searchResults', seq: m.seq, append: m.skip > 0, ...page });
        return;
      }
      case 'summary': {
        const summary = await this.feeds.summary(m.id, m.prerelease, sourceName(m.source));
        const echo = { type: 'summary', id: m.id, prerelease: m.prerelease, source: m.source } as const;
        this.post(summary.found
          ? { ...echo, hit: summary.hit, versions: summary.versions }
          : { ...echo, error: summary.error ?? vscode.l10n.t('{0} was not found in the selected package source.', m.id) });
        return;
      }
      case 'prerelease':
        this.prerelease = m.on;
        if (m.on) await this.loadProjects(this.projects);
        return;
      case 'install':
        return this.run(m.projects.map(uri => ({ uri, id: m.id, version: m.version, remove: false })));
      case 'update':
        if (m.updates.length > 1 && !(await this.confirmUpdate(m.updates))) return;
        return this.run(m.updates.flatMap(u => u.projects.map(uri => ({ uri, id: u.id, version: u.version, remove: false }))));
      case 'uninstall':
        if (!(await this.confirmUninstall(m.id, m.projects))) return;
        return this.run(m.projects.map(uri => ({ uri, id: m.id, version: '', remove: true })));
      case 'refresh':
        this.ecosystem.resetFeeds();
        this.roots.refresh();
        await this.loadSources();
        return;
      case 'openUrl':
        if (/^https?:\/\//i.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
    }
  }

  private async confirmUpdate(updates: { id: string; version: string }[]): Promise<boolean> {
    const update = vscode.l10n.t('Update');
    const answer = await vscode.window.showInformationMessage(
      vscode.l10n.t('Update {0} packages?', updates.length),
      { modal: true, detail: updates.map(u => `${u.id} → ${u.version}`).join('\n') },
      update,
    );
    return answer === update;
  }

  private async confirmUninstall(id: string, projects: string[]): Promise<boolean> {
    const uninstall = vscode.l10n.t('Uninstall');
    const names = projects.map(uri => this.projectName(uri));
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Uninstall {0} from {1}?', id, names.join(', ')),
      { modal: true },
      uninstall,
    );
    return answer === uninstall;
  }

  // ---------- Sources ----------

  private sourceList(): { name: string }[] {
    return this.feeds.names.map(name => ({ name }));
  }

  private async loadSources(): Promise<void> {
    // Unreadable configuration: the ecosystem's default sources.
    this.feeds.setSources(await this.ecosystem.sources(this.root.fsPath).catch(() => []));
    this.post({ type: 'sources', sources: this.sourceList() });
  }

  // ---------- Projects ----------

  private async loadAll(): Promise<void> {
    try {
      this.projects = await this.roots.projectsOf({ ecosystem: this.ecosystem, uri: this.root });
    } catch {
      // Root deleted or unreadable: the panel stays open, empty.
      this.projects = [];
    }
    const keep = new Set(this.projects.map(String));
    for (const k of this.states.keys()) if (!keep.has(k)) this.states.delete(k);
    this.prereleaseLatest.clear();
    for (const uri of this.projects) this.setState(uri, { loading: true });
    this.postProjects();
    await this.loadProjects(this.projects);
  }

  private loadProjects(uris: vscode.Uri[]): Promise<void> {
    return forEachLimited(uris, LOAD_CONCURRENCY, uri => this.loadProject(uri));
  }

  private projectName(uri: string): string {
    return this.states.get(uri)?.name ?? uri;
  }

  private setState(uri: vscode.Uri, patch: Partial<ProjectState>): void {
    const key = uri.toString();
    const current: ProjectState = this.states.get(key) ?? {
      uri: key,
      name: this.ecosystem.projectName(uri.fsPath),
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
      const { data, warnings } = await this.roots.load(this.ecosystem, uri);
      let pre = new Map<string, string>();
      const preWarnings: string[] = [];
      if (this.prerelease) {
        pre = await this.prereleaseLatest.get(uri.toString(), () => this.ecosystem.loadLatestPrerelease(uri.fsPath)).catch(() => {
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
        packages: [...data.packages.values()].map(p => ({ ...p, latestPrerelease: pre.get(this.ecosystem.normalizeId(p.id)) ?? '' })),
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
      void this.loadProjects(uris);
    }, RELOAD_DELAY_MS);
  }

  // ---------- Changes ----------

  private async run(changes: Change[]): Promise<void> {
    if (this.busy || changes.length === 0) return;
    this.busy = true;
    const failures: string[] = [];
    const touched = new Set<string>();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: this.ecosystem.label, cancellable: true },
        async (progress, token) => {
          for (const [i, c] of changes.entries()) {
            if (token.isCancellationRequested) break;
            const project = this.projectName(c.uri);
            const text = c.remove
              ? vscode.l10n.t('Uninstalling {0} from {1}…', c.id, project)
              : vscode.l10n.t('Installing {0} {1} in {2}…', c.id, c.version, project);
            progress.report({ message: text, increment: i === 0 ? 0 : 100 / changes.length });
            this.post({ type: 'busy', text });
            const file = vscode.Uri.parse(c.uri).fsPath;
            try {
              if (c.remove) await this.ecosystem.remove(file, c.id);
              else await this.ecosystem.add(file, c.id, c.version);
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
      // Shared files (Directory.Packages.props, lockfiles…) can change without the project file: reload explicitly.
      for (const uri of touched) this.roots.invalidate(vscode.Uri.parse(uri));
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

/** Source name of a request: undefined for every source. */
function sourceName(source: string): string | undefined {
  return source === ALL_SOURCES ? undefined : source;
}
