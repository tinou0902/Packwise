/*
 * PyPI client used by the package manager panel: versions from the JSON simple API (PEP 691/700), metadata from the
 * PyPI JSON API (latest version only: older versions get the same description, and unknown dependencies). PyPI has
 * no search API: a search looks the query up as an exact package name.
 */

import { PromiseCache } from '../../cache.ts';
import type { Dependencies, PackageFeed, SearchHit, Source, VersionDetails } from '../../ecosystem.ts';
import { comparePep440, isPep440Prerelease, normalizeName, parsePep440 } from './pep440.ts';
import { isPackageName, parseRequirement } from './pyproject.ts';

export const PYPI: Source = { name: 'pypi.org', url: 'https://pypi.org/' };

const TIMEOUT_MS = 20_000;

async function getJson<T>(url: string, accept = 'application/json'): Promise<T | undefined> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept } });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url})`);
  return (await res.json()) as T;
}

export const pypiPage = (name: string, version?: string) => `https://pypi.org/project/${name}/${version ? `${version}/` : ''}`;

interface SimpleFile {
  filename: string;
  'upload-time'?: string;
  yanked?: boolean | string;
}

export interface SimpleProject {
  name: string;
  versions?: string[];
  files?: SimpleFile[];
}

const ARCHIVE = /\.(tar\.gz|tar\.bz2|tar\.xz|tgz|zip|whl|egg|exe|msi|rpm)$/i;

/** Version of a distribution file of `name` (wheel, sdist…), undefined when it cannot be told. */
export function fileVersion(filename: string, name: string): string | undefined {
  const base = filename.replace(ARCHIVE, '');
  if (/\.whl$/i.test(filename)) return base.split('-')[1];
  const key = normalizeName(name);
  for (let i = base.indexOf('-'); i > 0; i = base.indexOf('-', i + 1)) {
    if (normalizeName(base.slice(0, i)) === key) {
      const version = base.slice(i + 1).split('-')[0];
      return parsePep440(version) ? version : undefined;
    }
  }
  return undefined;
}

export interface Release {
  version: string;
  /** ISO date of the first upload ("" = unknown). */
  published: string;
  /** Not every file is yanked. */
  listed: boolean;
}

/** Releases of a simple API project with at least one file, oldest first. */
export function parseReleases(p: SimpleProject): Release[] {
  const releases = new Map<string, Release>();
  for (const f of p.files ?? []) {
    const version = fileVersion(f.filename, p.name);
    const key = version && parsePep440(version) && (p.versions?.find(v => comparePep440(v, version) === 0) ?? version);
    if (!key) continue;
    const r = releases.get(key) ?? { version: key, published: '', listed: false };
    const time = f['upload-time'] ?? '';
    if (time && (!r.published || time < r.published)) r.published = time;
    r.listed ||= !f.yanked;
    releases.set(key, r);
  }
  return [...releases.values()].sort((a, b) => comparePep440(a.version, b.version));
}

/** Highest listed release, stable unless `prerelease`. */
export function latestRelease(releases: readonly Release[], prerelease: boolean): Release | undefined {
  return releases.filter(r => r.listed && (prerelease || !isPep440Prerelease(r.version))).at(-1);
}

export interface ProjectInfo {
  name: string;
  version: string;
  summary?: string | null;
  author?: string | null;
  author_email?: string | null;
  maintainer?: string | null;
  license?: string | null;
  license_expression?: string | null;
  keywords?: string | null;
  home_page?: string | null;
  project_url?: string | null;
  project_urls?: Record<string, string> | null;
  requires_dist?: string[] | null;
}

const HOME = /^(home|homepage|home page|source|source code|repository|github|code)$/i;

const authorsOf = (i: ProjectInfo) =>
  i.author?.trim() || (i.author_email ?? '').split(',').map(a => a.replace(/\s*<[^>]*>/, '').trim()).filter(Boolean).join(', ');

/** Dependencies of `requires_dist`: the regular ones, then one group per extra. */
export function requiresDist(requires: readonly string[]): Dependencies[] {
  const groups = new Map<string, Dependencies['packages']>();
  for (const line of requires) {
    const r = parseRequirement(line);
    if (!r) continue;
    const extra = /extra\s*==\s*["']([^"']+)["']/.exec(r.marker)?.[1];
    const group = extra ? `[${extra}]` : '';
    groups.set(group, [...(groups.get(group) ?? []), { id: r.name, range: r.specifier }]);
  }
  return [...groups].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))).map(([group, packages]) => ({ group, packages }));
}

/** Details of every release; metadata of `info` (latest version), dependencies only for that version. */
export function toVersionDetails(releases: readonly Release[], info: ProjectInfo | undefined, name: string): VersionDetails[] {
  const urls = Object.entries(info?.project_urls ?? {});
  const projectUrl = info?.home_page || urls.find(([k]) => HOME.test(k))?.[1] || urls[0]?.[1] || '';
  const license = info?.license_expression || (info?.license && info.license.length <= 60 && !info.license.includes('\n') ? info.license : '');
  return releases.map(r => ({
    id: info?.name ?? name,
    version: r.version,
    listed: r.listed,
    title: '',
    description: info?.summary ?? '',
    authors: info ? authorsOf(info) : '',
    tags: (info?.keywords ?? '').split(/[,\s]+/).filter(Boolean),
    iconUrl: '',
    projectUrl,
    licenseUrl: '',
    licenseExpression: license,
    published: r.published,
    vulnerabilities: [],
    dependencies: info && comparePep440(info.version, r.version) === 0 ? requiresDist(info.requires_dist ?? []) : undefined,
    galleryUrl: pypiPage(info?.name ?? name, r.version),
  }));
}

export class PyPIClient implements PackageFeed {
  private readonly projects = new PromiseCache<string, SimpleProject | undefined>();
  private readonly infos = new PromiseCache<string, ProjectInfo | undefined>();

  readonly source = PYPI;

  /** No search API on PyPI: the query is looked up as an exact name. */
  async search(query: string, skip: number, _take: number, prerelease: boolean): Promise<{ hits: SearchHit[]; total: number }> {
    const name = query.trim();
    const hit = skip === 0 && isPackageName(name) ? await this.find(name, prerelease) : undefined;
    return hit ? { hits: [hit], total: 1 } : { hits: [], total: 0 };
  }

  async find(id: string, prerelease: boolean): Promise<SearchHit | undefined> {
    const [project, info] = await Promise.all([this.project(id), this.info(id)]);
    const best = project && latestRelease(parseReleases(project), prerelease);
    if (!best) return undefined;
    return {
      id: info?.name ?? project.name,
      version: best.version,
      title: '',
      description: info?.summary ?? '',
      authors: info ? authorsOf(info) : '',
      owners: '',
      iconUrl: '',
      verified: false,
      vulnerable: false,
      deprecated: false,
      source: this.source.name,
    };
  }

  /** Every release of a package, oldest first; undefined when PyPI does not have it. Cached. */
  async versions(id: string): Promise<VersionDetails[] | undefined> {
    const [project, info] = await Promise.all([this.project(id), this.info(id)]);
    return project && toVersionDetails(parseReleases(project), info, project.name);
  }

  /** Latest listed version (stable unless `prerelease`); undefined when unknown. */
  async latest(id: string, prerelease: boolean): Promise<string | undefined> {
    const project = await this.project(id);
    return project && latestRelease(parseReleases(project), prerelease)?.version;
  }

  private project(id: string): Promise<SimpleProject | undefined> {
    const name = normalizeName(id);
    return this.projects.get(name, () => getJson<SimpleProject>(`${PYPI.url}simple/${name}/`, 'application/vnd.pypi.simple.v1+json'));
  }

  private info(id: string): Promise<ProjectInfo | undefined> {
    const name = normalizeName(id);
    return this.infos.get(name, async () => (await getJson<{ info: ProjectInfo }>(`${PYPI.url}pypi/${name}/json`))?.info);
  }
}
