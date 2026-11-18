/* Workspace members (npm workspaces, uv workspaces): glob patterns relative to the workspace root. */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { globToRegExp } from './glob.ts';

const toPosix = (p: string) => p.split(path.sep).join('/');
const exists = (file: string) => fs.stat(file).then(() => true, () => false);

/** Tells whether a folder (relative to the workspace root, "/"-separated) is a workspace of these globs ("!" excludes). */
export function workspaceMatcher(patterns: readonly string[]): (relativeDir: string) => boolean {
  const include = patterns.filter(p => !p.startsWith('!')).map(globToRegExp);
  const exclude = patterns.filter(p => p.startsWith('!')).map(p => globToRegExp(p.slice(1)));
  return dir => dir !== '' && include.some(r => r.test(dir)) && !exclude.some(r => r.test(dir));
}

/** Folders never searched for workspace members. */
const SKIPPED = new Set(['node_modules', 'bower_components', '__pycache__', 'venv', 'site-packages']);
const MAX_DEPTH = 8;

/**
 * Folders (absolute) of the workspace members of a root that contain `manifest` (package.json, pyproject.toml), sorted
 * by path. Dot folders and dependency folders are skipped.
 */
export async function workspaceMembers(rootDir: string, patterns: readonly string[], manifest: string): Promise<string[]> {
  const isMember = workspaceMatcher(patterns);
  const depth = patterns.some(p => p.includes('**')) ? MAX_DEPTH : Math.max(0, ...patterns.map(p => p.replace(/\/+$/, '').split('/').length));
  const members: string[] = [];
  const walk = async (dir: string, level: number): Promise<void> => {
    if (level > depth) return;
    const rel = toPosix(path.relative(rootDir, dir));
    if (isMember(rel) && (await exists(path.join(dir, manifest)))) members.push(dir);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory() && !SKIPPED.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name), level + 1);
    }
  };
  await walk(rootDir, 0);
  return members.sort();
}
