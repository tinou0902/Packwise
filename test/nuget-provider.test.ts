import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { nuget } from '../src/ecosystems/index.ts';

test('nuget provider names roots and projects', () => {
  assert.equal(nuget.rootName('/w/App.slnx'), 'App');
  assert.equal(nuget.rootName('/w/App.Sln'), 'App');
  assert.equal(nuget.projectName('/w/src/Api/Api.csproj'), 'Api');
  assert.equal(nuget.normalizeId('Serilog'), nuget.normalizeId('SERILOG'));
});

test('nuget provider lists the projects of a solution that exist on disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'packwise-'));
  try {
    await fs.mkdir(path.join(dir, 'Api'));
    await fs.writeFile(path.join(dir, 'Api', 'Api.csproj'), '<Project />');
    const sln = path.join(dir, 'App.slnx');
    await fs.writeFile(sln, '<Solution><Project Path="Api/Api.csproj" /><Project Path="Gone/Gone.csproj" /></Solution>');
    assert.deepEqual(await nuget.projectsOf(sln), [path.join(dir, 'Api', 'Api.csproj')]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
