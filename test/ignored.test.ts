import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { withoutGitIgnored } from '../src/ignored.ts';

test('git-ignored files are dropped, files outside a repository are kept', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'packwise-ignored-'));
  try {
    const write = async (rel: string, content = '{}') => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), content);
    };
    // A plain folder holding a repository, as when a workspace folder groups several repos.
    execFileSync('git', ['init', '-q', path.join(dir, 'repo')]);
    await write('repo/.gitignore', '.next/\n');
    await write('repo/package.json');
    await write('repo/.next/standalone/package.json');
    await write('repo/apps/web/package.json');
    await write('loose/package.json');
    const file = (rel: string) => path.join(dir, rel);
    const files = ['repo/package.json', 'repo/.next/standalone/package.json', 'repo/apps/web/package.json', 'loose/package.json'].map(file);
    assert.deepEqual(await withoutGitIgnored(files), [file('repo/package.json'), file('repo/apps/web/package.json'), file('loose/package.json')]);
    assert.deepEqual(await withoutGitIgnored([]), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
