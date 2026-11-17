/** Messages between the package manager panel (extension host) and its webview. Type-only: shared by both bundles. */

import type { SearchHit, VersionDetails } from '../nuget.ts';

export type { Advisory, Deprecation, Dependencies, SearchHit, VersionDetails } from '../nuget.ts';

export const ALL_SOURCES = '*';

export interface InstalledPackage {
  id: string;
  /** Range declared in the project file ("" for transitive packages). */
  requested: string;
  resolved: string;
  /** Latest stable version reported by dotnet ("" = unknown or up to date). */
  latest: string;
  /** Latest version including prereleases (only once the "include prerelease" box was ticked). */
  latestPrerelease: string;
  isDirect: boolean;
  vulnerabilities: { severity: string; advisoryUrl: string }[];
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
  packages: InstalledPackage[];
}

export type Tab = 'browse' | 'installed' | 'updates' | 'consolidate';

export interface InitMessage {
  type: 'init';
  /** Solution name. */
  title: string;
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
      nugetOrg?: boolean;
      error?: string;
    }
  | { type: 'busy'; text: string };

export type ToHost =
  | { type: 'ready' }
  | { type: 'search'; seq: number; query: string; prerelease: boolean; source: string; skip: number }
  /** Search hit + version history of one package (detail pane, installed rows). */
  | { type: 'summary'; id: string; prerelease: boolean; source: string }
  | { type: 'prerelease'; on: boolean }
  | { type: 'install'; id: string; version: string; projects: string[] }
  | { type: 'uninstall'; id: string; projects: string[] }
  | { type: 'update'; updates: { id: string; version: string; projects: string[] }[] }
  | { type: 'refresh' }
  | { type: 'openUrl'; url: string };
