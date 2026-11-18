import type { PackageRules } from '../../ecosystem.ts';
import { compareVersions, isPrerelease } from './semver.ts';

/** NuGet ids are case-insensitive; versions follow (simplified) SemVer 2.0. */
export const nugetRules: PackageRules = {
  normalizeId: id => id.toLowerCase(),
  compareVersions,
  isPrerelease,
};
