import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { applyOutdated, applyVulnerable, parseList, type ProjectData } from './model.ts';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the `dotnet` CLI; never rejects on a non-zero exit code. */
function run(projectFile: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'dotnet',
      args,
      {
        cwd: path.dirname(projectFile),
        maxBuffer: 64 * 1024 * 1024,
        // English output keeps the JSON keys and error messages stable.
        env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: 'en', DOTNET_NOLOGO: '1' },
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error.code === 'ENOENT' ? new Error('The dotnet CLI was not found on PATH.') : error);
          return;
        }
        resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
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

const list = (projectFile: string, ...extra: string[]) =>
  run(projectFile, ['list', projectFile, 'package', ...extra, '--format', 'json']);

export interface LoadResult {
  data: ProjectData;
  /** Set when latest versions or vulnerabilities could not be fetched (offline, unreachable feed…). */
  warnings: ('outdated' | 'vulnerable')[];
}

export async function loadProject(projectFile: string): Promise<LoadResult> {
  let r = await list(projectFile, '--include-transitive');
  if (r.code !== 0 && /assets file/i.test(r.stdout + r.stderr)) {
    // Never restored: `dotnet list package` has no assets file to read.
    ensureSuccess(await run(projectFile, ['restore', projectFile]));
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

export async function addPackage(projectFile: string, id: string, version: string): Promise<void> {
  ensureSuccess(await run(projectFile, ['add', projectFile, 'package', id, '--version', version]));
}

export async function removePackage(projectFile: string, id: string): Promise<void> {
  ensureSuccess(await run(projectFile, ['remove', projectFile, 'package', id]));
}
