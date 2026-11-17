import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { applyOutdated, applyVulnerable, latestVersions, parseList, type ProjectData } from './model.ts';
import type { Source } from './nuget.ts';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let logger: ((line: string) => void) | undefined;

/** Receives every command line and the output of commands that change something (add/remove). */
export function setLogger(fn: (line: string) => void): void {
  logger = fn;
}

/** Runs the `dotnet` CLI in `cwd`; never rejects on a non-zero exit code. */
function run(cwd: string, args: string[], verbose = false): Promise<RunResult> {
  logger?.(`> dotnet ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    execFile(
      'dotnet',
      args,
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        // English output keeps the JSON keys and error messages stable.
        env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: 'en', DOTNET_NOLOGO: '1' },
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error.code === 'ENOENT' ? new Error('The dotnet CLI was not found on PATH.') : error);
          return;
        }
        const code = typeof error?.code === 'number' ? error.code : 0;
        if (verbose || code !== 0) logger?.((stdout + stderr).trimEnd());
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function firstLine(s: string): string {
  const line = s.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? s;
  return line.length > 240 ? line.slice(0, 240) : line;
}

function ensureSuccess(r: RunResult): void {
  if (r.code !== 0) throw new Error(firstLine(r.stderr.trim() ? r.stderr : r.stdout));
}

const inProject = (projectFile: string, args: string[], verbose = false) => run(path.dirname(projectFile), args, verbose);

const list = (projectFile: string, ...extra: string[]) =>
  inProject(projectFile, ['list', projectFile, 'package', ...extra, '--format', 'json']);

export interface LoadResult {
  data: ProjectData;
  /** Set when latest versions or vulnerabilities could not be fetched (offline, unreachable feed…). */
  warnings: ('outdated' | 'vulnerable')[];
}

export async function loadProject(projectFile: string): Promise<LoadResult> {
  let r = await list(projectFile, '--include-transitive');
  if (r.code !== 0 && /assets file/i.test(r.stdout + r.stderr)) {
    // Never restored: `dotnet list package` has no assets file to read.
    ensureSuccess(await inProject(projectFile, ['restore', projectFile]));
    r = await list(projectFile, '--include-transitive');
  }
  ensureSuccess(r);
  const data = parseList(r.stdout);

  const [outdated, vulnerable] = await Promise.all([
    list(projectFile, '--outdated'),
    list(projectFile, '--vulnerable', '--include-transitive'),
  ]);
  const warnings: LoadResult['warnings'] = [];
  if (outdated.code === 0 && outdated.stdout) applyOutdated(data, outdated.stdout);
  else warnings.push('outdated');
  if (vulnerable.code === 0 && vulnerable.stdout) applyVulnerable(data, vulnerable.stdout);
  else warnings.push('vulnerable');
  return { data, warnings };
}

/** Latest version of each top-level package including prereleases (lower-cased id → version). */
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
