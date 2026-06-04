import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_NATIVE_SCHEDULING_TOOL_NAMES,
  applyClaudeNativeSchedulingEnvironmentPolicy,
  assertClaudeNativeSchedulingCommandAllowed,
  getClaudeNativeSchedulingCommandName,
} from './claude-native-scheduling-policy.js';

test('detects Claude native scheduling slash commands only at prompt start', () => {
  assert.equal(getClaudeNativeSchedulingCommandName('/schedule every day'), '/schedule');
  assert.equal(getClaudeNativeSchedulingCommandName('  /loop every minute'), '/loop');
  assert.equal(getClaudeNativeSchedulingCommandName('please use /schedule'), null);
  assert.equal(getClaudeNativeSchedulingCommandName('/scheduler is a different command'), null);
});

test('blocks native scheduling commands by default', () => {
  assert.throws(
    () => assertClaudeNativeSchedulingCommandAllowed('/schedule every day', {}),
    /disabled in CCUI/,
  );
});

test('disables Claude Code cron tools in the SDK subprocess environment by default', () => {
  assert.deepEqual(CLAUDE_NATIVE_SCHEDULING_TOOL_NAMES, ['CronCreate', 'CronList', 'CronDelete']);
  assert.equal(applyClaudeNativeSchedulingEnvironmentPolicy({}).CLAUDE_CODE_DISABLE_CRON, '1');
});

test('allows native scheduling commands when explicitly enabled', () => {
  assert.doesNotThrow(() => assertClaudeNativeSchedulingCommandAllowed('/schedule every day', {
    CCUI_ALLOW_CLAUDE_NATIVE_SCHEDULING: 'true',
  }));
  assert.deepEqual(applyClaudeNativeSchedulingEnvironmentPolicy({
    CCUI_ALLOW_CLAUDE_NATIVE_SCHEDULING: 'true',
  }), {
    CCUI_ALLOW_CLAUDE_NATIVE_SCHEDULING: 'true',
  });
});
