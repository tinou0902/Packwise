/* Known vulnerabilities of PyPI package versions, from OSV.dev (the database behind pip-audit and PyPI advisories). */

import type { Advisory } from '../../advisory.ts';
import { forEachLimited, PromiseCache } from '../../cache.ts';
import { normalizeName } from './pep440.ts';

const API = 'https://api.osv.dev/v1/';
const TIMEOUT_MS = 30_000;
/** Queries per querybatch request (the API accepts up to 1000). */
const BATCH = 500;

async function osv<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (OSV ${path})`);
  return (await res.json()) as T;
}

export interface Vulnerability {
  id: string;
  aliases?: string[];
  withdrawn?: string;
  database_specific?: { severity?: string };
}

const SEVERITY: Record<string, string> = { LOW: 'Low', MODERATE: 'Moderate', MEDIUM: 'Moderate', HIGH: 'High', CRITICAL: 'Critical' };

/**
 * Advisories of a package version: withdrawn entries dropped, and an entry without severity (PYSEC) dropped when one
 * of its aliases (the GitHub advisory) is reported with one.
 */
export function toAdvisories(vulns: readonly Vulnerability[]): Advisory[] {
  const live = vulns.filter(v => !v.withdrawn);
  const severityOf = (v: Vulnerability) => SEVERITY[(v.database_specific?.severity ?? '').toUpperCase()];
  const rated = new Set(live.filter(severityOf).map(v => v.id));
  return live
    .filter(v => severityOf(v) || !(v.aliases ?? []).some(a => rated.has(a)))
    .map(v => ({ severity: severityOf(v) ?? 'Unknown', advisoryUrl: `https://osv.dev/vulnerability/${v.id}` }));
}

const details = new PromiseCache<string, Vulnerability>();

/** Advisories of each package version (key: `normalized name@version`); versions without any are left out. */
export async function audit(packages: readonly { id: string; version: string }[]): Promise<Map<string, Advisory[]>> {
  const ids = new Map<string, string[]>();
  for (let i = 0; i < packages.length; i += BATCH) {
    const chunk = packages.slice(i, i + BATCH);
    const queries = chunk.map(p => ({ package: { name: normalizeName(p.id), ecosystem: 'PyPI' }, version: p.version }));
    const { results } = await osv<{ results: { vulns?: { id: string }[] }[] }>('querybatch', { queries });
    chunk.forEach((p, j) => {
      const found = results[j]?.vulns?.map(v => v.id) ?? [];
      if (found.length) ids.set(`${normalizeName(p.id)}@${p.version}`, found);
    });
  }
  const unique = [...new Set([...ids.values()].flat())];
  await forEachLimited(unique, 8, async id => void (await details.get(id, () => osv<Vulnerability>(`vulns/${encodeURIComponent(id)}`))));
  const result = new Map<string, Advisory[]>();
  for (const [key, found] of ids) {
    const advisories = toAdvisories(await Promise.all(found.map(id => details.get(id, () => osv(`vulns/${encodeURIComponent(id)}`)))));
    if (advisories.length) result.set(key, advisories);
  }
  return result;
}

/** Drops the cached vulnerability details. */
export const resetAudit = () => details.clear();
