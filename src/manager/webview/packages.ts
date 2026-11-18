/* Pure package logic of the webview (no DOM, no global state): what the lists and the version picker show. */

import type { Advisory } from '../../advisory.ts';
import type { PackageRules } from '../../ecosystem.ts';
import type { InstalledPackage, ProjectState, SearchHit, Tab, VersionDetails } from '../protocol.ts';

export interface Install {
  project: ProjectState;
  pkg: InstalledPackage;
}

/** One package line of the left list. */
export interface Row {
  id: string;
  /** Normalized id. */
  key: string;
  hit?: SearchHit;
  /** Top-level references in the panel's projects. */
  installs: Install[];
  /** Version offered by the Updates tab. */
  target?: string;
  transitive?: boolean;
}

/** What the lists are built from. */
export interface ListInput {
  projects: readonly ProjectState[];
  /** Search results of the Browse tab. */
  hits: readonly SearchHit[];
  /** Filter of the other tabs. */
  query: string;
  prerelease: boolean;
  /** Keep only the packages with a known vulnerability. */
  vulnerableOnly: boolean;
  rules: PackageRules;
}

const lower = (s: string) => s.toLowerCase();

/** Version as written in the project (the requested range when there is one). */
export const installedVersion = (p: InstalledPackage) => p.requested || p.resolved;

/** "1.2M"-style download count. */
export function formatDownloads(n: number): string {
  const units: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [v, u] of units) if (n >= v) return `${(n / v).toFixed(n / v >= 100 ? 0 : 1).replace(/\.0$/, '')}${u}`;
  return String(n);
}

/** Version the package can be updated to (undefined when up to date). */
export function updateTarget(p: InstalledPackage, prerelease: boolean, rules: PackageRules): string | undefined {
  const best = maxVersion([p.latest, prerelease ? p.latestPrerelease : undefined], rules);
  return best && p.resolved && rules.compareVersions(p.resolved, best) < 0 ? best : undefined;
}

export function maxVersion(versions: readonly (string | undefined)[], rules: PackageRules): string | undefined {
  return versions.filter((v): v is string => !!v).sort(rules.compareVersions).at(-1);
}

/** Every word of the query is part of the id (case-insensitive). */
export function matchesQuery(id: string, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.every(w => id.toLowerCase().includes(w));
}

/** What the projects hold for one package (normalized id). */
interface IndexEntry {
  /** Top-level references. */
  installs: Install[];
  /** Resolved versions, direct or transitive. */
  resolved: string[];
  /** Advisories of the installed versions, without duplicates. */
  advisories: Advisory[];
}

const EMPTY: IndexEntry = { installs: [], resolved: [], advisories: [] };
const indexes = new WeakMap<PackageRules, WeakMap<readonly ProjectState[], Map<string, IndexEntry>>>();

/**
 * Packages of the projects by normalized id, built once per projects list (the webview replaces the list on every
 * update): rows look their package up instead of scanning every package of every project.
 */
function indexOf(projects: readonly ProjectState[], rules: PackageRules): Map<string, IndexEntry> {
  let byProjects = indexes.get(rules);
  if (!byProjects) indexes.set(rules, (byProjects = new WeakMap()));
  let index = byProjects.get(projects);
  if (index) return index;
  index = new Map();
  for (const project of projects) {
    for (const pkg of project.packages) {
      const key = rules.normalizeId(pkg.id);
      let entry = index.get(key);
      if (!entry) index.set(key, (entry = { installs: [], resolved: [], advisories: [] }));
      if (pkg.isDirect) entry.installs.push({ project, pkg });
      if (pkg.resolved) entry.resolved.push(pkg.resolved);
      for (const a of pkg.vulnerabilities) if (!entry.advisories.some(x => x.advisoryUrl === a.advisoryUrl)) entry.advisories.push(a);
    }
  }
  byProjects.set(projects, index);
  return index;
}

/** Top-level references to a package (normalized id) across projects. */
export function installsOf(projects: readonly ProjectState[], key: string, rules: PackageRules): Install[] {
  return (indexOf(projects, rules).get(key) ?? EMPTY).installs;
}

/** Resolved versions of a package (normalized id) across projects, direct or transitive. */
export function resolvedVersions(projects: readonly ProjectState[], key: string, rules: PackageRules): string[] {
  return (indexOf(projects, rules).get(key) ?? EMPTY).resolved;
}

/** Direct packages across projects, keyed by normalized id. */
function directPackages(projects: readonly ProjectState[], rules: PackageRules): Map<string, Row> {
  const rows = new Map<string, Row>();
  for (const project of projects) {
    for (const pkg of project.packages) {
      if (!pkg.isDirect) continue;
      const key = rules.normalizeId(pkg.id);
      let row = rows.get(key);
      if (!row) rows.set(key, (row = { id: pkg.id, key, installs: [] }));
      row.installs.push({ project, pkg });
    }
  }
  return rows;
}

const sortById = (a: Row, b: Row) => a.id.localeCompare(b.id);

/**
 * A row's package has a known vulnerability: an installed version of it (direct or transitive) in the projects, or,
 * for a search result, its latest version.
 */
export function isVulnerable(row: Row, projects: readonly ProjectState[], rules: PackageRules): boolean {
  return !!row.hit?.vulnerable || installedAdvisories(row, projects, rules).length > 0;
}

/** Advisories of the installed versions of a row's package in the projects, without duplicates. */
export function installedAdvisories(row: Row, projects: readonly ProjectState[], rules: PackageRules): Advisory[] {
  return (indexOf(projects, rules).get(row.key) ?? EMPTY).advisories;
}

/** Rows of a tab; `transitive` is only filled for the Installed tab. */
export function rowsFor(tab: Tab, input: ListInput): { rows: Row[]; transitive: Row[] } {
  const lists = unfilteredRows(tab, input);
  if (!input.vulnerableOnly) return lists;
  const keep = (r: Row) => isVulnerable(r, input.projects, input.rules);
  return { rows: lists.rows.filter(keep), transitive: lists.transitive.filter(keep) };
}

function unfilteredRows(tab: Tab, input: ListInput): { rows: Row[]; transitive: Row[] } {
  const { projects, query, rules } = input;
  const matches = (r: { id: string }) => matchesQuery(r.id, query);
  switch (tab) {
    case 'browse':
      return {
        rows: input.hits.map(hit => {
          const key = rules.normalizeId(hit.id);
          return { id: hit.id, key, hit, installs: installsOf(projects, key, rules) };
        }),
        transitive: [],
      };
    case 'installed': {
      const direct = directPackages(projects, rules);
      const transitive = new Map<string, Row>();
      for (const project of projects) {
        for (const pkg of project.packages) {
          const key = rules.normalizeId(pkg.id);
          if (pkg.isDirect || direct.has(key) || transitive.has(key) || !matches(pkg)) continue;
          transitive.set(key, { id: pkg.id, key, installs: [], transitive: true });
        }
      }
      return { rows: [...direct.values()].filter(matches).sort(sortById), transitive: [...transitive.values()].sort(sortById) };
    }
    case 'updates':
      return {
        rows: [...directPackages(projects, rules).values()]
          .map(r => ({ ...r, target: maxVersion(r.installs.map(i => updateTarget(i.pkg, input.prerelease, rules)), rules) }))
          .filter(r => r.target && matches(r))
          .sort(sortById),
        transitive: [],
      };
    case 'consolidate':
      return {
        rows: [...directPackages(projects, rules).values()]
          .filter(r => new Set(r.installs.map(i => lower(i.pkg.resolved))).size > 1 && matches(r))
          .sort(sortById),
        transitive: [],
      };
  }
}

export type VersionFlag = 'vulnerable' | 'deprecated' | 'unlisted';

/** One entry of the version picker; the caller turns `kind` and `flags` into a localized label. */
export type VersionChoice =
  | { kind: 'latestStable' | 'latestPrerelease'; value: string }
  | { kind: 'version'; value: string; flags: VersionFlag[] };

/**
 * Versions offered by the picker, newest first, after the "latest stable" and "latest prerelease" shortcuts.
 * Hidden: unlisted versions and, unless allowed, prereleases (installed versions are always kept).
 */
export function versionChoices(
  versions: readonly VersionDetails[],
  installedVersions: readonly string[],
  prerelease: boolean,
  { compareVersions, isPrerelease }: PackageRules,
): VersionChoice[] {
  const installed = new Set(installedVersions.map(lower));
  const keep = versions
    .filter(v => installed.has(lower(v.version)) || (v.listed && (prerelease || !isPrerelease(v.version))))
    .reverse();
  const choices: VersionChoice[] = [];
  const stable = keep.find(v => !isPrerelease(v.version));
  const pre = keep.find(v => isPrerelease(v.version));
  if (stable) choices.push({ kind: 'latestStable', value: stable.version });
  if (prerelease && pre && (!stable || compareVersions(pre.version, stable.version) > 0))
    choices.push({ kind: 'latestPrerelease', value: pre.version });
  for (const v of keep) {
    const flags: VersionFlag[] = [];
    if (v.vulnerabilities.length > 0) flags.push('vulnerable');
    if (v.deprecation) flags.push('deprecated');
    if (!v.listed) flags.push('unlisted');
    choices.push({ kind: 'version', value: v.version, flags });
  }
  return choices;
}

/** Name of a gallery shown on its links: the host of the page URL without "www.". */
export function galleryName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
