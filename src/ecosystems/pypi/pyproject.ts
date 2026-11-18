/* pyproject.toml (PEP 621 project, PEP 735 dependency groups, uv settings) and PEP 508 requirements. */

import * as fs from 'node:fs/promises';
import { parse } from 'smol-toml';
import { normalizeName, parsePep440 } from './pep440.ts';

export interface PyProject {
  project?: {
    name?: string;
    dependencies?: unknown[];
    'optional-dependencies'?: Record<string, unknown[]>;
  };
  /** PEP 735; entries are requirements or `{ include-group = "…" }` tables. */
  'dependency-groups'?: Record<string, unknown[]>;
  tool?: {
    uv?: {
      workspace?: { members?: string[]; exclude?: string[] };
      /** Legacy form of the "dev" group. */
      'dev-dependencies'?: unknown[];
    };
    poetry?: unknown;
  };
}

export function parsePyProject(text: string): PyProject {
  return parse(text) as PyProject;
}

export async function readPyProject(file: string): Promise<PyProject> {
  return parsePyProject(await fs.readFile(file, 'utf8'));
}

/** Has dependencies of its own: a PEP 621 project or dependency groups (a virtual workspace root may have only those). */
export const hasDependencies = (p: PyProject) => p.project !== undefined || p['dependency-groups'] !== undefined;

/** Member globs of a uv workspace root, "!"-prefixed for the excluded ones (none when not a workspace root). */
export function workspacePatterns(p: PyProject): string[] {
  const w = p.tool?.uv?.workspace;
  if (!w) return [];
  const strings = (a: unknown) => (Array.isArray(a) ? a.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []);
  return [...strings(w.members), ...strings(w.exclude).map(e => `!${e}`)];
}

export interface Requirement {
  /** Name as written. */
  name: string;
  extras: string[];
  /** Version specifiers ("" = any version). */
  specifier: string;
  /** Environment marker ("" = none). */
  marker: string;
}

const REQUIREMENT = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[([^\]]*)\])?\s*(\(?[^;@()]*\)?)\s*(?:;\s*(.*?))?\s*$/;

/** A PEP 508 requirement on a registry package; undefined for direct references (`name @ url`) and invalid ones. */
export function parseRequirement(s: string): Requirement | undefined {
  const m = REQUIREMENT.exec(s);
  if (!m) return undefined;
  const [, name, extras, specifier, marker] = m;
  return {
    name,
    extras: (extras ?? '').split(',').map(e => e.trim()).filter(Boolean),
    specifier: specifier.replace(/^\(|\)$/g, '').replace(/\s+/g, ''),
    marker: marker ?? '',
  };
}

/** Where a dependency is declared. */
export type Location =
  | { type: 'project' }
  | { type: 'extra'; name: string }
  | { type: 'group'; name: string };

export interface Declared {
  requirement: Requirement;
  location: Location;
}

/** Badge of a location: none for project dependencies, "[extra]" for extras, the name of a dependency group. */
export function kindOf(l: Location): string | undefined {
  return l.type === 'project' ? undefined : l.type === 'extra' ? `[${l.name}]` : l.name;
}

/** `uv add`/`uv remove` options targeting a location. */
export function locationArgs(l: Location): string[] {
  if (l.type === 'extra') return ['--optional', l.name];
  if (l.type === 'group') return l.name === 'dev' ? ['--dev'] : ['--group', l.name];
  return [];
}

/**
 * Registry dependencies of a project by normalized name; a package declared in several places keeps the first of:
 * project dependencies, extras, dependency groups (the legacy `tool.uv.dev-dependencies` being the "dev" group).
 */
export function declaredDependencies(p: PyProject): Map<string, Declared> {
  const deps = new Map<string, Declared>();
  const add = (list: unknown, location: Location) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      const requirement = typeof entry === 'string' ? parseRequirement(entry) : undefined;
      const key = requirement && normalizeName(requirement.name);
      if (requirement && key && !deps.has(key)) deps.set(key, { requirement, location });
    }
  };
  add(p.project?.dependencies, { type: 'project' });
  for (const [name, list] of Object.entries(p.project?.['optional-dependencies'] ?? {})) add(list, { type: 'extra', name });
  for (const [name, list] of Object.entries(p['dependency-groups'] ?? {})) add(list, { type: 'group', name });
  add(p.tool?.uv?.['dev-dependencies'], { type: 'group', name: 'dev' });
  return deps;
}

/**
 * Requirement to install `version` with: extras and marker kept, and the operator of a single-clause specifier
 * (`==`, `>=`, `~=`); other specifiers (and new references) get uv's default lower bound `>=`.
 */
export function requirementFor(name: string, version: string, current?: Requirement): string {
  const op = /^(==|>=|~=)[^,]+$/.exec(current?.specifier ?? '')?.[1] ?? '>=';
  const extras = current?.extras.length ? `[${current.extras.join(',')}]` : '';
  const marker = current?.marker ? `; ${current.marker}` : '';
  return `${name}${extras}${op}${version}${marker}`;
}

export const isPackageName = (name: string) => /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name);
export const isVersion = (version: string) => parsePep440(version) !== undefined;
