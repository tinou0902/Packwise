import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Feeds } from '../src/feeds.ts';
import type { PackageFeed, SearchHit, Source, VersionDetails } from '../src/nuget.ts';

const hit = (id: string, source: string): SearchHit => ({
  id, version: '1.0.0', title: id, description: '', authors: '', owners: '', iconUrl: '',
  verified: false, vulnerable: false, deprecated: false, source,
});

const details = (id: string, version: string): VersionDetails => ({
  id, version, listed: true, title: id, description: '', authors: '', tags: [], iconUrl: '', projectUrl: '',
  licenseUrl: '', licenseExpression: '', published: '', vulnerabilities: [], dependencies: [],
});

/** In-memory feed: `packages` by id, or `error` thrown by every call. */
function fakeFeed(source: Source, packages: string[], total = packages.length, error?: string): PackageFeed {
  const fail = () => Promise.reject(new Error(error));
  return {
    source,
    search: (_q, skip, take) => (error ? fail() : Promise.resolve({ hits: packages.slice(skip, skip + take).map(id => hit(id, source.name)), total })),
    find: id => (error ? fail() : Promise.resolve(packages.includes(id) ? hit(id, source.name) : undefined)),
    versions: id => (error ? fail() : Promise.resolve(packages.includes(id) ? [details(id, '1.0.0')] : undefined)),
  };
}

const A: Source = { name: 'nuget.org', url: 'https://a/index.json' };
const B: Source = { name: 'private', url: 'https://b/index.json' };
const C: Source = { name: 'broken', url: 'https://c/index.json' };

function feeds(): Feeds {
  const byUrl = new Map<string, PackageFeed>([
    [A.url, fakeFeed(A, ['Serilog', 'Newtonsoft.Json', 'Dapper'], 10)],
    [B.url, fakeFeed(B, ['serilog', 'Internal.Lib'])],
    [C.url, fakeFeed(C, [], 0, 'unreachable')],
  ]);
  const f = new Feeds(s => byUrl.get(s.url)!);
  f.setSources([A, B, C]);
  return f;
}

test('search merges every source, deduplicates ids and reports failures', async () => {
  const page = await feeds().search('', false, undefined, 0, 2);
  assert.deepEqual(page.hits.map(h => `${h.source}:${h.id}`), ['nuget.org:Serilog', 'nuget.org:Newtonsoft.Json', 'private:Internal.Lib']);
  assert.equal(page.hasMore, true); // nuget.org has 10 results.
  assert.deepEqual(page.errors, ['unreachable']);
});

test('search queries only the named source', async () => {
  const page = await feeds().search('', false, 'private', 0, 25);
  assert.deepEqual(page.hits.map(h => h.id), ['serilog', 'Internal.Lib']);
  assert.equal(page.hasMore, false);
  assert.deepEqual(page.errors, []);
});

test('summary comes from the first source that knows the package', async () => {
  const f = feeds();
  const found = await f.summary('Internal.Lib', false, undefined);
  assert.ok(found.found);
  assert.equal(found.hit?.source, 'private');
  assert.deepEqual(found.versions.map(v => v.version), ['1.0.0']);

  assert.deepEqual(await f.summary('Missing', false, undefined), { found: false, error: 'unreachable' });
  assert.deepEqual(await f.summary('Missing', false, 'private'), { found: false, error: undefined });
});

test('no configured source falls back to nuget.org', () => {
  const f = new Feeds(s => fakeFeed(s, []));
  f.setSources([]);
  assert.deepEqual(f.names, ['nuget.org']);
});
