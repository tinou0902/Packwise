import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOutdated, applyVulnerable, parseList } from '../src/model.ts';

const list = JSON.stringify({
  projects: [{
    path: 'App.csproj',
    frameworks: [
      {
        framework: 'net8.0',
        topLevelPackages: [{ id: 'Serilog', requestedVersion: '3.0.0', resolvedVersion: '3.0.0' }],
        transitivePackages: [{ id: 'System.Text.Json', resolvedVersion: '8.0.0' }],
      },
      {
        framework: 'net10.0',
        topLevelPackages: [{ id: 'Serilog', requestedVersion: '3.0.0', resolvedVersion: '3.0.1' }],
        transitivePackages: [{ id: 'system.text.json', resolvedVersion: '8.0.4' }],
      },
    ],
  }],
});

test('parseList merges frameworks and keeps the highest resolved version', () => {
  const data = parseList(list);
  assert.deepEqual(data.groups, ['net8.0', 'net10.0']);
  assert.equal(data.packages.size, 2);
  const serilog = data.packages.get('serilog')!;
  assert.equal(serilog.isDirect, true);
  assert.equal(serilog.requested, '3.0.0');
  assert.equal(serilog.resolved, '3.0.1');
  const stj = data.packages.get('system.text.json')!;
  assert.equal(stj.isDirect, false);
  assert.equal(stj.resolved, '8.0.4');
});

test('parseList rejects unexpected output', () => {
  assert.throws(() => parseList('{}'));
});

test('applyOutdated and applyVulnerable annotate packages', () => {
  const data = parseList(list);
  applyOutdated(data, JSON.stringify({
    projects: [{ frameworks: [{ framework: 'net10.0', topLevelPackages: [{ id: 'Serilog', resolvedVersion: '3.0.1', latestVersion: '4.2.0' }] }] }],
  }));
  applyVulnerable(data, JSON.stringify({
    projects: [{ frameworks: [{ framework: 'net8.0', transitivePackages: [{
      id: 'System.Text.Json', resolvedVersion: '8.0.0',
      vulnerabilities: [{ severity: 'High', advisoryurl: 'https://github.com/advisories/GHSA-x' }],
    }] }] }],
  }));
  assert.equal(data.packages.get('serilog')!.latest, '4.2.0');
  assert.deepEqual(data.packages.get('system.text.json')!.vulnerabilities, [
    { severity: 'High', advisoryUrl: 'https://github.com/advisories/GHSA-x' },
  ]);
  assert.equal(data.packages.get('system.text.json')!.latest, '');
});
