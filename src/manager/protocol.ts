/** Messages between the package manager panel (extension host) and its webview. Type-only: shared by both bundles. */

import type { Package } from '../model.ts';
import type { SearchHit, VersionDetails } from '../nuget.ts';

export type { Advisory } from '../advisory.ts';
export type { Deprecation, Dependencies, SearchHit, VersionDetails } from '../nuget.ts';

export const ALL_SOURCES = '*';

/** A package of a project, as listed by the dotnet CLI. */
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
