import assert from 'node:assert/strict';
import test from 'node:test';

import { filterHookContextResponse } from './hook-context-policy.js';

test('disabled delivery removes bound payloads without mutating audit inputs or permission controls', () => {
  const response = { systemMessage: 'PRIVATE', stopReason: 'PRIVATE', hookSpecificOutput: {
    hookEventName: 'PreToolUse', additionalContext: 'PRIVATE', initialUserMessage: 'PRIVATE',
    updatedMCPToolOutput: { secret: 'PRIVATE' }, content: { secret: 'PRIVATE' },
    permissionDecision: 'deny', permissionDecisionReason: 'PRIVATE', updatedInput: { limit: 10 },
  } };
  const filtered = filterHookContextResponse({ injectToContext: false }, response);
  assert.doesNotMatch(JSON.stringify(filtered), /PRIVATE/);
  assert.equal(filtered.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(filtered.hookSpecificOutput.updatedInput, { limit: 10 });
  assert.equal(response.hookSpecificOutput.additionalContext, 'PRIVATE');
  assert.equal(filterHookContextResponse({}, response), response);
  assert.equal(filterHookContextResponse({ injectToContext: true }, response), response);
});

test('disabled Stop feedback stops once instead of requesting a feedback-free retry loop', () => {
  for (const eventName of ['Stop', 'SubagentStop']) {
    assert.deepEqual(filterHookContextResponse({ injectToContext: false, eventName },
      { decision: 'block', reason: 'PRIVATE' }), { continue: false });
  }
  assert.deepEqual(filterHookContextResponse({ injectToContext: false }, {
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'PRIVATE' },
  }), {});
});

test('confirmation and nested permission denial preserve control without sending private reasons', () => {
  const filtered = filterHookContextResponse({ injectToContext: false }, {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask',
      permissionDecisionReason: 'PRIVATE', decision: { behavior: 'deny', message: 'PRIVATE', interrupt: true } },
  });
  assert.equal(filtered.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(filtered.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(filtered.hookSpecificOutput.decision.interrupt, true);
  assert.doesNotMatch(JSON.stringify(filtered), /PRIVATE/);
});
