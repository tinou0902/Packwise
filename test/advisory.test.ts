import assert from 'node:assert/strict';
import { test } from 'node:test';
import { severityName, worstSeverity } from '../src/advisory.ts';

test('severityName maps registration values', () => {
  assert.equal(severityName(0), 'Low');
  assert.equal(severityName('3'), 'Critical');
  assert.equal(severityName(9), 'Unknown');
  assert.equal(severityName('High'), 'High');
  assert.equal(severityName(undefined), 'Unknown');
  assert.equal(severityName(''), 'Unknown');
});

test('worstSeverity picks the most severe advisory', () => {
  const a = (severity: string) => ({ severity, advisoryUrl: '' });
  assert.equal(worstSeverity([a('Moderate'), a('Critical'), a('Low')]), 'Critical');
  assert.equal(worstSeverity([a('Low')]), 'Low');
  assert.equal(worstSeverity([]), undefined);
});
