import assert from 'node:assert/strict';
import test from 'node:test';

import { getHookExecutionAgent, groupHookExecutions, likelyWinningUpdatedInput, paginationWindow } from './diagnostics';
import type { HookExecution } from './types';

function execution(overrides: Partial<HookExecution>): HookExecution {
  return {
    id: 'execution-1',
    hookId: 'hook-1',
    hookName: 'Hook 1',
    hookVersion: 1,
    bindingController: 'admin',
    userId: 1,
    username: 'alice',
    tenantId: null,
    workspaceId: null,
    sessionId: 'session-1',
    eventName: 'PreToolUse',
    toolUseId: 'tool-1',
    toolName: 'Bash',
    status: 'succeeded',
    input: {},
    scriptOutput: null,
    actions: {},
    response: {},
    logs: [],
    errorMessage: null,
    durationMs: 10,
    startedAtMs: 100,
    completedAtMs: 110,
    startedAt: null,
    completedAt: null,
    diagnostics: {
      outcome: 'succeeded',
      effects: [],
      permissionDecision: null,
      updatedInput: false,
      actionCount: 0,
      failOpen: false,
    },
    ...overrides,
  };
}

test('groups the same tool invocation and detects non-deterministic updatedInput writers', () => {
  const first = execution({
    id: 'execution-1',
    diagnostics: {
      outcome: 'modified_input',
      effects: ['updated_input'],
      permissionDecision: 'allow',
      updatedInput: true,
      actionCount: 0,
      failOpen: false,
    },
    completedAtMs: 120,
  });
  const second = execution({
    id: 'execution-2',
    hookId: 'hook-2',
    hookName: 'Hook 2',
    diagnostics: {
      outcome: 'denied',
      effects: ['updated_input', 'permission_deny'],
      permissionDecision: 'deny',
      updatedInput: true,
      actionCount: 0,
      failOpen: false,
    },
    completedAtMs: 140,
  });

  const [group] = groupHookExecutions([first, second]);
  assert.equal(group.executions.length, 2);
  assert.deepEqual(group.conflicts, ['updated_input', 'permission_decision']);
  assert.equal(likelyWinningUpdatedInput(group)?.id, 'execution-2');
});

test('does not guess correlation for events without a tool use id', () => {
  const groups = groupHookExecutions([
    execution({ id: 'stop-1', eventName: 'Stop', toolUseId: null, toolName: null }),
    execution({ id: 'stop-2', eventName: 'Stop', toolUseId: null, toolName: null }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups.every((group) => group.exact === false), true);
});

test('identifies the triggering agent from safe fields or historical event input', () => {
  assert.equal(getHookExecutionAgent(execution({})).label, '主代理');
  assert.equal(getHookExecutionAgent(execution({ input: { agent_type: 'custom-main' } })).label, '主代理');
  assert.equal(getHookExecutionAgent(execution({ agentId: 'child-1', agentType: 'reviewer' })).label, '子代理 · reviewer');
  assert.equal(getHookExecutionAgent(execution({ input: { agent_id: 'child-1', agent_type: 'reviewer' } })).id, 'child-1');
  assert.equal(getHookExecutionAgent(execution({ eventName: 'SubagentStop' })).label, '子代理');
});

test('does not merge callback records from distinct subagents', () => {
  const groups = groupHookExecutions([
    execution({ id: 'main' }),
    execution({ id: 'child-1', agentId: 'child-1' }),
    execution({ id: 'child-2', input: { agent_id: 'child-2' } }),
  ]);
  assert.equal(groups.length, 3);
});

test('builds a stable pagination window around the current page', () => {
  assert.deepEqual(paginationWindow(1, 10), [1, 2, 3, 4, 5]);
  assert.deepEqual(paginationWindow(5, 10), [3, 4, 5, 6, 7]);
  assert.deepEqual(paginationWindow(10, 10), [6, 7, 8, 9, 10]);
  assert.deepEqual(paginationWindow(2, 3), [1, 2, 3]);
});
