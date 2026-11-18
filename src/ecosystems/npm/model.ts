/* Parsing of the npm CLI JSON output (`ls`, `outdated`, `audit`) into the package manager model. Pure. */

import type { Advisory } from '../../advisory.ts';
import type { Package, ProjectData } from '../../ecosystem.ts';
import { compareVersions } from '../semver.ts';
import { declaredDependencies, isRegistryRange, KIND, type Manifest } from './manifest.ts';

interface LsNode {
  name?: string;
  version?: string;
  resolved?: string;
  missing?: boolean;
  dependencies?: Record<string, LsNode>;
}

const isLocal = (n: LsNode) => !!n.resolved && !/^https?:/i.test(n.resolved);

/** Direct packages declared by the manifest, unresolved. */
export function declaredPackages(manifest: Manifest): ProjectData {
  const packages = new Map<string, Package>();
  for (const [id, d] of declaredDependencies(manifest)) {
    packages.set(id, { id, requested: d.range, resolved: '', latest: '', isDirect: true, kind: KIND[d.field], vulnerabilities: [] });
  }
  return { groups: [], packages };
}

/**
 * Packages of a project from `npm ls --json --all`: the manifest's registry dependencies are direct (with their
 * declared range), the rest of the tree is transitive (highest version kept). `member`: name of the workspace
 * whose subtree to read when the tree is the workspace root's (`--workspace`). Local and linked packages are skipped.
 */
export function parseTree(json: string, manifest: Manifest, member?: string): ProjectData {
  const doc = JSON.parse(json) as LsNode;
  const node = member && doc.name !== member ? doc.dependencies?.[member] : doc;
  if (!node) throw new Error(`Workspace ${member} not found in the npm dependency tree.`);
  const data = declaredPackages(manifest);
  for (const [id, child] of Object.entries(node.dependencies ?? {})) {
    const pkg = data.packages.get(id);
    if (pkg && !child.missing && child.version) pkg.resolved = child.version;
  }
  const seen = new Set<LsNode>();
  const walk = (deps: Record<string, LsNode> | undefined) => {
    for (const [id, child] of Object.entries(deps ?? {})) {
      if (seen.has(child) || child.missing || !child.version || isLocal(child)) continue;
      seen.add(child);
      const pkg = data.packages.get(id);
      if (!pkg) {
        data.packages.set(id, { id, requested: '', resolved: child.version, latest: '', isDirect: false, vulnerabilities: [] });
      } else if (!pkg.isDirect && compareVersions(pkg.resolved, child.version) < 0) {
        pkg.resolved = child.version;
      }
      walk(child.dependencies);
    }
  };
  walk(node.dependencies);
  return data;
}

interface OutdatedEntry {
  latest?: string;
  dependent?: string;
}

/**
 * Latest versions from `npm outdated --json` (only outdated packages are listed). A package used by several
 * workspaces has one entry per workspace: `dependent` picks the project's.
 */
export function applyOutdated(data: ProjectData, json: string, dependent?: string): void {
  const doc = JSON.parse(json || '{}') as Record<string, OutdatedEntry | OutdatedEntry[]>;
  for (const [id, value] of Object.entries(doc)) {
    const entries = [value].flat();
    const entry = entries.find(e => dependent && e.dependent === dependent) ?? entries[0];
    const pkg = data.packages.get(id);
    if (pkg?.isDirect && entry?.latest && isRegistryRange(entry.latest)) pkg.latest = entry.latest;
  }
}

interface AuditVia {
  url?: string;
  severity?: string;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** Advisories from `npm audit --json` (npm 7+ format), on the packages of the project that have their own. */
export function applyAudit(data: ProjectData, json: string): void {
  const doc = JSON.parse(json) as { vulnerabilities?: Record<string, { via?: (string | AuditVia)[] }> };
  if (!doc.vulnerabilities) throw new Error('Unexpected npm audit output.');
  for (const [id, v] of Object.entries(doc.vulnerabilities)) {
    const pkg = data.packages.get(id);
    if (!pkg) continue;
    const advisories = new Map<string, Advisory>();
    // String entries name the dependency the vulnerability comes through: that package carries it.
    for (const via of v.via ?? []) {
      if (typeof via === 'object' && via.url) advisories.set(via.url, { severity: capitalize(via.severity ?? 'unknown'), advisoryUrl: via.url });
    }
    pkg.vulnerabilities = [...advisories.values()];
  }
}

/** Highest version among the dist-tags of a package (latest, next, beta…). */
export function highestTag(tags: Record<string, string>): string | undefined {
  return Object.values(tags).filter(v => typeof v === 'string').sort(compareVersions).at(-1);
}
