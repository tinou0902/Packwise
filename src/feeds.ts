import { errorMessage } from './errors.ts';
import { FeedClient, NUGET_ORG, type PackageFeed, type SearchHit, type Source, type VersionDetails } from './nuget.ts';

export interface SearchPage {
  hits: SearchHit[];
  hasMore: boolean;
  /** One message per source that failed; the other sources' hits are still returned. */
  errors: string[];
}

export type Summary =
  | { found: true; hit?: SearchHit; versions: VersionDetails[] }
  | { found: false; error?: string };

/** Feed clients by service index URL, shared by every panel (their registration cache too). */
const sharedClients = new Map<string, FeedClient>();

export function sharedClient(source: Source): PackageFeed {
  let c = sharedClients.get(source.url);
  if (!c) sharedClients.set(source.url, (c = new FeedClient(source)));
  return c;
}

/** Drops every cached service index and registration. */
export function resetFeedCaches(): void {
  sharedClients.clear();
}

/** Queries the package sources of a solution: one source by name, or all of them merged. */
export class Feeds {
  private sources: Source[] = [NUGET_ORG];
  private readonly clientFor: (source: Source) => PackageFeed;

  constructor(clientFor: (source: Source) => PackageFeed = sharedClient) {
    this.clientFor = clientFor;
  }

  get names(): string[] {
    return this.sources.map(s => s.name);
  }

  /** Sets the configured sources; nuget.org when there is none. */
  setSources(sources: readonly Source[]): void {
    this.sources = sources.length > 0 ? [...sources] : [NUGET_ORG];
  }

  /** Clients of the named source, or of every source when the name is undefined or unknown. */
  private clients(source: string | undefined): PackageFeed[] {
    const selected = source === undefined ? this.sources : this.sources.filter(s => s.name === source);
    return (selected.length > 0 ? selected : this.sources).map(this.clientFor);
  }

  /** One page of results of every selected source, deduplicated by id (first source wins). */
  async search(query: string, prerelease: boolean, source: string | undefined, skip: number, take: number): Promise<SearchPage> {
    const results = await Promise.allSettled(this.clients(source).map(c => c.search(query, skip, take, prerelease)));
    const page: SearchPage = { hits: [], hasMore: false, errors: [] };
    const seen = new Set<string>();
    for (const r of results) {
      if (r.status === 'rejected') {
        page.errors.push(errorMessage(r.reason));
        continue;
      }
      page.hasMore ||= r.value.hits.length === take && skip + take < r.value.total;
      for (const hit of r.value.hits) {
        const key = hit.id.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        page.hits.push(hit);
      }
    }
    return page;
  }

  /** Search hit and version history of a package, from the first source (in configured order) that knows it. */
  async summary(id: string, prerelease: boolean, source: string | undefined): Promise<Summary> {
    let firstError: string | undefined;
    for (const c of this.clients(source)) {
      const [hit, versions] = await Promise.allSettled([c.find(id, prerelease), c.versions(id)]);
      if (versions.status === 'rejected') {
        firstError ??= errorMessage(versions.reason);
        continue;
      }
      if (!versions.value) continue;
      return { found: true, hit: hit.status === 'fulfilled' ? hit.value : undefined, versions: versions.value };
    }
    return { found: false, error: firstError };
  }
}
