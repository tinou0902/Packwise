import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forEachLimited, PromiseCache } from '../src/cache.ts';

test('PromiseCache loads each key once', async () => {
  const cache = new PromiseCache<string, number>();
  let calls = 0;
  const load = async () => ++calls;
  assert.equal(await cache.get('a', load), 1);
  assert.equal(await cache.get('a', load), 1);
  assert.equal(await cache.get('b', load), 2);
  cache.delete('a');
  assert.equal(await cache.get('a', load), 3);
  cache.clear();
  assert.equal(await cache.get('b', load), 4);
});

test('PromiseCache evicts a rejected load so the next call retries', async () => {
  const cache = new PromiseCache<string, string>();
  await assert.rejects(cache.get('k', () => Promise.reject(new Error('offline'))), /offline/);
  assert.equal(await cache.get('k', async () => 'ok'), 'ok');
});

test('PromiseCache keeps a newer entry when an older load fails', async () => {
  const cache = new PromiseCache<string, string>();
  let fail!: (e: Error) => void;
  const old = cache.get('k', () => new Promise((_, reject) => (fail = reject)));
  cache.delete('k');
  const fresh = cache.get('k', async () => 'fresh');
  fail(new Error('stale'));
  await assert.rejects(old);
  assert.equal(await cache.get('k', async () => 'other'), await fresh);
});

test('forEachLimited visits every item with bounded concurrency', async () => {
  let running = 0;
  let peak = 0;
  const seen: number[] = [];
  await forEachLimited([1, 2, 3, 4, 5, 6, 7], 3, async n => {
    peak = Math.max(peak, ++running);
    await new Promise(r => setTimeout(r, 5));
    seen.push(n);
    running--;
  });
  assert.equal(peak, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
  await forEachLimited([], 3, async () => assert.fail('no item'));
});
