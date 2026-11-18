import type { EcosystemId, PackageRules } from '../ecosystem.ts';
import { nugetRules } from './nuget/rules.ts';

/** Identity and version rules of every ecosystem; pure, safe for the webview bundle. */
export const RULES: Record<EcosystemId, PackageRules> = {
  nuget: nugetRules,
};
