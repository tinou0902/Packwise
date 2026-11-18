import type { EcosystemId, PackageRules } from '../ecosystem.ts';
import { npmRules } from './npm/rules.ts';
import { nugetRules } from './nuget/rules.ts';
import { pypiRules } from './pypi/rules.ts';

/** Identity and version rules of every ecosystem; pure, safe for the webview bundle. */
export const RULES: Record<EcosystemId, PackageRules> = {
  nuget: nugetRules,
  npm: npmRules,
  pypi: pypiRules,
};
