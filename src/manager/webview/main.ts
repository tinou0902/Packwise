/// <reference lib="dom" />
/* Package manager webview: layout and behaviour of Visual Studio's "Manage NuGet Packages" window, for any ecosystem. */

import { worstSeverity } from '../../advisory.ts';
import { RULES } from '../../ecosystems/rules.ts';
import {
  ALL_SOURCES,
  type PackageRules,
  type InstalledPackage,
  type ProjectState,
  type SearchHit,
  type Tab,
  type ToHost,
  type ToWebview,
  type VersionDetails,
} from '../protocol.ts';
import type { StringKey } from '../strings.ts';
import {
  formatDownloads,
  installedVersion,
  installsOf as installsIn,
  maxVersion as maxIn,
  galleryName,
  rowsFor as rowsIn,
  updateTarget as targetOf,
  versionChoices,
  type Row,
  type VersionChoice,
} from './packages.ts';

declare function acquireVsCodeApi(): {
  postMessage(message: ToHost): void;
  getState(): Persisted | undefined;
  setState(state: Persisted): void;
};

interface Persisted {
  listWidth?: number;
  source?: string;
  prerelease?: boolean;
}

const vscode = acquireVsCodeApi();
const send = (m: ToHost) => vscode.postMessage(m);

// ---------- State ----------

interface Summary {
  loading: boolean;
  hit?: SearchHit;
  versions?: VersionDetails[];
  error?: string;
}

const persisted = vscode.getState() ?? {};

const state = {
  title: '',
  hasDevDependencies: false,
  /** "Development dependency" box of the install actions. */
  dev: false,
  strings: {} as Record<string, string>,
  sources: [] as { name: string }[],
  source: persisted.source ?? ALL_SOURCES,
  tab: 'browse' as Tab,
  query: '',
  prerelease: persisted.prerelease ?? false,
  projects: [] as ProjectState[],
  browse: { seq: 0, hits: [] as SearchHit[], hasMore: false, loading: false, errors: [] as string[] },
  summaries: new Map<string, Summary>(),
  selected: undefined as string | undefined,
  /** Selected package id as given (the key is normalized). */
  selectedId: undefined as string | undefined,
  selectedVersion: undefined as string | undefined,
  checkedProjects: new Set<string>(),
  checkedUpdates: new Set<string>(),
  transitiveCollapsed: true,
  busy: '',
};

function t(key: StringKey, ...args: (string | number)[]): string {
  const s = state.strings[key] ?? key;
  return s.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)] ?? ''));
}

/** Identity and version rules of the panel's ecosystem (set by the init message). */
let rules: PackageRules = RULES.nuget;
/** Key of a package id. */
const idKey = (id: string) => rules.normalizeId(id);
/** Key of a version (case-insensitive). */
const lower = (s: string) => s.toLowerCase();
/** VS Code display language (set on <html> by the host). */
const locale = document.documentElement.lang || undefined;

// ---------- DOM helpers ----------

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, unknown>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'value' || k === 'indeterminate')
      (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS: Record<string, string> = {
  refresh: 'M13.5 2v3.5H10M2.5 14v-3.5H6M3.2 6a5 5 0 0 1 9.1-1.2l1.2.7M12.8 10a5 5 0 0 1-9.1 1.2l-1.2-.7',
  up: 'M8 13V3M3.5 7.5 8 3l4.5 4.5',
  warning: 'M8 1.8 14.8 14H1.2zM8 6v4M8 11.6v.8',
  check: 'M3 8.5 6.5 12 13 4.5',
  verified: 'M8 1l1.8 1.3 2.2-.1.7 2.1 1.8 1.3-.7 2.1.7 2.1-1.8 1.3-.7 2.1-2.2-.1L8 15l-1.8-1.3-2.2.1-.7-2.1-1.8-1.3.7-2.1-.7-2.1 1.8-1.3.7-2.1 2.2.1zM5.5 8.2l1.7 1.7 3.4-3.6',
  external: 'M9 2.5h4.5V7M13.5 2.5 7 9M11.5 9.5v4h-9v-9h4',
  chevron: 'M6 4l4 4-4 4',
  close: 'M4 4l8 8M12 4l-8 8',
};

function icon(name: keyof typeof ICONS, cls = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `icon ${cls}`);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function packageIcon(url: string | undefined, large = false): HTMLElement {
  const box = h('span', { class: `pkg-icon${large ? ' large' : ''}` });
  if (url) {
    const img = h('img', { src: url, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => img.remove());
    box.append(img);
  }
  return box;
}

function link(text: string, url: string): HTMLElement {
  return h('a', { href: '#', title: url, onclick: (e: Event) => { e.preventDefault(); send({ type: 'openUrl', url }); } }, text);
}

// ---------- Derived data ----------

const installsOf = (key: string) => installsIn(state.projects, key, rules);
const updateTarget = (p: InstalledPackage) => targetOf(p, state.prerelease, rules);
const maxVersion = (versions: readonly (string | undefined)[]) => maxIn(versions, rules);
const rowsFor = (tab: Tab) =>
  rowsIn(tab, { projects: state.projects, hits: state.browse.hits, query: state.query, prerelease: state.prerelease, rules });

function summaryOf(key: string): Summary | undefined {
  return state.summaries.get(key);
}

function requestSummary(id: string): void {
  const key = idKey(id);
  if (state.summaries.has(key)) return;
  state.summaries.set(key, { loading: true });
  send({ type: 'summary', id, prerelease: state.prerelease, source: state.source });
}

function hitOf(row: Row): SearchHit | undefined {
  return row.hit ?? summaryOf(row.key)?.hit;
}

// ---------- Layout (built once) ----------

const app = document.getElementById('app')!;
const tabsBar = h('div', { class: 'tabs', role: 'tablist' });
const heading = h('div', { class: 'heading' });
const search = h('input', { class: 'search', type: 'search', spellcheck: 'false' });
const refreshButton = h('button', { class: 'icon-button', onclick: () => { state.summaries.clear(); send({ type: 'refresh' }); doSearch(); } }, icon('refresh'));
const prereleaseBox = h('input', { type: 'checkbox', id: 'prerelease' });
const sourceSelect = h('select', { class: 'source' });
const sourceLabel = h('label', { for: 'source' });
const prereleaseLabel = h('label', { for: 'prerelease' });
const updateBar = h('div', { class: 'update-bar' });
const listPane = h('div', { class: 'list', tabindex: '0', role: 'listbox' });
const splitter = h('div', { class: 'splitter' });
const detailPane = h('div', { class: 'details' });
const statusBar = h('div', { class: 'status' });

sourceSelect.id = 'source';

app.append(
  h('div', { class: 'header' }, tabsBar, heading),
  h('div', { class: 'toolbar' },
    h('div', { class: 'toolbar-left' }, search, refreshButton, h('span', { class: 'prerelease' }, prereleaseBox, prereleaseLabel)),
    h('div', { class: 'toolbar-right' }, sourceLabel, sourceSelect),
  ),
  h('div', { class: 'main' }, h('div', { class: 'left' }, updateBar, listPane), splitter, detailPane),
  statusBar,
);

if (persisted.listWidth) app.style.setProperty('--list-width', `${persisted.listWidth}px`);
prereleaseBox.checked = state.prerelease;

// ---------- Rendering ----------

function render(): void {
  renderTabs();
  renderList();
  renderDetails();
  statusBar.textContent = state.busy;
  statusBar.hidden = !state.busy;
  app.classList.toggle('busy', !!state.busy);
}

function renderStatic(): void {
  search.placeholder = t('Search (Ctrl+L)');
  refreshButton.title = t('Refresh');
  prereleaseLabel.textContent = t('Include prerelease');
  sourceLabel.textContent = t('Package source:');
  heading.textContent = state.title;
  renderSources();
}

function renderSources(): void {
  const options = state.sources.length > 1 ? [{ value: ALL_SOURCES, label: t('All') }] : [];
  options.push(...state.sources.map(s => ({ value: s.name, label: s.name })));
  if (!options.some(o => o.value === state.source)) state.source = options[0]?.value ?? ALL_SOURCES;
  sourceSelect.replaceChildren(...options.map(o => h('option', { value: o.value, selected: o.value === state.source }, o.label)));
}

function renderTabs(): void {
  const tabs: [Tab, StringKey][] = [['browse', 'Browse'], ['installed', 'Installed'], ['updates', 'Updates'], ['consolidate', 'Consolidate']];
  const loading = state.projects.some(p => p.loading);
  tabsBar.replaceChildren(
    ...tabs.map(([tab, label]) => {
      const count = tab === 'updates' || tab === 'consolidate' ? rowsFor(tab).rows.length : 0;
      return h('button', {
        class: `tab${state.tab === tab ? ' active' : ''}`,
        role: 'tab',
        'aria-selected': String(state.tab === tab),
        onclick: () => switchTab(tab),
      }, t(label), count > 0 && h('span', { class: 'badge' }, String(count)), tab !== 'browse' && loading && h('span', { class: 'spinner' }));
    }),
  );
}

function switchTab(tab: Tab): void {
  if (state.tab === tab) return;
  state.tab = tab;
  state.selected = undefined;
  state.selectedId = undefined;
  state.selectedVersion = undefined;
  if (tab === 'browse' && state.browse.hits.length === 0) doSearch();
  render();
  listPane.scrollTop = 0;
}

const visibility = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const id = (e.target as HTMLElement).dataset.id;
    if (id) requestSummary(id);
    visibility.unobserve(e.target);
  }
}, { root: listPane });

function renderList(): void {
  const scroll = listPane.scrollTop;
  visibility.disconnect();
  const { rows, transitive } = rowsFor(state.tab);

  // Updates tab: "Select all packages" + "Update".
  updateBar.hidden = state.tab !== 'updates' || rows.length === 0;
  if (!updateBar.hidden) {
    for (const k of [...state.checkedUpdates]) if (!rows.some(r => r.key === k)) state.checkedUpdates.delete(k);
    const all = rows.every(r => state.checkedUpdates.has(r.key));
    updateBar.replaceChildren(
      h('label', null,
        h('input', {
          type: 'checkbox',
          checked: all,
          indeterminate: !all && state.checkedUpdates.size > 0,
          onchange: () => {
            if (all) state.checkedUpdates.clear();
            else rows.forEach(r => state.checkedUpdates.add(r.key));
            render();
          },
        }),
        t('Select all packages'),
      ),
      h('button', {
        disabled: state.checkedUpdates.size === 0 || !!state.busy,
        onclick: () => updateChecked(rows),
      }, t('Update')),
    );
  }

  const children: HTMLElement[] = [];
  if (state.tab === 'browse') {
    for (const e of state.browse.errors) children.push(h('div', { class: 'message error' }, icon('warning'), e));
  }
  const warnings = state.projects.filter(p => p.error || p.warnings.length);
  if (state.tab !== 'browse') {
    for (const p of state.projects.filter(x => x.notice)) children.push(h('div', { class: 'message' }, `${p.name}: ${p.notice}`));
    for (const p of warnings) {
      children.push(h('div', { class: `message ${p.error ? 'error' : 'warning'}` }, icon('warning'), `${p.name}: ${p.error || p.warnings.join(', ')}`));
    }
  }

  if (state.tab === 'installed' && (transitive.length > 0)) {
    children.push(h('div', { class: 'group' }, t('Top-level packages ({0})', rows.length)));
  }
  children.push(...rows.map(renderRow));
  if (state.tab === 'installed' && transitive.length > 0) {
    children.push(h('button', {
      class: `group collapsible${state.transitiveCollapsed ? '' : ' open'}`,
      onclick: () => { state.transitiveCollapsed = !state.transitiveCollapsed; renderList(); },
    }, icon('chevron'), t('Transitive packages ({0})', transitive.length)));
    if (!state.transitiveCollapsed) children.push(...transitive.map(renderRow));
  }

  const loadingProjects = state.tab !== 'browse' && state.projects.some(p => p.loading);
  if (state.tab === 'browse' && state.browse.loading) children.push(h('div', { class: 'message' }, h('span', { class: 'spinner' }), t('Loading…')));
  else if (rows.length === 0 && transitive.length === 0) {
    if (loadingProjects) children.push(h('div', { class: 'message' }, h('span', { class: 'spinner' }), t('Loading…')));
    else {
      const empty = state.tab === 'updates' && !state.query ? t('All packages are up to date.')
        : state.tab === 'consolidate' && !state.query ? t('Packages installed in several versions are shown here.')
          : state.tab === 'browse' && !state.query.trim() ? t('Type a package name to search.')
            : t('No packages found');
      children.push(h('div', { class: 'message empty' }, empty));
    }
  }
  if (state.tab === 'browse' && state.browse.hasMore && !state.browse.loading) {
    const more = h('div', { class: 'message more' }, h('span', { class: 'spinner' }), t('Load more'));
    children.push(more);
    new IntersectionObserver((entries, obs) => {
      if (entries.some(e => e.isIntersecting)) {
        obs.disconnect();
        loadMore();
      }
    }, { root: listPane }).observe(more);
  }
  listPane.replaceChildren(...children);
  listPane.scrollTop = scroll;
  for (const el of listPane.querySelectorAll<HTMLElement>('.row[data-id]')) {
    if (!state.summaries.has(idKey(el.dataset.id!))) visibility.observe(el);
  }
}

function renderRow(row: Row): HTMLElement {
  const hit = hitOf(row);
  const summary = summaryOf(row.key);
  const installed = maxVersion(row.installs.map(i => i.pkg.resolved));
  const versions = new Set(row.installs.map(i => installedVersion(i.pkg)));
  const vulnerable = row.installs.some(i => i.pkg.vulnerabilities.length > 0) || (state.tab === 'browse' && hit?.vulnerable);
  const deprecated = hit?.deprecated || (summary?.versions?.find(v => installed && lower(v.version) === lower(installed))?.deprecation !== undefined);
  const update = maxVersion(row.installs.map(i => updateTarget(i.pkg)));
  const latest = hit?.version;

  const kinds = [...new Set(row.installs.map(i => i.pkg.kind).filter(k => k !== undefined))];
  const meta: string[] = [];
  if (hit?.authors) meta.push(t('by {0}', hit.authors));
  if (hit?.totalDownloads !== undefined) meta.push(t('{0} downloads', formatDownloads(hit.totalDownloads)));

  const right: Child[] = [];
  if (state.tab === 'browse') {
    if (installed) right.push(h('div', { class: 'ver installed' }, icon('check'), versions.size > 1 ? t('multiple') : [...versions][0]));
    if (!installed || (latest && rules.compareVersions(installed, latest) < 0)) right.push(h('div', { class: `ver${installed ? ' update' : ''}` }, installed && icon('up'), latest));
  } else if (state.tab === 'consolidate') {
    right.push(h('div', { class: 'ver' }, [...versions].sort(rules.compareVersions).join(', ')));
  } else if (row.transitive) {
    const res = maxVersion(state.projects.flatMap(p => p.packages.filter(x => idKey(x.id) === row.key).map(x => x.resolved)));
    right.push(h('div', { class: 'ver dim' }, res));
  } else {
    right.push(h('div', { class: 'ver' }, versions.size > 1 ? t('multiple') : [...versions][0]));
    const target = state.tab === 'updates' ? row.target : update;
    if (target) right.push(h('div', { class: 'ver update' }, icon('up'), target));
  }

  const checkbox = state.tab === 'updates'
    ? h('input', {
      type: 'checkbox',
      class: 'row-check',
      checked: state.checkedUpdates.has(row.key),
      onclick: (e: Event) => e.stopPropagation(),
      onchange: (e: Event) => {
        if ((e.target as HTMLInputElement).checked) state.checkedUpdates.add(row.key);
        else state.checkedUpdates.delete(row.key);
        render();
      },
    })
    : null;

  return h('div', {
    class: `row${state.selected === row.key ? ' selected' : ''}${row.transitive ? ' transitive' : ''}`,
    role: 'option',
    'aria-selected': String(state.selected === row.key),
    'data-id': row.id,
    onclick: () => select(row.id),
  },
    checkbox,
    packageIcon(hit?.iconUrl),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' },
        h('span', { class: 'id' }, row.id),
        ...kinds.map(k => h('span', { class: 'kind' }, k)),
        hit?.verified && h('span', { class: 'verified', title: t('Prefix reserved: verified owner') }, icon('verified')),
        meta.length > 0 && h('span', { class: 'meta' }, meta.join(', ')),
      ),
      h('div', { class: 'row-desc' }, hit?.description ?? (summary?.loading ? '' : summary?.error ?? '')),
    ),
    h('div', { class: 'row-right' },
      (vulnerable || deprecated) && h('span', { class: `flag ${vulnerable ? 'vulnerable' : 'deprecated'}`, title: vulnerable ? t('vulnerable') : t('deprecated') }, icon('warning')),
      h('div', { class: 'versions' }, ...right),
    ),
  );
}

function select(id: string | undefined): void {
  const key = id ? idKey(id) : undefined;
  if (state.selected === key) return;
  state.selected = key;
  state.selectedId = id;
  state.selectedVersion = undefined;
  if (key) {
    const installs = installsOf(key);
    state.checkedProjects = new Set(state.tab === 'browse' ? [] : installs.map(i => i.project.uri));
    requestSummary(id!);
  }
  render();
  listPane.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' });
  detailPane.scrollTop = 0;
}

// ---------- Detail pane ----------

function choiceLabel(c: VersionChoice): string {
  switch (c.kind) {
    case 'latestStable':
      return t('Latest stable {0}', c.value);
    case 'latestPrerelease':
      return t('Latest prerelease {0}', c.value);
    case 'version':
      return c.flags.length > 0 ? `${c.value} (${c.flags.map(f => t(f)).join(', ')})` : c.value;
  }
}

function renderDetails(): void {
  const scroll = detailPane.scrollTop;
  const key = state.selected;
  if (!key) {
    detailPane.replaceChildren(h('div', { class: 'message empty' }, t('Select a package to see its details.')));
    return;
  }
  const row = rowsFor(state.tab);
  const found = [...row.rows, ...row.transitive].find(r => r.key === key);
  const summary = summaryOf(key);
  const hit = found?.hit ?? summary?.hit;
  const id = found?.id ?? hit?.id ?? summary?.versions?.at(-1)?.id ?? state.selectedId ?? key;
  const installs = installsOf(key);
  const installedVersions = installs.map(i => installedVersion(i.pkg));
  const versions = summary?.versions ?? [];
  const choices = versionChoices(versions, installedVersions, state.prerelease, rules);

  // Default version: the update target, else the latest stable (or prerelease when allowed).
  if (!state.selectedVersion || (versions.length > 0 && !choices.some(c => lower(c.value) === lower(state.selectedVersion!)))) {
    const target = maxVersion(installs.map(i => updateTarget(i.pkg)));
    state.selectedVersion = target ?? choices[0]?.value ?? hit?.version;
  }
  const selected = state.selectedVersion;
  const details = versions.find(v => selected && lower(v.version) === lower(selected));
  const latestDetails = versions.at(-1);
  const iconUrl = details?.iconUrl || hit?.iconUrl || latestDetails?.iconUrl;
  const busy = !!state.busy;

  const children: Child[] = [];
  children.push(
    h('div', { class: 'detail-header' },
      packageIcon(iconUrl, true),
      h('div', { class: 'detail-title' },
        h('span', { class: 'id' }, id),
        hit?.verified && h('span', { class: 'verified', title: t('Prefix reserved: verified owner') }, icon('verified')),
      ),
      details?.galleryUrl && h('a', {
        class: 'icon-link',
        href: '#',
        title: galleryName(details.galleryUrl),
        onclick: (e: Event) => { e.preventDefault(); send({ type: 'openUrl', url: details.galleryUrl! }); },
      }, galleryName(details.galleryUrl), icon('external')),
    ),
  );

  const transitiveOnly = installs.length === 0 && state.projects.some(p => p.packages.some(x => idKey(x.id) === key));
  if (transitiveOnly) children.push(h('div', { class: 'banner info' }, t('Transitively referenced: installing it adds a top-level reference.')));

  // ----- Projects and actions -----
  const versionSelect = h('select', {
    class: 'version-select',
    disabled: choices.length === 0,
    onchange: (e: Event) => { state.selectedVersion = (e.target as HTMLSelectElement).value; renderDetails(); },
  }, ...(choices.length > 0
    ? choices.map((c, i) => h('option', { value: c.value, selected: i === choices.findIndex(x => lower(x.value) === lower(selected ?? '')) }, choiceLabel(c)))
    : [h('option', { value: selected ?? '', selected: true }, selected ?? t('Loading…'))]));

  const checked = state.projects.filter(p => state.checkedProjects.has(p.uri));
  const allChecked = state.projects.length > 0 && checked.length === state.projects.length;
  const versionIn = (p: ProjectState) => p.packages.find(x => x.isDirect && idKey(x.id) === key);
  if (new Set(installedVersions.map(lower)).size > 1) children.push(h('div', { class: 'banner info' }, t('Several versions of this package are installed.')));
  children.push(h('table', { class: 'projects' },
    h('thead', null, h('tr', null,
      h('th', { class: 'check' }, h('input', {
        type: 'checkbox',
        checked: allChecked,
        indeterminate: !allChecked && checked.length > 0,
        onchange: () => {
          state.checkedProjects = new Set(allChecked ? [] : state.projects.map(p => p.uri));
          renderDetails();
        },
      })),
      h('th', null, t('Project')),
      h('th', null, t('Version')),
    )),
    h('tbody', null, ...state.projects.map(p => {
      const pkg = versionIn(p);
      return h('tr', {
        class: state.checkedProjects.has(p.uri) ? 'checked' : '',
        onclick: (e: Event) => {
          if ((e.target as HTMLElement).tagName === 'INPUT') return;
          toggleProject(p.uri);
        },
      },
        h('td', { class: 'check' }, h('input', { type: 'checkbox', checked: state.checkedProjects.has(p.uri), onchange: () => toggleProject(p.uri) })),
        h('td', { title: p.path }, p.name),
        h('td', null, pkg ? installedVersion(pkg) : p.loading ? '…' : '', pkg?.kind && h('span', { class: 'kind' }, pkg.kind)),
      );
    })),
  ));
  const toInstall = checked.filter(p => !p.loading && (!versionIn(p) || lower(versionIn(p)!.resolved) !== lower(selected ?? '')));
  const toRemove = checked.filter(p => versionIn(p));
  children.push(h('div', { class: 'actions' },
    h('label', null, t('Version:')),
    versionSelect,
    h('button', {
      disabled: busy || !selected || toInstall.length === 0,
      onclick: () => send({ type: 'install', id, version: selected!, projects: toInstall.map(p => p.uri), dev: state.dev }),
    }, t('Install')),
    h('button', {
      class: 'secondary',
      disabled: busy || toRemove.length === 0,
      onclick: () => send({ type: 'uninstall', id, projects: toRemove.map(p => p.uri) }),
    }, t('Uninstall')),
  ));
  // Existing references keep their dependency type: the box only applies to new ones.
  if (state.hasDevDependencies && toInstall.some(p => !versionIn(p))) {
    children.push(h('label', { class: 'dev-option' },
      h('input', { type: 'checkbox', checked: state.dev, onchange: (e: Event) => { state.dev = (e.target as HTMLInputElement).checked; } }),
      t('Development dependency')));
  }

  // ----- Warnings of the selected version -----
  const advisories = details?.vulnerabilities ?? [];
  if (advisories.length > 0) {
    const worst = worstSeverity(advisories)!; // Non-empty list.
    children.push(h('div', { class: 'banner error' }, icon('warning'),
      h('div', null, t('This package version has a known {0} severity vulnerability.', worst),
        ...advisories.map(a => h('div', null, link(a.advisoryUrl, a.advisoryUrl))))));
  }
  if (details?.deprecation) {
    const d = details.deprecation;
    children.push(h('div', { class: 'banner warning' }, icon('warning'),
      h('div', null,
        h('div', null, t('This package version is deprecated.'), d.reasons.length > 0 ? ` (${d.reasons.join(', ')})` : ''),
        d.message && h('div', { class: 'dim' }, d.message),
        d.alternateId && h('div', null, t('Alternate package:'), ' ', h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); openAlternate(d.alternateId); } }, d.alternateId)),
      )));
  }

  // ----- Metadata -----
  if (summary?.error) children.push(h('div', { class: 'banner warning' }, icon('warning'), t('Package details unavailable: {0}', summary.error)));
  const meta = details ?? (summary?.loading ? undefined : latestDetails);
  const description = meta?.description || hit?.description || '';
  if (summary?.loading && !hit) children.push(h('div', { class: 'message' }, h('span', { class: 'spinner' }), t('Loading…')));
  if (description || meta) {
    const fields: [StringKey, Child][] = [
      ['Version', meta?.version ?? selected],
      ['Owner(s)', hit?.owners],
      ['Author(s)', meta?.authors || hit?.authors],
      ['License', meta?.licenseExpression
        ? (meta.licenseUrl ? link(meta.licenseExpression, meta.licenseUrl) : meta.licenseExpression)
        : meta?.licenseUrl ? link(t('View License'), meta.licenseUrl) : ''],
      ['Downloads', hit?.totalDownloads !== undefined ? hit.totalDownloads.toLocaleString(locale) : ''],
      ['Date published', meta?.published ? new Date(meta.published).toLocaleString(locale, { dateStyle: 'full', timeStyle: 'short' }) : ''],
      ['Project URL', meta?.projectUrl ? link(meta.projectUrl, meta.projectUrl) : ''],
      ['Report Abuse', meta?.reportUrl ? link(meta.reportUrl, meta.reportUrl) : ''],
      ['Tags', meta?.tags.join(', ')],
    ];
    children.push(
      h('h3', null, t('Description')),
      h('p', { class: 'description' }, description),
      h('dl', { class: 'fields' }, ...fields.filter(([, v]) => v).flatMap(([k, v]) => [h('dt', null, t(k)), h('dd', null, v)])),
    );
    if (meta?.dependencies) {
      const groups = meta.dependencies;
      children.push(h('h3', null, t('Dependencies')));
      if (groups.length === 0) children.push(h('p', { class: 'dim' }, t('No dependencies')));
      for (const g of groups) {
        children.push(h('div', { class: 'dep-group' }, g.group));
        children.push(g.packages.length === 0
          ? h('div', { class: 'dep dim' }, t('No dependencies'))
          : h('ul', { class: 'deps' }, ...g.packages.map(p => h('li', null, `${p.id} (${p.range})`))));
      }
    }
  }

  detailPane.replaceChildren(...children.filter((c): c is Node | string => !!c));
  detailPane.scrollTop = scroll;
}

function toggleProject(uri: string): void {
  if (state.checkedProjects.has(uri)) state.checkedProjects.delete(uri);
  else state.checkedProjects.add(uri);
  renderDetails();
}

function openAlternate(id: string): void {
  state.tab = 'browse';
  state.query = id;
  search.value = id;
  doSearch();
  select(id);
}

function updateChecked(rows: Row[]): void {
  const updates = rows
    .filter(r => state.checkedUpdates.has(r.key) && r.target)
    .map(r => ({
      id: r.id,
      version: r.target!,
      projects: r.installs.filter(i => rules.compareVersions(i.pkg.resolved, r.target!) < 0).map(i => i.project.uri),
    }))
    .filter(u => u.projects.length > 0);
  if (updates.length > 0) send({ type: 'update', updates });
}

// ---------- Search ----------

let searchTimer: ReturnType<typeof setTimeout> | undefined;

function doSearch(): void {
  clearTimeout(searchTimer);
  if (state.tab !== 'browse') {
    render();
    return;
  }
  state.browse = { seq: state.browse.seq + 1, hits: [], hasMore: false, loading: true, errors: [] };
  send({ type: 'search', seq: state.browse.seq, query: state.query, prerelease: state.prerelease, source: state.source, skip: 0 });
  render();
}

function loadMore(): void {
  if (state.browse.loading || !state.browse.hasMore) return;
  state.browse.loading = true;
  send({ type: 'search', seq: state.browse.seq, query: state.query, prerelease: state.prerelease, source: state.source, skip: state.browse.hits.length });
}

search.addEventListener('input', () => {
  state.query = search.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, state.tab === 'browse' ? 350 : 0);
});
search.addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch();
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    listPane.focus();
    moveSelection(1);
  }
});

prereleaseBox.addEventListener('change', () => {
  state.prerelease = prereleaseBox.checked;
  persist();
  state.summaries.clear();
  state.selectedVersion = undefined;
  send({ type: 'prerelease', on: state.prerelease });
  refetchSelected();
  doSearch();
});

sourceSelect.addEventListener('change', () => {
  state.source = sourceSelect.value;
  persist();
  state.summaries.clear();
  refetchSelected();
  doSearch();
});

/** The detail pane needs the selected package's summary again once the cache was cleared. */
function refetchSelected(): void {
  if (state.selectedId) requestSummary(state.selectedId);
}

function persist(): void {
  vscode.setState({ ...vscode.getState(), source: state.source, prerelease: state.prerelease });
}

// ---------- Keyboard and splitter ----------

function moveSelection(delta: number): void {
  const rows = [...listPane.querySelectorAll<HTMLElement>('.row[data-id]')];
  if (rows.length === 0) return;
  const index = rows.findIndex(r => r.classList.contains('selected'));
  const next = rows[Math.max(0, Math.min(rows.length - 1, index < 0 ? 0 : index + delta))];
  select(next.dataset.id);
}

listPane.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveSelection(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === ' ' && state.tab === 'updates' && state.selected) {
    e.preventDefault();
    if (state.checkedUpdates.has(state.selected)) state.checkedUpdates.delete(state.selected);
    else state.checkedUpdates.add(state.selected);
    render();
  }
});

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    search.focus();
    search.select();
  }
});

splitter.addEventListener('pointerdown', e => {
  splitter.setPointerCapture(e.pointerId);
  const left = listPane.parentElement!.getBoundingClientRect().left;
  const move = (ev: PointerEvent) => {
    const width = Math.max(260, Math.min(window.innerWidth - 300, ev.clientX - left));
    app.style.setProperty('--list-width', `${width}px`);
  };
  const up = (ev: PointerEvent) => {
    splitter.removeEventListener('pointermove', move);
    splitter.removeEventListener('pointerup', up);
    const width = parseInt(app.style.getPropertyValue('--list-width'), 10);
    if (width) vscode.setState({ ...vscode.getState(), listWidth: width });
    splitter.releasePointerCapture(ev.pointerId);
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
});

// ---------- Messages ----------

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const m = event.data;
  switch (m.type) {
    case 'init':
      rules = RULES[m.ecosystem];
      // Selects the placeholder package icon of the ecosystem (manager.css).
      document.body.dataset.ecosystem = m.ecosystem;
      state.title = m.title;
      state.hasDevDependencies = m.hasDevDependencies;
      state.strings = m.strings;
      state.sources = m.sources;
      renderStatic();
      doSearch();
      render();
      return;
    case 'sources':
      state.sources = m.sources;
      renderSources();
      return;
    case 'projects':
      state.projects = m.projects;
      render();
      return;
    case 'searchResults':
      if (m.seq !== state.browse.seq) return;
      state.browse = {
        seq: m.seq,
        hits: m.append ? [...state.browse.hits, ...m.hits.filter(h => !state.browse.hits.some(x => idKey(x.id) === idKey(h.id)))] : m.hits,
        hasMore: m.hasMore,
        loading: false,
        errors: m.errors,
      };
      render();
      return;
    case 'summary':
      // Answer to a request made before the prerelease box or the source changed.
      if (m.prerelease !== state.prerelease || m.source !== state.source) return;
      state.summaries.set(idKey(m.id), { loading: false, hit: m.hit, versions: m.versions, error: m.error });
      render();
      return;
    case 'busy':
      state.busy = m.text;
      render();
      return;
  }
});

send({ type: 'ready' });
