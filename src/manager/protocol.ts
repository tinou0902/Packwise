/** Messages between the package manager panel (extension host) and its webview. Type-only: shared by both bundles. */

import type { EcosystemId, Package, SearchHit, VersionDetails } from '../ecosystem.ts';

export type { Advisory } from '../advisory.ts';
export type { Deprecation, Dependencies, EcosystemId, PackageRules, SearchHit, VersionDetails } from '../ecosystem.ts';

export const ALL_SOURCES = '*';

/** A package of a project, as listed by the ecosystem's CLI. */
export interface InstalledPackage extends Package {
  /** Latest version including prereleases (only once the "include prerelease" box was ticked). */
  latestPrerelease: string;
}

export interface ProjectState {
  /** Project file URI, the project key in every message. */
  uri: string;
  name: string;
  /** Workspace-relative path of the project file. */
  path: string;
  loading: boolean;
  error: string;
  /** Data that could not be fetched (latest versions, vulnerabilities…), already localized. */
  warnings: string[];
  /** Information about the project (read-only…), already localized. */
  notice: string;
  packages: InstalledPackage[];
}

export type Tab = 'browse' | 'installed' | 'updates' | 'consolidate';

export interface InitMessage {
  type: 'init';
  /** Selects the identity and version rules of the webview. */
  ecosystem: EcosystemId;
  /** Offers to install new packages as development dependencies. */
  hasDevDependencies: boolean;
  sources: { name: string }[];
  strings: Record<string, string>;
}

export type ToWebview =
  | InitMessage
  | { type: 'projects'; projects: ProjectState[] }
  | { type: 'sources'; sources: { name: string }[] }
  | { type: 'searchResults'; seq: number; append: boolean; hits: SearchHit[]; hasMore: boolean; errors: string[] }
  /** Echoes the request's prerelease/source so the webview can drop answers to outdated requests. */
  | {
      type: 'summary';
      id: string;
      prerelease: boolean;
      source: string;
      hit?: SearchHit;
      versions?: VersionDetails[];
      error?: string;
    }
  | { type: 'busy'; text: string };

export type ToHost =
  | { type: 'ready' }
  | { type: 'search'; seq: number; query: string; prerelease: boolean; source: string; skip: number }
  /** Search hit + version history of one package (detail pane, installed rows). */
  | { type: 'summary'; id: string; prerelease: boolean; source: string }
  | { type: 'prerelease'; on: boolean }
  /** `dev`: new references go to the development dependencies (ecosystems that have them). */
  | { type: 'install'; id: string; version: string; projects: string[]; dev: boolean }
  | { type: 'uninstall'; id: string; projects: string[] }
  | { type: 'update'; updates: { id: string; version: string; projects: string[] }[] }
  | { type: 'refresh' }
  | { type: 'openUrl'; url: string };
