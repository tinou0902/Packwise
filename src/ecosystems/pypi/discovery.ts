/* Python roots and projects on disk: uv workspaces, workspace root of a project, lock file in use. */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { workspaceMatcher } from '../../members.ts';
import { hasDependencies, type PyProject, readPyProject, workspacePatterns } from './pyproject.ts';

const toPosix = (p: string) => p.split(path.sep).join('/');
const exists = (file: string) => fs.stat(file).then(() => true, () => false);

/**
 * Keeps the roots among pyproject.toml files: uv workspace roots and projects (`[project]` or dependency groups) that
 * are not a member of one of them. Tool-only files (a `[tool.ruff]` config…) are dropped.
 */
export async function filterRoots(files: string[]): Promise<string[]> {
  const parsed = await Promise.all(files.map(f => readPyProject(f).catch(() => undefined)));
  const workspaces = files
    .map((f, i) => ({ dir: path.dirname(f), patterns: parsed[i] ? workspacePatterns(parsed[i]) : [] }))
    .filter(w => w.patterns.length > 0)
    .map(w => ({ dir: w.dir, isMember: workspaceMatcher(w.patterns) }));
  return files.filter((f, i) => {
    const p = parsed[i];
    if (!p || (!hasDependencies(p) && workspacePatterns(p).length === 0)) return false;
    const dir = path.dirname(f);
    return !workspaces.some(w => w.dir !== dir && w.isMember(toPosix(path.relative(w.dir, dir))));
  });
}

export interface WorkspaceRoot {
  dir: string;
  pyproject: PyProject;
}

/** The uv workspace a project folder belongs to (the folder itself for a workspace root), if any. */
export async function findWorkspaceRoot(dir: string): Promise<WorkspaceRoot | undefined> {
  for (let parent = dir; ; parent = path.dirname(parent)) {
    const file = path.join(parent, 'pyproject.toml');
    const pyproject = await readPyProject(file).catch(() => undefined);
    const patterns = pyproject ? workspacePatterns(pyproject) : [];
    if (pyproject && patterns.length > 0 && (parent === dir || workspaceMatcher(patterns)(toPosix(path.relative(parent, dir))))) {
      return { dir: parent, pyproject };
    }
    if (path.dirname(parent) === parent) return undefined;
  }
}

/** Lock files of package managers Packwise cannot drive. */
const FOREIGN_LOCKS: Record<string, string> = { 'poetry.lock': 'Poetry', 'pdm.lock': 'PDM', 'Pipfile.lock': 'Pipenv' };

/**
 * Package manager of a project: uv when its folder (or workspace root) has a uv.lock, or no lock at all (`uv add`
 * creates one); otherwise the one of the lock file found (Poetry, PDM…), or of `[tool.poetry]`.
 */
export async function detectPackageManager(lockDir: string, pyproject: PyProject): Promise<string> {
  if (await exists(path.join(lockDir, 'uv.lock'))) return 'uv';
  for (const [file, manager] of Object.entries(FOREIGN_LOCKS)) if (await exists(path.join(lockDir, file))) return manager;
  return pyproject.tool?.poetry !== undefined ? 'Poetry' : 'uv';
}
