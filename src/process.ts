import { execFile } from 'node:child_process';
import { log } from './log.ts';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  /** Logs the output even on success (commands that change something). */
  verbose?: boolean;
  /** Runs through the shell: needed on Windows for `.cmd` launchers such as npm. Arguments must be validated. */
  shell?: boolean;
}

/** Runs a CLI; rejects only when it cannot start (not found…), never on a non-zero exit code. */
export function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  log(`> ${command} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...options.env }, shell: options.shell },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error.code === 'ENOENT' ? new Error(`The ${command} CLI was not found on PATH.`) : error);
          return;
        }
        const code = typeof error?.code === 'number' ? error.code : 0;
        if (options.verbose || code !== 0) log((stdout + stderr).trimEnd());
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** First non-empty line of a CLI output, shortened. */
export function firstLine(s: string): string {
  const line = s.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? s;
  return line.length > 240 ? line.slice(0, 240) : line;
}

/** Throws the first line of the error output of a failed command. */
export function ensureSuccess(r: RunResult): void {
  if (r.code !== 0) throw new Error(firstLine(r.stderr.trim() ? r.stderr : r.stdout));
}
