import assert from 'node:assert/strict';
import test from 'node:test';

import { formatExecutionValue, isWorkspaceExecutionOutput, redactVisibleSecretText } from './display';

test('execution payloads redact credentials in command output and structured input', () => {
  const output = redactVisibleSecretText('Authorization: Bearer confidential\nAPI_KEY=another-secret\npassword=hidden');
  assert.ok(!output.includes('confidential'));
  assert.ok(!output.includes('another-secret'));
  assert.ok(!output.includes('hidden'));
  const structured = formatExecutionValue({ api_key: 'sensitive key', nested: { ACCESS_TOKEN: 'secret-value' }, Authorization: 'Bearer token-value', keep: 'task failed' });
  assert.ok(!structured.includes('sensitive key'));
  assert.ok(!structured.includes('secret-value'));
  assert.ok(!structured.includes('token-value'));
  assert.ok(structured.includes('task failed'));
});

test('execution formatting preserves meaningful false and zero results and handles bigint', () => {
  assert.equal(formatExecutionValue(false), 'false');
  assert.equal(formatExecutionValue(0), '0');
  assert.equal(formatExecutionValue(undefined), '');
  assert.equal(formatExecutionValue({ count: 5n }), '{\n  "count": "5"\n}');
});

test('circular execution payloads do not crash the task inspector', () => {
  const value: { circular?: unknown } = {};
  value.circular = value;
  assert.doesNotThrow(() => formatExecutionValue(value));
});

test('runtime output files outside the workspace do not offer a broken preview', () => {
  assert.equal(isWorkspaceExecutionOutput('/tmp/claude/tasks/a.output', '/work/demo'), false);
  assert.equal(isWorkspaceExecutionOutput('/work/demo-other/a', '/work/demo'), false);
  assert.equal(isWorkspaceExecutionOutput('../a', '/work/demo'), false);
  assert.equal(isWorkspaceExecutionOutput('/work/demo/out/a', '/work/demo'), true);
  assert.equal(isWorkspaceExecutionOutput('out/a', '/work/demo'), true);
});
