import type { Package, ProjectData } from '../../ecosystem.ts';
import { nugetRules } from './rules.ts';
import { compareVersions } from './semver.ts';

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

/** Frameworks of every project of the output; undefined when the output has no project list. */
function frameworksOf(json: string): ListedFramework[] | undefined {
  const doc = JSON.parse(json) as ListOutput;
  return Array.isArray(doc.projects) ? doc.projects.flatMap(p => p.frameworks ?? []) : undefined;
}

function getOrAdd(data: ProjectData, id: string): Package {
  const key = nugetRules.normalizeId(id);
  let pkg = data.packages.get(key);
  if (!pkg) {
    pkg = { id, requested: '', resolved: '', latest: '', isDirect: false, vulnerabilities: [] };
    data.packages.set(key, pkg);
  }
  return pkg;
}

/** Parses `dotnet list package --include-transitive --format json`. */
export function parseList(json: string): ProjectData {
  const data: ProjectData = { groups: [], packages: new Map() };
  const frameworks = frameworksOf(json);
  if (!frameworks) throw new Error("Invalid 'dotnet list package' output: missing 'projects'.");
  for (const fw of frameworks) {
    if (fw.framework && !data.groups.includes(fw.framework)) data.groups.push(fw.framework);
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
  for (const [key, version] of latestVersions(json)) {
    const pkg = data.packages.get(key);
    if (pkg) pkg.latest = version;
  }
}

/** Latest versions reported by `dotnet list package --outdated --format json` (normalized id → highest latest). */
export function latestVersions(json: string): Map<string, string> {
  const latest = new Map<string, string>();
  for (const fw of frameworksOf(json) ?? []) {
    for (const p of fw.topLevelPackages ?? []) {
      if (!p.id || !p.latestVersion) continue;
      const key = nugetRules.normalizeId(p.id);
      const current = latest.get(key);
      if (!current || compareVersions(current, p.latestVersion) < 0) latest.set(key, p.latestVersion);
    }
  }
  return latest;
}

/** Applies `dotnet list package --vulnerable --include-transitive --format json`. */
export function applyVulnerable(data: ProjectData, json: string): void {
  for (const fw of frameworksOf(json) ?? []) {
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
