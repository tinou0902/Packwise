import * as path from 'node:path';
import { forEachLimited } from '../../cache.ts';
import type { AddOptions, LoadResult, Source } from '../../ecosystem.ts';
import { ensureSuccess, run as runCli, type RunResult } from '../../process.ts';
import { detectPackageManager, findWorkspaceRoot, type PackageManager } from './discovery.ts';
import {
  declaredDependencies,
  isPackageName,
  isVersion,
  type Manifest,
  readManifest,
  SAVE_FLAG,
  savePrefix,
} from './manifest.ts';
import { applyAudit, applyOutdated, declaredPackages, highestTag, parseTree } from './model.ts';
import { distTags, NPMJS, parseConfig, registryFor } from './registry.ts';

const isWindows = process.platform === 'win32';

/** Runs the npm CLI in `cwd`; never rejects on a non-zero exit code. */
function run(cwd: string, args: string[], verbose = false): Promise<RunResult> {
  // npm is a .cmd launcher on Windows, which only starts through a shell: every argument is validated beforehand.
  return runCli(isWindows ? 'npm.cmd' : 'npm', args, {
    cwd,
    verbose,
    shell: isWindows,
    env: { npm_config_update_notifier: 'false', npm_config_fund: 'false', NO_COLOR: '1' },
  });
}

/** Where and how to run npm for a project. */
interface Context {
  /** Folder npm runs in: the workspace root for a workspace member. */
  cwd: string;
  manifest: Manifest;
  /** `--workspace <folder>` for a workspace member. */
  workspaceArgs: string[];
  /** Name of the workspace member (its subtree in `npm ls`, its `dependent` in `npm outdated`). */
  member?: string;
  packageManager: PackageManager;
}

async function contextOf(projectFile: string): Promise<Context> {
  const dir = path.dirname(projectFile);
  const manifest = await readManifest(projectFile);
  const root = await findWorkspaceRoot(dir);
  const cwd = root?.dir ?? dir;
  const relative = path.relative(cwd, dir).split(path.sep).join('/');
  if (root && !/^[\w./@~-]+$/.test(relative)) throw new Error(`Unsupported workspace folder name: ${relative}`);
  return {
    cwd,
    manifest,
    workspaceArgs: root ? ['--workspace', relative] : [],
    member: root ? (manifest.name ?? path.basename(dir)) : undefined,
    packageManager: await detectPackageManager(cwd, root?.manifest ?? manifest),
  };
}

const parses = (json: string) => {
  try {
    JSON.parse(json);
    return true;
  } catch {
    return false;
  }
};

export async function loadProject(projectFile: string): Promise<LoadResult> {
  const ctx = await contextOf(projectFile);
  if (ctx.packageManager !== 'npm') return loadReadOnly(projectFile, ctx);

  // The three commands run at once: `npm outdated` and `npm audit` query the registry, the slow part of a load.
  // Exit code 1 for missing or invalid packages (`npm ls`: the tree is still printed), outdated (`npm outdated`) or
  // vulnerable ones (`npm audit`).
  const [ls, outdated, audit] = await Promise.all([
    run(ctx.cwd, ['ls', '--json', '--all', ...ctx.workspaceArgs]),
    run(ctx.cwd, ['outdated', '--json', ...ctx.workspaceArgs]),
    run(ctx.cwd, ['audit', '--json', ...ctx.workspaceArgs]),
  ]);
  if (!parses(ls.stdout)) {
    ensureSuccess(ls);
    throw new Error('Unexpected npm ls output.');
  }
  const data = parseTree(ls.stdout, ctx.manifest, ctx.member);
  const warnings: LoadResult['warnings'] = [];
  try {
    if (outdated.code > 1) throw new Error();
    applyOutdated(data, outdated.stdout, ctx.member ?? ctx.manifest.name);
  } catch {
    warnings.push('outdated');
  }
  try {
    if (audit.code > 1) throw new Error();
    applyAudit(data, audit.stdout);
  } catch {
    warnings.push('vulnerable'); // No lockfile, offline, registry without audit…
  }
  return { data, warnings };
}

/**
 * pnpm and Yarn projects: declared packages, installed versions from node_modules, latest from the registry. No
 * transitive packages nor vulnerabilities (their CLIs are not driven).
 */
async function loadReadOnly(projectFile: string, ctx: Context): Promise<LoadResult> {
  const data = declaredPackages(ctx.manifest);
  const dir = path.dirname(projectFile);
  const sources = await listSources(ctx.cwd).catch(() => [NPMJS]);
  let offline = false;
  await forEachLimited([...data.packages.values()], 8, async pkg => {
    for (const base of new Set([dir, ctx.cwd])) {
      const installed = await readManifest(path.join(base, 'node_modules', pkg.id, 'package.json')).catch(() => undefined);
      if (installed?.version) {
        pkg.resolved = installed.version;
        break;
      }
    }
    try {
      const latest = (await distTags(registryFor(pkg.id, sources), pkg.id)).latest ?? '';
      if (latest && latest !== pkg.resolved) pkg.latest = latest;
    } catch {
      offline = true;
    }
  });
  return { data, warnings: [...(offline ? (['outdated'] as const) : []), 'readOnly'] };
}

/** Highest dist-tag of each direct package, prereleases included (id → version). */
export async function loadLatestPrerelease(projectFile: string): Promise<Map<string, string>> {
  const ctx = await contextOf(projectFile);
  const sources = await listSources(ctx.cwd).catch(() => [NPMJS]);
  const latest = new Map<string, string>();
  await forEachLimited([...declaredDependencies(ctx.manifest).keys()], 8, async id => {
    const best = highestTag(await distTags(registryFor(id, sources), id));
    if (best) latest.set(id, best);
  });
  return latest;
}

function ensureWritable(ctx: Context): void {
  if (ctx.packageManager !== 'npm') {
    throw new Error(`This project is managed by ${ctx.packageManager}, which Packwise cannot drive yet: run ${ctx.packageManager} to change its packages.`);
  }
}

/** Installs or updates a package, keeping its dependency field and range prefix. */
export async function addPackage(projectFile: string, id: string, version: string, options: AddOptions = {}): Promise<void> {
  const ctx = await contextOf(projectFile);
  ensureWritable(ctx);
  const declared = declaredDependencies(ctx.manifest).get(id);
  const field = declared?.field ?? (options.dev ? 'devDependencies' : 'dependencies');
  if (!isPackageName(id) || !isVersion(version)) throw new Error(`Invalid package or version: ${id}@${version}`);
  // The exact version is installed (a range would resolve to the highest match), then saved with the kept prefix.
  const prefix = savePrefix(declared?.range);
  const save = prefix ? `--save-prefix=${prefix}` : '--save-exact';
  const args = ['install', `${id}@${version}`, SAVE_FLAG[field], save, '--no-audit', ...ctx.workspaceArgs];
  ensureSuccess(await run(ctx.cwd, args, true));
}

export async function removePackage(projectFile: string, id: string): Promise<void> {
  const ctx = await contextOf(projectFile);
  ensureWritable(ctx);
  if (!isPackageName(id)) throw new Error(`Invalid package name: ${id}`);
  ensureSuccess(await run(ctx.cwd, ['uninstall', id, '--no-audit', ...ctx.workspaceArgs], true));
}

/** Registries configured for a folder (`.npmrc` files, environment): the default one, then the scoped ones. */
export async function listSources(dir: string): Promise<Source[]> {
  const r = await run(dir, ['config', 'list', '--json']);
  ensureSuccess(r);
  return parseConfig(r.stdout);
}
