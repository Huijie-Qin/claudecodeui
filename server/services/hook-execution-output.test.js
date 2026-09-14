import assert from 'node:assert/strict';
import test from 'node:test';

import { redactHookExecutionOutput, userHookExecutionOutput } from './hook-execution-output.js';

test('user Hook output preserves empty values and business results without inventing a summary', () => {
  for (const value of [{}, [], '', false, 0, null, { decision: 'block', reason: 'Please execute the review Skill' }]) {
    assert.deepEqual(redactHookExecutionOutput(value), value);
  }
  const result = userHookExecutionOutput({
    id: 'execution', status: 'succeeded', scriptOutput: {}, response: {}, errorMessage: null,
    input: { env: 'private input' }, actions: { args: 'private args' }, logs: ['private log'],
    userId: 99, script: 'private code',
  });
  assert.deepEqual(result.scriptOutput, {});
  assert.deepEqual(result.response, {});
  for (const key of ['input', 'actions', 'logs', 'userId', 'script', 'summary', 'outcome']) {
    assert.equal(Object.hasOwn(result, key), false);
  }
});

test('user Hook output redacts nested, JSON encoded, and text credentials without mutating stored values', () => {
  const input = {
    status: 'running',
    nested: [{ USER_KEY: 'private-user-value', password: 'private-password' }],
    content: [{ type: 'text', text: '{"token":"private-token","status":"success"}' }],
    reason: 'Authorization: Bearer private-bearer; USER_KEY=private-key password="private phrase"',
  };
  const redacted = redactHookExecutionOutput(input);
  assert.equal(redacted.status, 'running');
  assert.equal(redacted.nested[0].USER_KEY, '[redacted]');
  assert.deepEqual(JSON.parse(redacted.content[0].text), { token: '[redacted]', status: 'success' });
  assert.doesNotMatch(JSON.stringify(redacted), /private-/);
  assert.doesNotMatch(JSON.stringify(redacted), /private phrase/);
  assert.equal(input.nested[0].USER_KEY, 'private-user-value');
  assert.equal(redactHookExecutionOutput('Error: USER_KEY=private-key'), 'Error: USER_KEY=[redacted]');
});
