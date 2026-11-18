/* PEP 440 versions (epochs, a/b/rc pre-releases, post- and dev-releases, local labels) and PEP 503 names. Pure. */

export interface Pep440Version {
  epoch: number;
  release: number[];
  /** Pre-release phase (a < b < rc) and number. */
  pre?: { phase: 'a' | 'b' | 'rc'; n: number };
  post?: number;
  dev?: number;
  /** Local label, lower-cased ("" = none). */
  local: string;
}

const PATTERN =
  /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(alpha|beta|preview|pre|rc|a|b|c)[-_.]?(\d+)?)?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d+)?)?(?:[-_.]?(dev)[-_.]?(\d+)?)?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$/i;

const PHASES: Record<string, 'a' | 'b' | 'rc'> = { a: 'a', alpha: 'a', b: 'b', beta: 'b', c: 'rc', rc: 'rc', pre: 'rc', preview: 'rc' };

export function parsePep440(s: string | undefined): Pep440Version | undefined {
  const m = PATTERN.exec(s?.trim() ?? '');
  if (!m) return undefined;
  const [, epoch, release, phase, preN, postImplicit, postWord, postN, devWord, devN, local] = m;
  return {
    epoch: Number(epoch ?? 0),
    release: release.split('.').map(Number),
    pre: phase ? { phase: PHASES[phase.toLowerCase()], n: Number(preN ?? 0) } : undefined,
    post: postImplicit !== undefined ? Number(postImplicit) : postWord ? Number(postN ?? 0) : undefined,
    dev: devWord ? Number(devN ?? 0) : undefined,
    local: (local ?? '').toLowerCase().replace(/[-_]/g, '.'),
  };
}

export function isPep440Prerelease(version: string): boolean {
  const v = parsePep440(version);
  return v !== undefined && (v.pre !== undefined || v.dev !== undefined);
}

const PHASE_RANK = { a: 0, b: 1, rc: 2 } as const;

function compareRelease(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const c = (a[i] ?? 0) - (b[i] ?? 0);
    if (c !== 0) return Math.sign(c);
  }
  return 0;
}

/** Sort key of the pre-release part: dev-only releases first, then a/b/rc, then final releases. */
function preKey(v: Pep440Version): [number, number] {
  if (v.pre) return [PHASE_RANK[v.pre.phase], v.pre.n];
  if (v.dev !== undefined && v.post === undefined) return [-1, 0];
  return [3, 0];
}

function compareLocal(a: string, b: string): number {
  if (a === b) return 0;
  if (!a || !b) return a ? 1 : -1;
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const xn = /^\d+$/.test(x[i]);
    const yn = /^\d+$/.test(y[i]);
    // Numeric segments sort after alphanumeric ones.
    const c = xn && yn ? Number(x[i]) - Number(y[i]) : xn ? 1 : yn ? -1 : x[i] < y[i] ? -1 : x[i] > y[i] ? 1 : 0;
    if (c !== 0) return Math.sign(c);
  }
  return Math.sign(x.length - y.length);
}

function compareParsed(a: Pep440Version, b: Pep440Version): number {
  const [ap, an] = preKey(a);
  const [bp, bn] = preKey(b);
  return (
    Math.sign(a.epoch - b.epoch) ||
    compareRelease(a.release, b.release) ||
    Math.sign(ap - bp) ||
    Math.sign(an - bn) ||
    Math.sign((a.post ?? -1) - (b.post ?? -1)) ||
    // A dev-release sorts before the same version without it.
    Math.sign((a.dev ?? Infinity) - (b.dev ?? Infinity)) ||
    compareLocal(a.local, b.local)
  );
}

/** Orders two versions; falls back to a case-insensitive string comparison when one is not PEP 440. */
export function comparePep440(a: string, b: string): number {
  const pa = parsePep440(a);
  const pb = parsePep440(b);
  if (pa && pb) return compareParsed(pa, pb);
  return a.toLowerCase().localeCompare(b.toLowerCase());
}

/** PEP 503 normalized name: lower-cased, runs of "-", "_" and "." replaced by "-". */
export const normalizeName = (name: string) => name.trim().toLowerCase().replace(/[-_.]+/g, '-');
