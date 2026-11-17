import { gunzipSync } from 'node:zlib';
import { inRange } from './semver.ts';

/**
 * nuget.org v3 HTTP API, for what the dotnet CLI does not give in one call:
 * full version history, metadata (description, authors, dependencies), downloads, per-version advisories.
 */

const TIMEOUT_MS = 20_000;

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url})`);
  return res;
}

const getJson = async <T>(url: string): Promise<T> => (await (await get(url)).json()) as T;

/** All published versions, newest first. */
export async function getVersions(id: string): Promise<string[]> {
  const doc = await getJson<{ versions?: string[] }>(
    `https://api.nuget.org/v3-flatcontainer/${id.toLowerCase()}/index.json`,
  );
  if (!Array.isArray(doc.versions)) throw new Error(`Unexpected response for ${id}.`);
  return [...doc.versions].reverse();
}

export interface PackageInfo {
  description: string;
  authors: string;
  projectUrl: string;
  licenseUrl: string;
  /** undefined = unknown. */
  downloads?: number;
  dependencies: { framework: string; packages: { id: string; range: string }[] }[];
}

interface CatalogEntry {
  description?: string;
  authors?: string | string[];
  projectUrl?: string;
  licenseUrl?: string;
  dependencyGroups?: { targetFramework?: string; dependencies?: { id?: string; range?: string }[] }[];
}

/** Metadata of one version (registration leaf, then its catalog entry). */
export async function getInfo(id: string, version: string): Promise<PackageInfo> {
  const leaf = await getJson<{ catalogEntry?: string | CatalogEntry }>(
    `https://api.nuget.org/v3/registration5-semver1/${id.toLowerCase()}/${version.toLowerCase()}.json`,
  );
  const [entry, downloads] = await Promise.all([
    typeof leaf.catalogEntry === 'string' ? getJson<CatalogEntry>(leaf.catalogEntry) : leaf.catalogEntry ?? {},
    getDownloads(id),
  ]);
  return {
    description: entry.description ?? '',
    authors: Array.isArray(entry.authors) ? entry.authors.join(', ') : entry.authors ?? '',
    projectUrl: entry.projectUrl ?? '',
    licenseUrl: entry.licenseUrl ?? '',
    downloads,
    dependencies: (entry.dependencyGroups ?? []).map(g => ({
      framework: g.targetFramework || 'any',
      packages: (g.dependencies ?? []).filter(d => d.id).map(d => ({ id: d.id!, range: d.range ?? '' })),
    })),
  };
}

async function getDownloads(id: string): Promise<number | undefined> {
  try {
    const doc = await getJson<{ data?: { totalDownloads?: number }[] }>(
      `https://azuresearch-usnc.nuget.org/query?q=packageid:${encodeURIComponent(id)}&take=1&prerelease=true`,
    );
    return doc.data?.[0]?.totalDownloads;
  } catch {
    return undefined; // The counter is a bonus.
  }
}

// ---------- Per-version advisories (nuget.org VulnerabilityInfo resource) ----------

export interface VulnerableRange {
  url: string;
  severity: string;
  range: string;
}

const SEVERITIES = ['Low', 'Moderate', 'High', 'Critical'];

let vulnDb: Promise<Map<string, VulnerableRange[]>> | undefined;

/** Advisory database (lower-cased package id → affected ranges), loaded once per session. */
export function getVulnerabilityDb(): Promise<Map<string, VulnerableRange[]>> {
  vulnDb ??= loadVulnerabilityDb().catch(e => {
    vulnDb = undefined;
    throw e;
  });
  return vulnDb;
}

export function resetVulnerabilityDb(): void {
  vulnDb = undefined;
}

// Vulnerability pages are raw gzip without a Content-Encoding header.
async function getMaybeGzipJson<T>(url: string): Promise<T> {
  let bytes: Buffer = Buffer.from(await (await get(url)).arrayBuffer());
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  return JSON.parse(bytes.toString('utf8')) as T;
}

async function loadVulnerabilityDb(): Promise<Map<string, VulnerableRange[]>> {
  const db = new Map<string, VulnerableRange[]>();
  const index = await getMaybeGzipJson<{ '@id': string }[]>('https://api.nuget.org/v3/vulnerabilities/index.json');
  const pages = await Promise.all(
    index.map(p =>
      getMaybeGzipJson<Record<string, { url?: string; severity?: number; versions?: string }[]>>(p['@id']),
    ),
  );
  for (const page of pages) {
    for (const [id, entries] of Object.entries(page)) {
      const key = id.toLowerCase();
      const list = db.get(key) ?? [];
      for (const e of entries)
        list.push({ url: e.url ?? '', severity: SEVERITIES[e.severity ?? -1] ?? 'Unknown', range: e.versions ?? '' });
      db.set(key, list);
    }
  }
  return db;
}

export function advisoriesFor(db: Map<string, VulnerableRange[]>, id: string, version: string): VulnerableRange[] {
  return (db.get(id.toLowerCase()) ?? []).filter(r => inRange(r.range, version));
}
