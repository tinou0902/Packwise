import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { forEachLimited } from '../../cache.ts';
import type { AddOptions, LoadResult } from '../../ecosystem.ts';
import { ensureSuccess, run } from '../../process.ts';
import { detectPackageManager, findWorkspaceRoot } from './discovery.ts';
import { type Lock, parseLock, projectData } from './lock.ts';
import { audit } from './osv.ts';
import { normalizeName } from './pep440.ts';
import {
  declaredDependencies,
  isPackageName,
  isVersion,
  locationArgs,
  type Location,
  type PyProject,
  readPyProject,
  requirementFor,
} from './pyproject.ts';
import { PyPIClient } from './registry.ts';

/** PyPI client shared by every panel (with its caches). */
export const pypiClient = new PyPIClient();

/** Where and how a project is managed. */
interface Context {
  dir: string;
  pyproject: PyProject;
  /** Folder of the lock file: the workspace root for a uv workspace member. */
  lockDir: string;
  packageManager: string;
}

async function contextOf(projectFile: string): Promise<Context> {
  const dir = path.dirname(projectFile);
  const pyproject = await readPyProject(projectFile);
  const lockDir = (await findWorkspaceRoot(dir))?.dir ?? dir;
  return { dir, pyproject, lockDir, packageManager: await detectPackageManager(lockDir, pyproject) };
}

async function readLock(dir: string): Promise<Lock | undefined> {
  const text = await fs.readFile(path.join(dir, 'uv.lock'), 'utf8').catch(() => undefined);
  return text === undefined ? undefined : parseLock(text);
}

/**
 * Declared packages of a project with their locked versions (from uv.lock, transitive ones included), latest versions
 * from PyPI and vulnerabilities from OSV. Without uv.lock, only the declared packages (unresolved).
 */
export async function loadProject(projectFile: string): Promise<LoadResult> {
  const ctx = await contextOf(projectFile);
  const lock = ctx.packageManager === 'uv' ? await readLock(ctx.lockDir) : undefined;
  const data = projectData(ctx.pyproject, lock);
  const packages = [...data.packages.values()];
  const warnings: LoadResult['warnings'] = [];

  let offline = false;
  await forEachLimited(packages.filter(p => p.isDirect), 8, async pkg => {
    try {
      const latest = await pypiClient.latest(pkg.id, false);
      if (latest && latest !== pkg.resolved) pkg.latest = latest;
    } catch {
      offline = true;
    }
  });
  if (offline) warnings.push('outdated');

  try {
    const locked = packages.filter(p => p.resolved).map(p => ({ id: p.id, version: p.resolved }));
    const advisories = await audit(locked);
    for (const p of packages) p.vulnerabilities = advisories.get(`${normalizeName(p.id)}@${p.resolved}`) ?? [];
  } catch {
    warnings.push('vulnerable');
  }
  if (ctx.packageManager !== 'uv') warnings.push('readOnly');
  return { data, warnings };
}

/** Latest version of each direct package, prereleases included (normalized name → version). */
export async function loadLatestPrerelease(projectFile: string): Promise<Map<string, string>> {
  const declared = declaredDependencies(await readPyProject(projectFile));
  const latest = new Map<string, string>();
  await forEachLimited([...declared], 8, async ([key, d]) => {
    const best = await pypiClient.latest(d.requirement.name, true);
    if (best) latest.set(key, best);
  });
  return latest;
}

/** Runs uv in a project folder (it finds the workspace itself); throws its first error line on failure. */
async function uv(dir: string, args: string[]): Promise<void> {
  ensureSuccess(await run('uv', args, { cwd: dir, verbose: true, env: { NO_COLOR: '1', UV_NO_PROGRESS: '1' } }));
}

function ensureWritable(ctx: Context): void {
  if (ctx.packageManager !== 'uv') {
    throw new Error(`This project is managed by ${ctx.packageManager}, which Packwise cannot drive yet: use it to change its packages.`);
  }
}

/**
 * Adds a package or changes its version with `uv add` (which updates uv.lock and the environment), keeping where it
 * is declared, its extras, marker and operator.
 */
export async function addPackage(projectFile: string, id: string, version: string, options: AddOptions = {}): Promise<void> {
  const ctx = await contextOf(projectFile);
  ensureWritable(ctx);
  if (!isPackageName(id) || !isVersion(version)) throw new Error(`Invalid package or version: ${id} ${version}`);
  const declared = declaredDependencies(ctx.pyproject).get(normalizeName(id));
  const location: Location = declared?.location ?? (options.dev ? { type: 'group', name: 'dev' } : { type: 'project' });
  await uv(ctx.dir, ['add', requirementFor(declared?.requirement.name ?? id, version, declared?.requirement), ...locationArgs(location)]);
}

export async function removePackage(projectFile: string, id: string): Promise<void> {
  const ctx = await contextOf(projectFile);
  ensureWritable(ctx);
  if (!isPackageName(id)) throw new Error(`Invalid package name: ${id}`);
  const declared = declaredDependencies(ctx.pyproject).get(normalizeName(id));
  await uv(ctx.dir, ['remove', declared?.requirement.name ?? id, ...locationArgs(declared?.location ?? { type: 'project' })]);
}
