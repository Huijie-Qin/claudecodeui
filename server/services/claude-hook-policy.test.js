import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeQueryWithHookFallback, isRequiredStopHook } from './claude-hook-policy.js';

test('only explicitly fail-closed Stop and SubagentStop hooks are required', () => {
  assert.equal(isRequiredStopHook({ eventName: 'Stop', extensionLogic: { failClosed: true } }), true);
  assert.equal(isRequiredStopHook({ eventName: 'SubagentStop', extensionLogic: { failClosed: true } }), true);
  for (const hook of [
    null, { eventName: 'Stop' },
    { eventName: 'Stop', extensionLogic: { failClosed: false } },
    { eventName: 'Stop', extensionLogic: { failClosed: 'true' } },
    { eventName: 'StopFailure', extensionLogic: { failClosed: true } },
  ]) assert.equal(isRequiredStopHook(hook), false);
});

test('required Stop hooks prevent query fallback and remain attached after initialization fails', () => {
  const hooks = { Stop: [{ hooks: [async () => ({})] }] };
  const options = { hooks };
  const original = new Error('SDK rejected hook options');
  let calls = 0;
  assert.throws(() => createClaudeQueryWithHookFallback({
    query: ({ options: actual }) => { calls += 1; assert.equal(actual.hooks, hooks); throw original; },
    prompt: 'task', options, hasRequiredStopHook: true,
    onFallback: () => assert.fail('Required hooks must not use fallback'),
  }), (error) => error.code === 'REQUIRED_STOP_HOOK_UNAVAILABLE' && error.cause === original);
  assert.equal(calls, 1);
  assert.equal(options.hooks, hooks);
});

test('optional hooks preserve the existing SDK compatibility fallback', () => {
  const original = new Error('Old SDK does not support hooks');
  const options = { hooks: { Stop: [] }, model: 'test-model' };
  const prompts = [];
  let reported;
  const instance = {};
  const result = createClaudeQueryWithHookFallback({
    query: ({ prompt, options: actual }) => {
      prompts.push(prompt);
      if (actual.hooks) throw original;
      assert.equal(actual.model, options.model);
      return instance;
    },
    prompt: 'same task', options, onFallback: (error) => { reported = error; },
  });
  assert.equal(result, instance);
  assert.equal(reported, original);
  assert.deepEqual(prompts, ['same task', 'same task']);
});

test('successful query construction never retries', () => {
  let calls = 0;
  const instance = {};
  assert.equal(createClaudeQueryWithHookFallback({
    query: () => { calls += 1; return instance; }, prompt: 'task', options: {}, hasRequiredStopHook: true,
  }), instance);
  assert.equal(calls, 1);
});
