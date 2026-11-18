import type { PackageRules } from '../../ecosystem.ts';
import { comparePep440, isPep440Prerelease, normalizeName } from './pep440.ts';

/** Python names are compared PEP 503-normalized; versions follow PEP 440. */
export const pypiRules: PackageRules = {
  normalizeId: normalizeName,
  compareVersions: comparePep440,
  isPrerelease: isPep440Prerelease,
};
