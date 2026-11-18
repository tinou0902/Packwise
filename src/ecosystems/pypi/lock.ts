/* uv.lock: resolved versions of a project's dependencies. Pure. */

import { parse } from 'smol-toml';
import type { Package, ProjectData } from '../../ecosystem.ts';
import { comparePep440, normalizeName } from './pep440.ts';
import { declaredDependencies, kindOf, type PyProject } from './pyproject.ts';

interface LockDependency {
  name: string;
  version?: string;
  extra?: string[];
}

interface LockPackage {
  name: string;
  version?: string;
  /** `{ registry = "…" }` for index packages; editable, virtual, path, git… otherwise. */
  source?: Record<string, unknown>;
  dependencies?: LockDependency[];
  'optional-dependencies'?: Record<string, LockDependency[]>;
}

export type Lock = Map<string, LockPackage[]>;

/** Lock packages by normalized name (several entries when markers split the resolution). */
export function parseLock(text: string): Lock {
  const doc = parse(text) as { package?: LockPackage[] };
  const lock: Lock = new Map();
  for (const p of doc.package ?? []) {
    if (typeof p.name !== 'string') continue;
    const key = normalizeName(p.name);
    lock.set(key, [...(lock.get(key) ?? []), p]);
  }
  return lock;
}

const fromRegistry = (p: LockPackage) => p.source !== undefined && 'registry' in p.source && typeof p.version === 'string';

/** The locked entry of a dependency: the pinned version when given, else the highest one. */
function entryOf(lock: Lock, name: string, version?: string): LockPackage | undefined {
  const entries = lock.get(normalizeName(name)) ?? [];
  return (version && entries.find(e => e.version === version)) || [...entries].sort((a, b) => comparePep440(a.version ?? '', b.version ?? '')).at(-1);
}

/**
 * Packages of a project: its declared registry dependencies (direct) and, with a lock, their resolved versions and
 * everything they pull in (transitive), extras included. Local packages (workspace members, paths, Git) are skipped.
 */
export function projectData(pyproject: PyProject, lock?: Lock): ProjectData {
  const packages = new Map<string, Package>();
  const declared = declaredDependencies(pyproject);
  for (const [key, d] of declared) {
    packages.set(key, {
      id: d.requirement.name,
      requested: d.requirement.specifier,
      resolved: '',
      latest: '',
      isDirect: true,
      kind: kindOf(d.location),
      vulnerabilities: [],
    });
  }
  if (!lock) return { groups: [], packages };

  const visited = new Set<string>();
  const visit = (entry: LockPackage | undefined, extras: readonly string[]) => {
    if (!entry || !fromRegistry(entry)) return;
    const key = normalizeName(entry.name);
    const pkg = packages.get(key);
    if (!pkg) {
      packages.set(key, { id: entry.name, requested: '', resolved: entry.version!, latest: '', isDirect: false, vulnerabilities: [] });
    } else if (!pkg.resolved || comparePep440(pkg.resolved, entry.version!) < 0) {
      pkg.resolved = entry.version!;
    }
    const deps = [...(entry.dependencies ?? []), ...extras.flatMap(x => entry['optional-dependencies']?.[x] ?? [])];
    for (const d of deps) {
      const target = entryOf(lock, d.name, d.version);
      const id = `${target?.name}@${target?.version}[${(d.extra ?? []).join(',')}]`;
      if (visited.has(id)) continue;
      visited.add(id);
      visit(target, d.extra ?? []);
    }
  };
  for (const d of declared.values()) visit(entryOf(lock, d.requirement.name), d.requirement.extras);
  return { groups: [], packages };
}
