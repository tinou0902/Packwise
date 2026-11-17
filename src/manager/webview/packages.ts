/* Pure package logic of the webview (no DOM, no global state): what the lists and the version picker show. */

import { compareVersions, isPrerelease } from '../../semver.ts';
import type { InstalledPackage, ProjectState, SearchHit, Tab, VersionDetails } from '../protocol.ts';

export interface Install {
  project: ProjectState;
  pkg: InstalledPackage;
}

/** One package line of the left list. */
export interface Row {
  id: string;
  /** Lower-cased id. */
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
export function updateTarget(p: InstalledPackage, prerelease: boolean): string | undefined {
  const best = maxVersion([p.latest, prerelease ? p.latestPrerelease : undefined]);
  return best && p.resolved && compareVersions(p.resolved, best) < 0 ? best : undefined;
}

export function maxVersion(versions: readonly (string | undefined)[]): string | undefined {
  return versions.filter((v): v is string => !!v).sort(compareVersions).at(-1);
}

/** Every word of the query is part of the id (case-insensitive). */
export function matchesQuery(id: string, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.every(w => id.toLowerCase().includes(w));
}

/** Top-level references to a package (lower-cased id) across projects. */
export function installsOf(projects: readonly ProjectState[], key: string): Install[] {
  return projects.flatMap(project =>
    project.packages.filter(p => p.isDirect && lower(p.id) === key).map(pkg => ({ project, pkg })),
  );
}

/** Direct packages across projects, keyed by lower-cased id. */
function directPackages(projects: readonly ProjectState[]): Map<string, Row> {
  const rows = new Map<string, Row>();
  for (const project of projects) {
    for (const pkg of project.packages) {
      if (!pkg.isDirect) continue;
      const key = lower(pkg.id);
      let row = rows.get(key);
      if (!row) rows.set(key, (row = { id: pkg.id, key, installs: [] }));
      row.installs.push({ project, pkg });
    }
  }
  return rows;
}

const sortById = (a: Row, b: Row) => a.id.localeCompare(b.id);

/** Rows of a tab; `transitive` is only filled for the Installed tab. */
export function rowsFor(tab: Tab, input: ListInput): { rows: Row[]; transitive: Row[] } {
  const { projects, query } = input;
  const matches = (r: { id: string }) => matchesQuery(r.id, query);
  switch (tab) {
    case 'browse':
      return {
        rows: input.hits.map(hit => ({ id: hit.id, key: lower(hit.id), hit, installs: installsOf(projects, lower(hit.id)) })),
        transitive: [],
      };
    case 'installed': {
      const direct = directPackages(projects);
      const transitive = new Map<string, Row>();
      for (const project of projects) {
        for (const pkg of project.packages) {
          const key = lower(pkg.id);
          if (pkg.isDirect || direct.has(key) || transitive.has(key) || !matches(pkg)) continue;
          transitive.set(key, { id: pkg.id, key, installs: [], transitive: true });
        }
      }
      return { rows: [...direct.values()].filter(matches).sort(sortById), transitive: [...transitive.values()].sort(sortById) };
    }
    case 'updates':
      return {
        rows: [...directPackages(projects).values()]
          .map(r => ({ ...r, target: maxVersion(r.installs.map(i => updateTarget(i.pkg, input.prerelease))) }))
          .filter(r => r.target && matches(r))
          .sort(sortById),
        transitive: [],
      };
    case 'consolidate':
      return {
        rows: [...directPackages(projects).values()]
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
export function versionChoices(versions: readonly VersionDetails[], installedVersions: readonly string[], prerelease: boolean): VersionChoice[] {
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

/** Package (or package version) page on nuget.org. */
export function nugetOrgPage(id: string, version?: string): string {
  return `https://www.nuget.org/packages/${encodeURIComponent(id)}${version ? `/${encodeURIComponent(version)}` : ''}`;
}
