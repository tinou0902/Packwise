/* package.json: dependency fields, workspaces and range prefixes. Pure, except `readManifest`. */

import * as fs from 'node:fs/promises';
import { globToRegExp } from '../../glob.ts';

export const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
export type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

/** Badge of a dependency field (none for regular dependencies). */
export const KIND: Record<DependencyField, string | undefined> = {
  dependencies: undefined,
  devDependencies: 'dev',
  optionalDependencies: 'optional',
  peerDependencies: 'peer',
};

/** `npm install` flag saving into a dependency field. */
export const SAVE_FLAG: Record<DependencyField, string> = {
  dependencies: '--save-prod',
  devDependencies: '--save-dev',
  optionalDependencies: '--save-optional',
  peerDependencies: '--save-peer',
};

export interface Manifest {
  name?: string;
  version?: string;
  /** Workspace globs (npm, Yarn) or `{ packages }` (Yarn classic). */
  workspaces?: string[] | { packages?: string[] };
  /** `"pnpm@9.1.0"` (Corepack). */
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export async function readManifest(file: string): Promise<Manifest> {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^﻿/, '')) as Manifest;
}

export function workspacePatterns(m: Manifest): string[] {
  const w = m.workspaces;
  return (Array.isArray(w) ? w : (w?.packages ?? [])).filter(p => typeof p === 'string' && p.trim());
}

/** Tells whether a folder (relative to the workspace root, "/"-separated) is a workspace of these globs. */
export function workspaceMatcher(patterns: readonly string[]): (relativeDir: string) => boolean {
  const include = patterns.filter(p => !p.startsWith('!')).map(globToRegExp);
  const exclude = patterns.filter(p => p.startsWith('!')).map(p => globToRegExp(p.slice(1)));
  return dir => dir !== '' && include.some(r => r.test(dir)) && !exclude.some(r => r.test(dir));
}

/** A range resolved from the registry (not a local path, git URL, alias or workspace protocol). */
export function isRegistryRange(range: string): boolean {
  return !/^[a-z][a-z0-9+]*:/i.test(range.trim()) && !range.includes('/');
}

export interface Declared {
  range: string;
  field: DependencyField;
}

/** Registry dependencies of a manifest; a package in several fields keeps the first of `DEPENDENCY_FIELDS`. */
export function declaredDependencies(m: Manifest): Map<string, Declared> {
  const deps = new Map<string, Declared>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(m[field] ?? {})) {
      if (typeof range === 'string' && isRegistryRange(range) && !deps.has(name)) deps.set(name, { range, field });
    }
  }
  return deps;
}

/**
 * Prefix to save an installed version with, keeping the one of the current range: "^" and "~" are kept, an exact
 * version stays exact (""). Other ranges (and new references) get npm's default "^".
 */
export function savePrefix(current: string | undefined): '^' | '~' | '' {
  const r = current?.trim() ?? '';
  if (/^[~^]\d/.test(r)) return r[0] as '^' | '~';
  if (/^=?v?\d+\.\d+\.\d+\S*$/.test(r)) return '';
  return '^';
}

/** Valid package name (validated before reaching a shell on Windows). */
export const isPackageName = (id: string) => /^(@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i.test(id) && id.length <= 214;
/** Valid exact version (validated before reaching a shell on Windows). */
export const isVersion = (version: string) => /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/.test(version);
