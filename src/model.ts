import { compareVersions } from './semver.ts';

export interface Vulnerability {
  severity: string;
  advisoryUrl: string;
}

export interface Package {
  id: string;
  /** Range declared in the project file ("" for transitive packages). */
  requested: string;
  /** Highest resolved version across target frameworks. */
  resolved: string;
  /** Latest stable version reported by `dotnet list --outdated` ("" = unknown or up to date). */
  latest: string;
  /** Referenced directly by the project file. */
  isDirect: boolean;
  vulnerabilities: Vulnerability[];
}

export interface ProjectData {
  frameworks: string[];
  /** Packages merged across frameworks, keyed by lower-cased id. */
  packages: Map<string, Package>;
}

export const isOutdated = (p: Package): boolean => p.latest.length > 0 && compareVersions(p.resolved, p.latest) < 0;
export const isVulnerable = (p: Package): boolean => p.vulnerabilities.length > 0;

/* Shape of `dotnet list package --format json`:
 * { projects: [{ path, frameworks: [{ framework, topLevelPackages: [...], transitivePackages: [...] }] }] } */
interface ListedPackage {
  id?: string;
  requestedVersion?: string;
  resolvedVersion?: string;
  latestVersion?: string;
  vulnerabilities?: { severity?: string; advisoryurl?: string; advisoryUrl?: string }[];
}
interface ListedFramework {
  framework?: string;
  topLevelPackages?: ListedPackage[];
  transitivePackages?: ListedPackage[];
}
interface ListOutput {
  projects?: { frameworks?: ListedFramework[] }[];
}

function frameworksOf(json: string, strict: boolean): ListedFramework[] {
  const doc = JSON.parse(json) as ListOutput;
  if (!Array.isArray(doc.projects)) {
    if (strict) throw new Error("Invalid 'dotnet list package' output: missing 'projects'.");
    return [];
  }
  return doc.projects.flatMap(p => p.frameworks ?? []);
}

function getOrAdd(data: ProjectData, id: string): Package {
  const key = id.toLowerCase();
  let pkg = data.packages.get(key);
  if (!pkg) {
    pkg = { id, requested: '', resolved: '', latest: '', isDirect: false, vulnerabilities: [] };
    data.packages.set(key, pkg);
  }
  return pkg;
}

/** Parses `dotnet list package --include-transitive --format json`. */
export function parseList(json: string): ProjectData {
  const data: ProjectData = { frameworks: [], packages: new Map() };
  for (const fw of frameworksOf(json, true)) {
    if (fw.framework && !data.frameworks.includes(fw.framework)) data.frameworks.push(fw.framework);
    for (const [list, direct] of [[fw.topLevelPackages, true], [fw.transitivePackages, false]] as const) {
      for (const p of list ?? []) {
        if (!p.id) continue;
        const pkg = getOrAdd(data, p.id);
        if (direct) {
          pkg.isDirect = true;
          if (p.requestedVersion && p.requestedVersion !== '*') pkg.requested = p.requestedVersion;
        }
        const res = p.resolvedVersion ?? '';
        if (res && (!pkg.resolved || compareVersions(pkg.resolved, res) < 0)) pkg.resolved = res;
      }
    }
  }
  return data;
}

/** Applies `dotnet list package --outdated --format json` (latestVersion on top-level packages). */
export function applyOutdated(data: ProjectData, json: string): void {
  for (const fw of frameworksOf(json, false)) {
    for (const p of fw.topLevelPackages ?? []) {
      if (!p.id || !p.latestVersion) continue;
      const pkg = data.packages.get(p.id.toLowerCase());
      if (pkg && (!pkg.latest || compareVersions(pkg.latest, p.latestVersion) < 0)) pkg.latest = p.latestVersion;
    }
  }
}

/** Applies `dotnet list package --vulnerable --include-transitive --format json`. */
export function applyVulnerable(data: ProjectData, json: string): void {
  for (const fw of frameworksOf(json, false)) {
    for (const p of [...(fw.topLevelPackages ?? []), ...(fw.transitivePackages ?? [])]) {
      if (!p.id) continue;
      const pkg = getOrAdd(data, p.id);
      for (const v of p.vulnerabilities ?? []) {
        const url = v.advisoryurl ?? v.advisoryUrl ?? '';
        if (!pkg.vulnerabilities.some(x => x.advisoryUrl === url))
          pkg.vulnerabilities.push({ severity: v.severity ?? 'Moderate', advisoryUrl: url });
      }
    }
  }
}
