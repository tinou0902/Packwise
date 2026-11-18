import { severityName, type Advisory } from './advisory.ts';
import { PromiseCache } from './cache.ts';
import { compareVersions } from './semver.ts';

/**
 * NuGet v3 client for any HTTP package source (service index discovery), used by the package manager panel:
 * search, version history (with listing, advisories and deprecation) and per-version metadata.
 * Authenticated feeds are not supported: their requests fail with the HTTP status.
 */

export interface Source {
  name: string;
  /** Service index URL (…/index.json). */
  url: string;
}

export const NUGET_ORG: Source = { name: 'nuget.org', url: 'https://api.nuget.org/v3/index.json' };

const TIMEOUT_MS = 20_000;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url})`);
  return JSON.parse((await res.text()).replace(/^﻿/, '')) as T;
}

export interface Deprecation {
  reasons: string[];
  message: string;
  alternateId: string;
}

export interface Dependencies {
  /** Dependency group (target framework for NuGet). */
  group: string;
  packages: { id: string; range: string }[];
}

/** Metadata of one package version. */
export interface VersionDetails {
  id: string;
  version: string;
  listed: boolean;
  title: string;
  description: string;
  authors: string;
  tags: string[];
  iconUrl: string;
  projectUrl: string;
  licenseUrl: string;
  licenseExpression: string;
  /** ISO date ("" = unknown). */
  published: string;
  vulnerabilities: Advisory[];
  deprecation?: Deprecation;
  dependencies: Dependencies[];
  /** Page of this version on the public gallery of the source (nuget.org…), when there is one. */
  galleryUrl?: string;
  /** Where to report the package to the gallery, when it accepts reports. */
  reportUrl?: string;
}

/** One search hit (latest matching version). */
export interface SearchHit {
  id: string;
  version: string;
  title: string;
  description: string;
  authors: string;
  owners: string;
  iconUrl: string;
  /** undefined = unknown. */
  totalDownloads?: number;
  verified: boolean;
  vulnerable: boolean;
  deprecated: boolean;
  source: string;
}

interface RawCatalogEntry {
  id?: string;
  version?: string;
  listed?: boolean;
  title?: string;
  description?: string;
  summary?: string;
  authors?: string | string[];
  tags?: string | string[];
  iconUrl?: string;
  projectUrl?: string;
  licenseUrl?: string;
  licenseExpression?: string;
  published?: string;
  vulnerabilities?: { advisoryUrl?: string; severity?: string | number }[];
  deprecation?: { reasons?: string[]; message?: string; alternatePackage?: { id?: string } };
  dependencyGroups?: { targetFramework?: string; dependencies?: { id?: string; range?: string }[] }[];
}

interface RawPage {
  '@id': string;
  items?: { catalogEntry?: RawCatalogEntry }[];
}

const joinList = (v: string | string[] | undefined, sep: string): string => (Array.isArray(v) ? v.join(sep) : (v ?? ''));

/** Package (or package version) page on nuget.org. */
export function nugetOrgPage(id: string, version?: string): string {
  return `https://www.nuget.org/packages/${encodeURIComponent(id)}${version ? `/${encodeURIComponent(version)}` : ''}`;
}

/** `onNuGetOrg`: the entry comes from nuget.org, which has package pages and abuse reports. */
export function toVersionDetails(e: RawCatalogEntry, fallbackId: string, onNuGetOrg = false): VersionDetails {
  const published = e.published ?? '';
  const id = e.id ?? fallbackId;
  const version = e.version ?? '';
  const page = onNuGetOrg ? nugetOrgPage(id, version) : undefined;
  return {
    id,
    version,
    // nuget.org marks unlisted versions with a 1900 publication date.
    listed: e.listed ?? !published.startsWith('1900'),
    title: e.title ?? '',
    description: e.description || e.summary || '',
    authors: joinList(e.authors, ', '),
    tags: (Array.isArray(e.tags) ? e.tags : (e.tags ?? '').split(/[\s,]+/)).filter(Boolean),
    iconUrl: e.iconUrl ?? '',
    projectUrl: e.projectUrl ?? '',
    licenseUrl: e.licenseUrl ?? '',
    licenseExpression: e.licenseExpression ?? '',
    published: published.startsWith('1900') ? '' : published,
    vulnerabilities: (e.vulnerabilities ?? []).map(v => ({ severity: severityName(v.severity), advisoryUrl: v.advisoryUrl ?? '' })),
    deprecation: e.deprecation
      ? { reasons: e.deprecation.reasons ?? [], message: e.deprecation.message ?? '', alternateId: e.deprecation.alternatePackage?.id ?? '' }
      : undefined,
    dependencies: (e.dependencyGroups ?? []).map(g => ({
      group: g.targetFramework || 'any',
      packages: (g.dependencies ?? []).filter(d => d.id).map(d => ({ id: d.id!, range: d.range ?? '' })),
    })),
    galleryUrl: page,
    reportUrl: page && `${page}/ReportAbuse`,
  };
}

/** What the package manager needs from a package source (the HTTP client below, or a fake in tests). */
export interface PackageFeed {
  readonly source: Source;
  search(query: string, skip: number, take: number, prerelease: boolean): Promise<{ hits: SearchHit[]; total: number }>;
  find(id: string, prerelease: boolean): Promise<SearchHit | undefined>;
  versions(id: string): Promise<VersionDetails[] | undefined>;
}

export class FeedClient implements PackageFeed {
  private resources?: Promise<Map<string, string>>;
  private readonly registrations = new PromiseCache<string, VersionDetails[] | undefined>();

  readonly source: Source;

  constructor(source: Source) {
    this.source = source;
  }

  /** nuget.org has package pages and abuse reports. */
  private get isNuGetOrg(): boolean {
    return /^https:\/\/api\.nuget\.org\//i.test(this.source.url);
  }

  private async resource(...types: string[]): Promise<string> {
    this.resources ??= getJson<{ resources?: { '@id'?: string; '@type'?: string | string[] }[] }>(this.source.url).then(doc => {
      const map = new Map<string, string>();
      for (const r of doc.resources ?? []) {
        for (const t of [r['@type'] ?? []].flat()) if (r['@id'] && !map.has(t)) map.set(t, r['@id']);
      }
      return map;
    });
    let map: Map<string, string>;
    try {
      map = await this.resources;
    } catch (e) {
      this.resources = undefined; // Retry next time (network back, credentials fixed…).
      throw e;
    }
    for (const t of types) {
      const url = map.get(t);
      if (url) return url;
    }
    throw new Error(`${this.source.name}: no ${types[types.length - 1]} resource.`);
  }

  async search(query: string, skip: number, take: number, prerelease: boolean): Promise<{ hits: SearchHit[]; total: number }> {
    const base = await this.resource('SearchQueryService/3.5.0', 'SearchQueryService/3.0.0-rc', 'SearchQueryService');
    const params = new URLSearchParams({ q: query, skip: String(skip), take: String(take), prerelease: String(prerelease), semVerLevel: '2.0.0' });
    const doc = await getJson<{
      totalHits?: number;
      data?: {
        id: string; version: string; title?: string; description?: string; summary?: string; authors?: string | string[];
        owners?: string | string[]; iconUrl?: string; totalDownloads?: number; verified?: boolean;
        vulnerabilities?: unknown[]; deprecation?: unknown;
      }[];
    }>(`${base}?${params}`);
    const hits = (doc.data ?? []).map(d => ({
      id: d.id,
      version: d.version,
      title: d.title ?? '',
      description: d.description || d.summary || '',
      authors: joinList(d.authors, ', '),
      owners: joinList(d.owners, ', '),
      iconUrl: d.iconUrl ?? '',
      totalDownloads: d.totalDownloads,
      verified: d.verified ?? false,
      vulnerable: (d.vulnerabilities?.length ?? 0) > 0,
      deprecated: d.deprecation !== undefined,
      source: this.source.name,
    }));
    return { hits, total: doc.totalHits ?? hits.length };
  }

  /** Exact-id lookup through search (gives downloads and owners), undefined when the source does not know it. */
  async find(id: string, prerelease: boolean): Promise<SearchHit | undefined> {
    const { hits } = await this.search(`packageid:${id}`, 0, 5, prerelease);
    return hits.find(h => h.id.toLowerCase() === id.toLowerCase());
  }

  /** Every version of a package, oldest first; undefined when the source does not have it. Cached. */
  versions(id: string): Promise<VersionDetails[] | undefined> {
    return this.registrations.get(id.toLowerCase(), () => this.loadRegistration(id));
  }

  private async loadRegistration(id: string): Promise<VersionDetails[] | undefined> {
    let base = await this.resource('RegistrationsBaseUrl/3.6.0', 'RegistrationsBaseUrl/3.4.0', 'RegistrationsBaseUrl');
    if (!base.endsWith('/')) base += '/';
    let index: { items?: RawPage[] };
    try {
      index = await getJson(`${base}${id.toLowerCase()}/index.json`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('404')) return undefined;
      throw e;
    }
    // Large registrations are split in pages that are not inlined in the index.
    const pages = await Promise.all((index.items ?? []).map(p => (p.items ? p : getJson<RawPage>(p['@id']))));
    return pages
      .flatMap(p => p.items ?? [])
      .flatMap(i => (i.catalogEntry ? [toVersionDetails(i.catalogEntry, id, this.isNuGetOrg)] : []))
      .sort((a, b) => compareVersions(a.version, b.version));
  }
}
