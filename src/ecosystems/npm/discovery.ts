/* npm roots and projects on disk: workspace members, workspace root of a project, package manager in use. */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type Manifest, readManifest, workspaceMatcher, workspacePatterns } from './manifest.ts';

/** Folders never searched for workspace members. */
const SKIPPED = new Set(['node_modules', 'bower_components']);
const MAX_DEPTH = 8;

const toPosix = (p: string) => p.split(path.sep).join('/');
const exists = (file: string) => fs.stat(file).then(() => true, () => false);

/** Folders (absolute) of the workspace members of a root, sorted by path. */
export async function workspaceMembers(rootDir: string, patterns: readonly string[]): Promise<string[]> {
  const isMember = workspaceMatcher(patterns);
  const depth = patterns.some(p => p.includes('**')) ? MAX_DEPTH : Math.max(0, ...patterns.map(p => p.replace(/\/+$/, '').split('/').length));
  const members: string[] = [];
  const walk = async (dir: string, level: number): Promise<void> => {
    if (level > depth) return;
    const rel = toPosix(path.relative(rootDir, dir));
    if (isMember(rel) && (await exists(path.join(dir, 'package.json')))) members.push(dir);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory() && !SKIPPED.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name), level + 1);
    }
  };
  await walk(rootDir, 0);
  return members.sort();
}

/** Keeps the roots among package.json files: workspace roots and packages that are not a workspace member. */
export async function filterRoots(files: string[]): Promise<string[]> {
  const manifests = await Promise.all(files.map(f => readManifest(f).catch(() => undefined)));
  const workspaceRoots = files
    .map((file, i) => ({ dir: path.dirname(file), patterns: manifests[i] ? workspacePatterns(manifests[i]) : [] }))
    .filter(r => r.patterns.length > 0)
    .map(r => ({ dir: r.dir, isMember: workspaceMatcher(r.patterns) }));
  return files.filter((file, i) => {
    if (!manifests[i]) return false;
    const dir = path.dirname(file);
    return !workspaceRoots.some(r => {
      const rel = path.relative(r.dir, dir);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && r.isMember(toPosix(rel));
    });
  });
}

export interface WorkspaceRoot {
  dir: string;
  manifest: Manifest;
}

/** The workspace root `dir` is a member of (undefined when it is not a member of any). */
export async function findWorkspaceRoot(dir: string): Promise<WorkspaceRoot | undefined> {
  for (let parent = path.dirname(dir); parent !== dir && parent !== path.dirname(parent); parent = path.dirname(parent)) {
    const manifest = await readManifest(path.join(parent, 'package.json')).catch(() => undefined);
    const patterns = manifest ? workspacePatterns(manifest) : [];
    if (manifest && patterns.length > 0) {
      return workspaceMatcher(patterns)(toPosix(path.relative(parent, dir))) ? { dir: parent, manifest } : undefined;
    }
  }
  return undefined;
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

const LOCKFILES: [string, PackageManager][] = [
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
];

/** Package manager of a project folder: `packageManager` field, then the lockfile; npm when there is neither. */
export async function detectPackageManager(dir: string, manifest: Manifest): Promise<PackageManager> {
  const declared = /^(npm|pnpm|yarn)@/.exec(manifest.packageManager ?? '')?.[1] as PackageManager | undefined;
  if (declared) return declared;
  for (const [file, pm] of LOCKFILES) if (await exists(path.join(dir, file))) return pm;
  return 'npm';
}
