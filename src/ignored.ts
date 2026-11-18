/* Files ignored by git (.gitignore, .git/info/exclude, global excludes): build outputs such as `.next/` or `dist/`. */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Repository root of a folder (the closest ancestor holding a `.git` folder or file), undefined outside a repo. */
async function repoOf(dir: string, cache: Map<string, Promise<string | undefined>>): Promise<string | undefined> {
  let found = cache.get(dir);
  if (!found) {
    found = fs.stat(path.join(dir, '.git')).then(
      () => dir,
      () => (path.dirname(dir) === dir ? undefined : repoOf(path.dirname(dir), cache)),
    );
    cache.set(dir, found);
  }
  return found;
}

/** Ignored files among `files` (absolute paths of one repository), from `git check-ignore`. */
function checkIgnore(repo: string, files: string[]): Promise<Set<string>> {
  return new Promise(resolve => {
    const child = spawn('git', ['check-ignore', '-z', '--stdin'], { cwd: repo, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    // git missing or failing: nothing is filtered (exit code 1 only means that no file is ignored).
    child.on('error', () => resolve(new Set()));
    child.on('close', code => resolve(code === 0 ? new Set(out.split('\0').filter(Boolean).map(f => path.resolve(repo, f))) : new Set()));
    child.stdin.on('error', () => {});
    child.stdin.end(files.map(f => path.relative(repo, f)).join('\0') + '\0');
  });
}

/** `files` without the ones git ignores; files outside a repository are kept, and all of them when git is missing. */
export async function withoutGitIgnored(files: readonly string[]): Promise<string[]> {
  const cache = new Map<string, Promise<string | undefined>>();
  const byRepo = new Map<string, string[]>();
  for (const file of files) {
    const repo = await repoOf(path.dirname(file), cache);
    if (repo) byRepo.set(repo, [...(byRepo.get(repo) ?? []), file]);
  }
  const ignored = new Set<string>();
  for (const [repo, list] of byRepo) for (const f of await checkIgnore(repo, list)) ignored.add(f);
  return files.filter(f => !ignored.has(path.resolve(f)));
}
