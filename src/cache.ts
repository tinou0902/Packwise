/** Memoizes promises by key; a rejected promise is evicted so the next call retries (network back, file fixed…). */
export class PromiseCache<K, V> {
  private readonly entries = new Map<K, Promise<V>>();

  get(key: K, load: () => Promise<V>): Promise<V> {
    let p = this.entries.get(key);
    if (!p) {
      p = load();
      this.entries.set(key, p);
      p.catch(() => {
        if (this.entries.get(key) === p) this.entries.delete(key);
      });
    }
    return p;
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Runs `fn` on every item with at most `limit` calls in flight. */
export async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}
