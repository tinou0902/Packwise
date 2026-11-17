import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseSolution } from '../src/solution.ts';

const root = path.resolve('/repo');

test('parseSolution reads .sln project lines and skips folders and other project types', () => {
  const sln = [
    '﻿',
    'Microsoft Visual Studio Solution File, Format Version 12.00',
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "src\\App\\App.csproj", "{11111111-1111-1111-1111-111111111111}"',
    'EndProject',
    'Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "src", "src", "{22222222-2222-2222-2222-222222222222}"',
    'EndProject',
    'Project("{F2A71F9B-5D33-465A-A702-920D77279786}") = "Lib.FSharp", "lib\\Lib.fsproj", "{33333333-3333-3333-3333-333333333333}"',
    'EndProject',
    'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Tests", "..\\tests\\Tests.csproj", "{44444444-4444-4444-4444-444444444444}"',
    'EndProject',
  ].join('\r\n');
  assert.deepEqual(parseSolution(sln, path.join(root, 'App.sln')), [
    path.join(root, 'src', 'App', 'App.csproj'),
    path.resolve(root, '..', 'tests', 'Tests.csproj'),
  ]);
});

test('parseSolution reads .slnx project paths, in folders too, without duplicates', () => {
  const slnx = `<Solution>
  <Folder Name="/src/">
    <Project Path="src/App/App.csproj" />
    <Project Type="Classic C#" Path='src/Lib/Lib.csproj'>
      <Configuration Solution="Release|*" Project="Release|Any CPU" />
    </Project>
  </Folder>
  <Project Path="src\\App\\App.csproj" />
  <Project Path="docs/Docs.esproj" />
</Solution>`;
  assert.deepEqual(parseSolution(slnx, path.join(root, 'App.slnx')), [
    path.join(root, 'src', 'App', 'App.csproj'),
    path.join(root, 'src', 'Lib', 'Lib.csproj'),
  ]);
});
