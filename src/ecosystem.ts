/**
 * What the package manager needs from a package ecosystem (NuGet, npm…), and the data shared by every ecosystem.
 * Type-only: the webview bundle imports it too, so it must not pull Node or VS Code modules.
 */

import type { Advisory } from './advisory.ts';

export type EcosystemId = 'nuget';

/** Package identity and version rules; pure, so the webview can use them too. */
export interface PackageRules {
  /** Key under which two spellings of the same package id are equal (lower-cased for NuGet). */
  normalizeId(id: string): string;
  /** Orders two versions (negative when `a` is older). */
  compareVersions(a: string, b: string): number;
  isPrerelease(version: string): boolean;
}

export interface Package {
  id: string;
  /** Range declared in the project file ("" for transitive packages). */
  requested: string;
  /** Highest resolved version across groups. */
  resolved: string;
  /** Latest stable version reported by the package manager ("" = unknown or up to date). */
  latest: string;
  /** Referenced directly by the project file. */
  isDirect: boolean;
  vulnerabilities: Advisory[];
}

export interface ProjectData {
  /** Groups the packages are resolved for (target frameworks for NuGet). */
  groups: string[];
  /** Packages merged across groups, keyed by normalized id. */
  packages: Map<string, Package>;
}

export interface LoadResult {
  data: ProjectData;
  /** Set when latest versions or vulnerabilities could not be fetched (offline, unreachable feed…). */
  warnings: ('outdated' | 'vulnerable')[];
}

export interface Source {
  name: string;
  /** Registry URL (the service index …/index.json for NuGet). */
  url: string;
}

export interface Deprecation {
  reasons: string[];
  message: string;
  alternateId: string;
}

export interface Dependencies {
  /** Dependency group (target framework for NuGet). */
  group: string;
  packages: { id: string; range: string }[];
}

/** Metadata of one package version. */
export interface VersionDetails {
  id: string;
  version: string;
  listed: boolean;
  title: string;
  description: string;
  authors: string;
  tags: string[];
  iconUrl: string;
  projectUrl: string;
  licenseUrl: string;
  licenseExpression: string;
  /** ISO date ("" = unknown). */
  published: string;
  vulnerabilities: Advisory[];
  deprecation?: Deprecation;
  dependencies: Dependencies[];
  /** Page of this version on the public gallery of the source (nuget.org…), when there is one. */
  galleryUrl?: string;
  /** Where to report the package to the gallery, when it accepts reports. */
  reportUrl?: string;
}

/** One search hit (latest matching version). */
export interface SearchHit {
  id: string;
  version: string;
  title: string;
  description: string;
  authors: string;
  owners: string;
  iconUrl: string;
  /** undefined = unknown. */
  totalDownloads?: number;
  verified: boolean;
  vulnerable: boolean;
  deprecated: boolean;
  source: string;
}

/** What the package manager needs from a package source (an HTTP client, or a fake in tests). */
export interface PackageFeed {
  readonly source: Source;
  search(query: string, skip: number, take: number, prerelease: boolean): Promise<{ hits: SearchHit[]; total: number }>;
  find(id: string, prerelease: boolean): Promise<SearchHit | undefined>;
  versions(id: string): Promise<VersionDetails[] | undefined>;
}

/**
 * One package ecosystem. A root (a solution for NuGet) groups projects (`.csproj`); the CLI of the ecosystem
 * reads and changes the packages of each project, and its package sources are queried over HTTP.
 */
export interface Ecosystem extends PackageRules {
  readonly id: EcosystemId;
  /** Display name ("NuGet"). */
  readonly label: string;
  /** Root files to look for in the workspace. */
  readonly rootGlob: string;
  /** Project files to watch for changes. */
  readonly projectGlob: string;
  /** Sources used when none is configured. */
  readonly defaultSources: readonly Source[];

  /** Display name of a root file. */
  rootName(rootFile: string): string;
  /** Display name of a project file. */
  projectName(projectFile: string): string;
  /** Project files of a root that exist on disk, as absolute paths in root order. */
  projectsOf(rootFile: string): Promise<string[]>;

  /** Packages of a project. */
  load(projectFile: string): Promise<LoadResult>;
  /** Latest version of each direct package including prereleases (normalized id → version). */
  loadLatestPrerelease(projectFile: string): Promise<Map<string, string>>;
  /** Adds a package reference, or changes its version when already referenced. */
  add(projectFile: string, id: string, version: string): Promise<void>;
  remove(projectFile: string, id: string): Promise<void>;

  /** Package sources configured for a root. */
  sources(rootFile: string): Promise<Source[]>;
  /** Client of a source, shared by every panel (with its caches). */
  feed(source: Source): PackageFeed;
  /** Drops every cached source client. */
  resetFeeds(): void;
}
