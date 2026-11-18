import type { PackageRules } from '../../ecosystem.ts';
import { compareVersions, isPrerelease } from '../semver.ts';

/** npm names are case-sensitive (legacy names may have capitals); versions follow SemVer 2.0. */
export const npmRules: PackageRules = {
  normalizeId: id => id,
  compareVersions,
  isPrerelease,
};
