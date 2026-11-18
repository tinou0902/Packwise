/** Simplified semantic version, enough to compare NuGet and npm versions. */
export interface SemVersion {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release part, lower-cased ("" = stable). */
  pre: string;
}

export function parseVersion(s: string | undefined): SemVersion | undefined {
  if (!s || !s.trim()) return undefined;
  s = s.trim();
  const dash = s.indexOf('-');
  const plus = dash >= 0 ? s.indexOf('+', dash) : s.indexOf('+');
  const mainEnd = dash >= 0 ? dash : plus >= 0 ? plus : s.length;
  const pre = dash >= 0 ? (plus >= 0 ? s.slice(dash + 1, plus) : s.slice(dash + 1)) : '';

  const parts = s.slice(0, mainEnd).split('.');
  if (parts.length < 2) return undefined;
  const nums = parts.slice(0, 3).map(p => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (nums.some(Number.isNaN)) return undefined;
  return { major: nums[0], minor: nums[1], patch: nums[2] ?? 0, pre: pre.toLowerCase() };
}

export function isPrerelease(version: string): boolean {
  const v = parseVersion(version);
  return v !== undefined && v.pre.length > 0;
}

function compareParsed(a: SemVersion, b: SemVersion): number {
  const c = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (c !== 0) return Math.sign(c);
  if (!a.pre || !b.pre) return a.pre === b.pre ? 0 : a.pre ? -1 : 1;
  const x = a.pre.split(/[-.]/);
  const y = b.pre.split(/[-.]/);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const xn = /^\d+$/.test(x[i]);
    const yn = /^\d+$/.test(y[i]);
    const pc = xn && yn ? Number(x[i]) - Number(y[i]) : xn ? -1 : yn ? 1 : x[i] < y[i] ? -1 : x[i] > y[i] ? 1 : 0;
    if (pc !== 0) return Math.sign(pc);
  }
  return Math.sign(x.length - y.length);
}

/** Compares two version strings; falls back to a case-insensitive string comparison when unparsable. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa && pb) return compareParsed(pa, pb);
  return a.toLowerCase().localeCompare(b.toLowerCase());
}
