import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeQueryWithHookFallback, isRequiredHook } from './claude-hook-policy.js';

test('only explicitly fail-closed PreToolUse hooks are required', () => {
  assert.equal(isRequiredHook({ eventName: 'PreToolUse', extensionLogic: { failClosed: true } }), true);
  for (const hook of [
    null, { eventName: 'PreToolUse' },
    { eventName: 'PreToolUse', extensionLogic: { failClosed: false } },
    { eventName: 'PreToolUse', extensionLogic: { failClosed: 'true' } },
    { eventName: 'Stop', extensionLogic: { failClosed: true } },
    { eventName: 'SubagentStop', extensionLogic: { failClosed: true } },
    { eventName: 'StopFailure', extensionLogic: { failClosed: true } },
    { eventName: 'PostToolUse', extensionLogic: { failClosed: true } },
  ]) assert.equal(isRequiredHook(hook), false);
});

test('required PreToolUse hooks prevent retry without hooks when the SDK rejects initialization', () => {
  const hooks = { PreToolUse: [{ hooks: [async () => ({})] }] };
  const options = { hooks };
  const original = new Error('SDK rejected hook options');
  let calls = 0;
  assert.throws(() => createClaudeQueryWithHookFallback({
    query: ({ options: actual }) => { calls += 1; assert.equal(actual.hooks, hooks); throw original; },
    prompt: 'task', options, hasRequiredHook: true,
    onFallback: () => assert.fail('Required hooks must not use fallback'),
  }), (error) => error.code === 'REQUIRED_HOOK_UNAVAILABLE' && error.cause === original);
  assert.equal(calls, 1);
  assert.equal(options.hooks, hooks);
});

test('legacy fail-closed Stop hooks preserve the existing SDK compatibility fallback', () => {
  const configuredHooks = ['Stop', 'SubagentStop'].map((eventName) => ({
    eventName, extensionLogic: { failClosed: true },
  }));
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
    prompt: 'same task', options, hasRequiredHook: configuredHooks.some(isRequiredHook),
    onFallback: (error) => { reported = error; },
  });
  assert.equal(result, instance);
  assert.equal(reported, original);
  assert.deepEqual(prompts, ['same task', 'same task']);
});

test('successful query construction never retries', () => {
  let calls = 0;
  const instance = {};
  assert.equal(createClaudeQueryWithHookFallback({
    query: () => { calls += 1; return instance; }, prompt: 'task', options: {}, hasRequiredHook: true,
  }), instance);
  assert.equal(calls, 1);
});
