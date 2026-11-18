import * as path from 'node:path';
import type { LoadResult, Source } from '../../ecosystem.ts';
import { ensureSuccess, run as runCli, type RunResult } from '../../process.ts';
import { applyOutdated, applyVulnerable, latestVersions, parseList } from './model.ts';

/** Runs the `dotnet` CLI in `cwd`; never rejects on a non-zero exit code. */
function run(cwd: string, args: string[], verbose = false) {
  // English output keeps the JSON keys and error messages stable.
  return runCli('dotnet', args, { cwd, verbose, env: { DOTNET_CLI_UI_LANGUAGE: 'en', DOTNET_NOLOGO: '1' } });
}

const inProject = (projectFile: string, args: string[], verbose = false) => run(path.dirname(projectFile), args, verbose);

/**
 * `dotnet list package` without its implicit restore: `restore` runs it once for every project, which halves the
 * time of each call and spares concurrent restores of the same graph.
 */
const list = (projectFile: string, ...extra: string[]) =>
  inProject(projectFile, ['list', projectFile, 'package', ...extra, '--no-restore', '--format', 'json']);

/** Restores the projects: the solution in one go when there are several, else the project. */
export async function restore(solutionFile: string, projectFiles: string[]): Promise<void> {
  const target = projectFiles.length === 1 ? projectFiles[0] : solutionFile;
  ensureSuccess(await run(path.dirname(target), ['restore', target]));
}

const missingAssets = (r: RunResult) => r.code !== 0 && /assets file/i.test(r.stdout + r.stderr);

export async function loadProject(projectFile: string): Promise<LoadResult> {
  const load = () =>
    Promise.all([
      list(projectFile, '--include-transitive'),
      list(projectFile, '--outdated'),
      list(projectFile, '--vulnerable', '--include-transitive'),
    ]);
  let [installed, outdated, vulnerable] = await load();
  if (missingAssets(installed)) {
    // Never restored (or the restore of the solution failed): `dotnet list package` has no assets file to read.
    ensureSuccess(await inProject(projectFile, ['restore', projectFile]));
    [installed, outdated, vulnerable] = await load();
  }
  ensureSuccess(installed);
  const data = parseList(installed.stdout);
  const warnings: LoadResult['warnings'] = [];
  if (outdated.code === 0 && outdated.stdout) applyOutdated(data, outdated.stdout);
  else warnings.push('outdated');
  if (vulnerable.code === 0 && vulnerable.stdout) applyVulnerable(data, vulnerable.stdout);
  else warnings.push('vulnerable');
  return { data, warnings };
}

/** Latest version of each top-level package including prereleases (normalized id → version). */
export async function loadLatestPrerelease(projectFile: string): Promise<Map<string, string>> {
  const r = await list(projectFile, '--outdated', '--include-prerelease');
  ensureSuccess(r);
  return latestVersions(r.stdout);
}

/** Adds a package reference, or changes its version when already referenced. */
export async function addPackage(projectFile: string, id: string, version: string): Promise<void> {
  ensureSuccess(await inProject(projectFile, ['add', projectFile, 'package', id, '--version', version], true));
}

export async function removePackage(projectFile: string, id: string): Promise<void> {
  ensureSuccess(await inProject(projectFile, ['remove', projectFile, 'package', id], true));
}

/** Enabled HTTP(S) sources from the NuGet.Config files that apply to `dir` (local folder feeds are skipped). */
export async function listSources(dir: string): Promise<Source[]> {
  const r = await run(dir, ['nuget', 'list', 'source', '--format', 'Detailed']);
  ensureSuccess(r);
  return parseSources(r.stdout);
}

/* Shape of `dotnet nuget list source --format Detailed`:
 *   1.  nuget.org [Enabled]
 *       https://api.nuget.org/v3/index.json */
export function parseSources(output: string): Source[] {
  const sources: Source[] = [];
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\d+\.\s+(.+?)\s+\[(Enabled|Disabled)\]\s*$/.exec(lines[i]);
    const url = lines[i + 1]?.trim() ?? '';
    if (m && m[2] === 'Enabled' && /^https?:\/\//i.test(url)) sources.push({ name: m[1], url });
  }
  return sources;
}
