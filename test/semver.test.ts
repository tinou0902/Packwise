import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, isPrerelease } from '../src/ecosystems/nuget/semver.ts';

test('compareVersions orders numeric parts and prereleases', () => {
  assert.equal(compareVersions('1.2.10', '1.2.9'), 1);
  assert.equal(compareVersions('2.0', '2.0.0'), 0);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('1.0.0+build', '1.0.0'), 0);
});

test('isPrerelease', () => {
  assert.equal(isPrerelease('9.0.0-preview.1'), true);
  assert.equal(isPrerelease('9.0.0'), false);
});
