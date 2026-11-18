import { PromiseCache } from '../../cache.ts';
import type { Dependencies, PackageFeed, SearchHit, Source, VersionDetails } from '../../ecosystem.ts';
import { compareVersions } from '../semver.ts';

/**
 * npm registry client used by the package manager panel: search (`/-/v1/search`), version history and metadata
 * (packument), dist-tags. Authenticated registries are not supported: their requests fail with the HTTP status.
 */

export const NPMJS: Source = { name: 'npmjs.com', url: 'https://registry.npmjs.org/' };

const TIMEOUT_MS = 20_000;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url})`);
  return (await res.json()) as T;
}

const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);
const isNpmjs = (registry: string) => /^https:\/\/registry\.(npmjs\.org|yarnpkg\.com)\/?$/i.test(registry);

/** URL path of a package name ("@scope/name" keeps its "@" and escapes the "/"). */
export const encodeName = (name: string) => encodeURIComponent(name).replace(/^%40/, '@');

/** Package (or package version) page on npmjs.com. */
export function npmjsPage(name: string, version?: string): string {
  return `https://www.npmjs.com/package/${name}${version ? `/v/${encodeURIComponent(version)}` : ''}`;
}

/** Registries from `npm config list --json`: the default one, then the scoped ones (`@scope:registry`). */
export function parseConfig(json: string): Source[] {
  const config = JSON.parse(json) as Record<string, unknown>;
  const sources: Source[] = [];
  const add = (name: string, url: unknown) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    const u = withSlash(url);
    if (!sources.some(s => s.url === u)) sources.push({ name, url: u });
  };
  const registry = typeof config.registry === 'string' ? config.registry : NPMJS.url;
  add(isNpmjs(registry) ? NPMJS.name : new URL(registry).host, registry);
  for (const [key, url] of Object.entries(config)) {
    const scope = /^(@[^:]+):registry$/.exec(key)?.[1];
    if (scope && typeof url === 'string' && /^https?:\/\//i.test(url)) add(`${scope} (${new URL(url).host})`, url);
  }
  return sources;
}

/** Registry of a package: the one of its scope, else the default one (the first source). */
export function registryFor(name: string, sources: readonly Source[]): string {
  const scope = /^(@[^/]+)\//.exec(name)?.[1];
  return (scope && sources.find(s => s.name.startsWith(`${scope} `))?.url) || (sources[0] ?? NPMJS).url;
}

export async function distTags(registry: string, name: string): Promise<Record<string, string>> {
  return getJson(`${withSlash(registry)}-/package/${encodeName(name)}/dist-tags`);
}

type Person = string | { name?: string; username?: string };
const personName = (p: Person | undefined) => (typeof p === 'string' ? p.replace(/\s*[<(].*$/, '') : (p?.name ?? p?.username ?? ''));

interface RawVersion {
  name?: string;
  version?: string;
  description?: string;
  author?: Person;
  license?: string | { type?: string };
  homepage?: string;
  repository?: string | { url?: string };
  keywords?: string[];
  deprecated?: string | boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface Packument {
  name: string;
  description?: string;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, RawVersion>;
  time?: Record<string, string>;
  maintainers?: Person[];
}

const DEPENDENCY_GROUPS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

function repositoryUrl(r: RawVersion['repository']): string {
  const url = typeof r === 'string' ? r : (r?.url ?? '');
  return url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '');
}

/** `onNpmjs`: the packument comes from the public registry, which has package pages. */
export function toVersionDetails(p: Packument, v: RawVersion, onNpmjs: boolean): VersionDetails {
  const version = v.version ?? '';
  const license = typeof v.license === 'string' ? v.license : (v.license?.type ?? '');
  const dependencies: Dependencies[] = DEPENDENCY_GROUPS.filter(g => v[g] && Object.keys(v[g]!).length > 0).map(g => ({
    group: g,
    packages: Object.entries(v[g]!).map(([id, range]) => ({ id, range })),
  }));
  return {
    id: p.name,
    version,
    listed: true,
    title: '',
    description: v.description ?? p.description ?? '',
    authors: personName(v.author),
    tags: Array.isArray(v.keywords) ? v.keywords.filter(k => typeof k === 'string') : [],
    iconUrl: '',
    projectUrl: v.homepage || repositoryUrl(v.repository),
    licenseUrl: '',
    licenseExpression: license,
    published: p.time?.[version] ?? '',
    vulnerabilities: [],
    deprecation: v.deprecated
      ? { reasons: [], message: typeof v.deprecated === 'string' ? v.deprecated : '', alternateId: '' }
      : undefined,
    dependencies,
    galleryUrl: onNpmjs ? npmjsPage(p.name, version) : undefined,
  };
}

/** Every version of a packument, oldest first. */
export function packumentVersions(p: Packument, onNpmjs: boolean): VersionDetails[] {
  return Object.values(p.versions ?? {})
    .filter(v => v.version)
    .map(v => toVersionDetails(p, v, onNpmjs))
    .sort((a, b) => compareVersions(a.version, b.version));
}

interface RawSearch {
  total?: number;
  objects?: {
    package: { name: string; version: string; description?: string; author?: Person; publisher?: Person; maintainers?: Person[] };
    flags?: { insecure?: number | boolean };
  }[];
}

export function parseSearch(doc: RawSearch, source: string): { hits: SearchHit[]; total: number } {
  const hits = (doc.objects ?? []).map(({ package: p, flags }) => ({
    id: p.name,
    version: p.version,
    title: '',
    description: p.description ?? '',
    authors: personName(p.author) || personName(p.publisher),
    owners: (p.maintainers ?? []).map(personName).filter(Boolean).join(', '),
    iconUrl: '',
    verified: false,
    vulnerable: !!flags?.insecure,
    deprecated: false,
    source,
  }));
  return { hits, total: doc.total ?? hits.length };
}

export class RegistryClient implements PackageFeed {
  private readonly packuments = new PromiseCache<string, Packument | undefined>();

  readonly source: Source;

  constructor(source: Source) {
    this.source = { ...source, url: withSlash(source.url) };
  }

  private get onNpmjs(): boolean {
    return isNpmjs(this.source.url);
  }

  async search(query: string, skip: number, take: number): Promise<{ hits: SearchHit[]; total: number }> {
    // The search API rejects an empty text (400) and has no listing of popular packages, unlike NuGet.
    if (!query.trim()) return { hits: [], total: 0 };
    const params = new URLSearchParams({ text: query, from: String(skip), size: String(take) });
    return parseSearch(await getJson<RawSearch>(`${this.source.url}-/v1/search?${params}`), this.source.name);
  }

  /** Latest version of a package as a search hit (from its packument), undefined when the registry lacks it. */
  async find(id: string, prerelease: boolean): Promise<SearchHit | undefined> {
    const p = await this.packument(id);
    if (!p) return undefined;
    const versions = packumentVersions(p, this.onNpmjs);
    const latest = p['dist-tags']?.latest;
    const best = prerelease ? versions.at(-1) : (versions.find(v => v.version === latest) ?? versions.at(-1));
    if (!best) return undefined;
    return {
      id: p.name,
      version: best.version,
      title: '',
      description: best.description,
      authors: best.authors,
      owners: (p.maintainers ?? []).map(personName).filter(Boolean).join(', '),
      iconUrl: '',
      verified: false,
      vulnerable: false,
      deprecated: best.deprecation !== undefined,
      source: this.source.name,
    };
  }

  /** Every version of a package, oldest first; undefined when the registry does not have it. Cached. */
  async versions(id: string): Promise<VersionDetails[] | undefined> {
    const p = await this.packument(id);
    return p && packumentVersions(p, this.onNpmjs);
  }

  private packument(id: string): Promise<Packument | undefined> {
    return this.packuments.get(id, async () => {
      try {
        return await getJson<Packument>(`${this.source.url}${encodeName(id)}`);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('404')) return undefined;
        throw e;
      }
    });
  }
}
