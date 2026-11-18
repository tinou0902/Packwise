import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSources } from '../src/ecosystems/nuget/dotnet.ts';
import { latestVersions } from '../src/ecosystems/nuget/model.ts';
import { nugetOrgPage, toVersionDetails } from '../src/ecosystems/nuget/feed.ts';

test('parseSources keeps enabled HTTP sources', () => {
  const output = [
    'Registered Sources:',
    '  1.  nuget.org [Enabled]',
    '      https://api.nuget.org/v3/index.json',
    '  2.  Local [Enabled]',
    '      /home/me/packages',
    '  3.  Company feed [Disabled]',
    '      https://pkgs.example.com/v3/index.json',
    '  4.  My feed [Enabled]',
    '      https://example.com/nuget/v3/index.json',
  ].join('\r\n');
  assert.deepEqual(parseSources(output), [
    { name: 'nuget.org', url: 'https://api.nuget.org/v3/index.json' },
    { name: 'My feed', url: 'https://example.com/nuget/v3/index.json' },
  ]);
});

test('latestVersions keeps the highest latest version across frameworks', () => {
  const json = JSON.stringify({
    projects: [{ frameworks: [
      { framework: 'net8.0', topLevelPackages: [{ id: 'Serilog', latestVersion: '4.0.0' }] },
      { framework: 'net10.0', topLevelPackages: [{ id: 'serilog', latestVersion: '4.1.0-dev-1' }, { id: 'Polly' }] },
    ] }],
  });
  assert.deepEqual([...latestVersions(json)], [['serilog', '4.1.0-dev-1']]);
});

test('toVersionDetails maps a registration catalog entry', () => {
  const d = toVersionDetails({
    version: '1.0.0',
    authors: ['A', 'B'],
    tags: 'json serializer',
    published: '1900-01-01T00:00:00+00:00',
    vulnerabilities: [{ advisoryUrl: 'https://github.com/advisories/GHSA-x', severity: '2' }],
    deprecation: { reasons: ['Legacy'], alternatePackage: { id: 'New.Package' } },
    dependencyGroups: [{ targetFramework: 'net8.0', dependencies: [{ id: 'Dep', range: '[1.0.0, )' }] }, {}],
  }, 'Some.Package');
  assert.equal(d.id, 'Some.Package');
  assert.equal(d.authors, 'A, B');
  assert.deepEqual(d.tags, ['json', 'serializer']);
  assert.equal(d.listed, false);
  assert.equal(d.published, '');
  assert.deepEqual(d.vulnerabilities, [{ severity: 'High', advisoryUrl: 'https://github.com/advisories/GHSA-x' }]);
  assert.deepEqual(d.deprecation, { reasons: ['Legacy'], message: '', alternateId: 'New.Package' });
  assert.deepEqual(d.dependencies, [
    { group: 'net8.0', packages: [{ id: 'Dep', range: '[1.0.0, )' }] },
    { group: 'any', packages: [] },
  ]);
  assert.equal(d.galleryUrl, undefined);
  assert.equal(d.reportUrl, undefined);
});

test('toVersionDetails links nuget.org entries to their gallery page', () => {
  const d = toVersionDetails({ id: 'A.B', version: '1.0.0-rc+1' }, 'A.B', true);
  assert.equal(d.galleryUrl, 'https://www.nuget.org/packages/A.B/1.0.0-rc%2B1');
  assert.equal(d.reportUrl, 'https://www.nuget.org/packages/A.B/1.0.0-rc%2B1/ReportAbuse');
  assert.equal(nugetOrgPage('Serilog'), 'https://www.nuget.org/packages/Serilog');
});
