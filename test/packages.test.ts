import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nugetRules as rules } from '../src/ecosystems/nuget/rules.ts';
import type { InstalledPackage, ProjectState, VersionDetails } from '../src/manager/protocol.ts';
import {
  formatDownloads,
  matchesQuery,
  galleryName,
  rowsFor,
  updateTarget,
  versionChoices,
  type ListInput,
} from '../src/manager/webview/packages.ts';

const pkg = (id: string, resolved: string, extra: Partial<InstalledPackage> = {}): InstalledPackage => ({
  id, requested: resolved, resolved, latest: '', latestPrerelease: '', isDirect: true, vulnerabilities: [], ...extra,
});

const project = (name: string, packages: InstalledPackage[]): ProjectState => ({
  uri: `file:///${name}.csproj`, name, path: `${name}.csproj`, loading: false, error: '', warnings: [], packages,
});

const projects = [
  project('App', [
    pkg('Serilog', '3.0.0', { latest: '4.0.0', latestPrerelease: '4.1.0-beta' }),
    pkg('Dapper', '2.1.0'),
    pkg('System.Text.Json', '8.0.0', { requested: '', isDirect: false }),
  ]),
  project('Tests', [
    pkg('serilog', '3.1.0', { latest: '4.0.0' }),
    pkg('xunit', '2.9.0', { latestPrerelease: '3.0.0-rc' }),
    pkg('Dapper', '2.1.0', { requested: '', isDirect: false }),
  ]),
];

const input = (extra: Partial<ListInput> = {}): ListInput => ({ projects, hits: [], query: '', prerelease: false, rules, ...extra });

test('installed tab: direct packages merged across projects, transitive ones apart', () => {
  const { rows, transitive } = rowsFor('installed', input());
  assert.deepEqual(rows.map(r => `${r.id}×${r.installs.length}`), ['Dapper×1', 'Serilog×2', 'xunit×1']);
  assert.deepEqual(transitive.map(r => r.id), ['System.Text.Json']); // Dapper is direct elsewhere.
  assert.deepEqual(rowsFor('installed', input({ query: ' ser  LOG ' })).rows.map(r => r.id), ['Serilog']);
});

test('updates tab: highest target, prereleases only when allowed', () => {
  assert.deepEqual(rowsFor('updates', input()).rows.map(r => `${r.id}→${r.target}`), ['Serilog→4.0.0']);
  assert.deepEqual(rowsFor('updates', input({ prerelease: true })).rows.map(r => `${r.id}→${r.target}`), ['Serilog→4.1.0-beta', 'xunit→3.0.0-rc']);
});

test('consolidate tab: packages resolved to different versions', () => {
  assert.deepEqual(rowsFor('consolidate', input()).rows.map(r => r.id), ['Serilog']);
});

test('browse tab: search hits with their installs', () => {
  const hits = [{ id: 'SERILOG' }, { id: 'Polly' }].map(h => ({ ...h, version: '1.0.0', title: '', description: '', authors: '', owners: '', iconUrl: '', verified: false, vulnerable: false, deprecated: false, source: '' }));
  assert.deepEqual(rowsFor('browse', input({ hits })).rows.map(r => `${r.key}×${r.installs.length}`), ['serilog×2', 'polly×0']);
});

test('updateTarget ignores unknown or older latest versions', () => {
  assert.equal(updateTarget(pkg('A', '2.0.0', { latest: '1.0.0' }), false, rules), undefined);
  assert.equal(updateTarget(pkg('A', '2.0.0'), true, rules), undefined);
  assert.equal(updateTarget(pkg('A', '', { latest: '1.0.0' }), false, rules), undefined);
});

test('matchesQuery needs every word', () => {
  assert.equal(matchesQuery('Microsoft.Extensions.Logging', 'ext log'), true);
  assert.equal(matchesQuery('Microsoft.Extensions.Logging', 'ext http'), false);
  assert.equal(matchesQuery('Anything', '   '), true);
});

test('versionChoices: shortcuts, then visible versions newest first with their flags', () => {
  const v = (version: string, extra: Partial<VersionDetails> = {}): VersionDetails => ({
    id: 'A', version, listed: true, title: '', description: '', authors: '', tags: [], iconUrl: '', projectUrl: '',
    licenseUrl: '', licenseExpression: '', published: '', vulnerabilities: [], dependencies: [], ...extra,
  });
  const versions = [
    v('1.0.0', { vulnerabilities: [{ severity: 'High', advisoryUrl: '' }] }),
    v('1.1.0', { listed: false }),
    v('1.2.0', { listed: false }),
    v('2.0.0', { deprecation: { reasons: ['Legacy'], message: '', alternateId: '' } }),
    v('3.0.0-beta'),
  ];
  assert.deepEqual(versionChoices(versions, ['1.1.0'], false, rules), [
    { kind: 'latestStable', value: '2.0.0' },
    { kind: 'version', value: '2.0.0', flags: ['deprecated'] },
    { kind: 'version', value: '1.1.0', flags: ['unlisted'] },
    { kind: 'version', value: '1.0.0', flags: ['vulnerable'] },
  ]);
  assert.deepEqual(versionChoices(versions, [], true, rules).slice(0, 3), [
    { kind: 'latestStable', value: '2.0.0' },
    { kind: 'latestPrerelease', value: '3.0.0-beta' },
    { kind: 'version', value: '3.0.0-beta', flags: [] },
  ]);
});

test('formatDownloads and galleryName', () => {
  assert.equal(formatDownloads(950), '950');
  assert.equal(formatDownloads(1500), '1.5K');
  assert.equal(formatDownloads(2_000_000), '2M');
  assert.equal(formatDownloads(123_456_789), '123M');
  assert.equal(formatDownloads(4_200_000_000), '4.2B');
  assert.equal(galleryName('https://www.nuget.org/packages/Serilog/4.0.0'), 'nuget.org');
  assert.equal(galleryName('https://npmjs.com/package/react'), 'npmjs.com');
  assert.equal(galleryName('not a url'), 'not a url');
});
