import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, inRange, isPrerelease } from '../src/semver.ts';

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

test('inRange handles NuGet interval notation', () => {
  assert.equal(inRange('[1.0,2.0)', '1.5.0'), true);
  assert.equal(inRange('[1.0,2.0)', '2.0.0'), false);
  assert.equal(inRange('(1.0,2.0]', '1.0.0'), false);
  assert.equal(inRange('(, 1.5.0)', '1.4.9'), true);
  assert.equal(inRange('[1.2.3]', '1.2.3'), true);
  assert.equal(inRange('[1.2.3]', '1.2.4'), false);
  assert.equal(inRange('1.0', '0.9'), false);
  assert.equal(inRange('1.0', '3.0'), true);
});
