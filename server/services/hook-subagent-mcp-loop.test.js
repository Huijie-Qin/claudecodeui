import assert from 'node:assert/strict';
import test from 'node:test';

import { runSubagentMcpLoop, subagentHookTimeoutSeconds } from './hook-subagent-mcp-loop.js';

function makeLoop(overrides = {}) {
  return {
    hook: { id: 'test-loop' },
    action: { id: 'loop', config: {
      pollIntervalMs: 1, maxWaitMs: 1000, perCallTimeoutMs: 100,
      successWhen: { field: 'status', equals: 'done' },
      failureWhen: { field: 'status', equals: 'failed' },
    } },
    event: { hook_event_name: 'PostToolUse', agent_id: 'child-a', tool_use_id: 'tool-a', tool_response: { status: 'running' } },
    input: { task_id: 'task-a' },
    resolveTarget: async () => ({ qualifiedToolName: 'mcp__status__poll' }),
    mcpCaller: async () => ({ structuredContent: { status: 'done' } }),
    ...overrides,
  };
}

test('terminal initial subagent results skip target materialization and polling', async () => {
  for (const status of ['done', 'failed']) {
    const result = await runSubagentMcpLoop(makeLoop({
      event: { hook_event_name: 'PostToolUse', agent_id: 'child-a', tool_response: { status } },
      resolveTarget: async () => assert.fail('Initial terminal result needs no target'),
      mcpCaller: async () => assert.fail('Initial terminal result needs no poll'),
    }));
    assert.equal(result.status, status === 'done' ? 'succeeded' : 'failed');
    assert.equal(result.attemptCount, 0);
    assert.deepEqual(result.toolUseResult, { status });
  }
});

test('subagent polling preserves original inputs and evaluates every result using the configured script', async () => {
  const scriptInputs = [];
  let calls = 0;
  const options = makeLoop();
  options.action.config.terminationScript = 'return status';
  const result = await runSubagentMcpLoop({ ...options,
    scriptExecutor: async ({ event, language, signal }) => {
      scriptInputs.push(event);
      assert.equal(language, 'python');
      assert.equal(signal.aborted, false);
      return { output: { status: event.result.status === 'done' ? 'success' : 'running' } };
    },
    mcpCaller: async ({ input, timeoutMs, signal }) => {
      assert.deepEqual(input, options.input);
      assert.ok(timeoutMs <= options.action.config.perCallTimeoutMs);
      assert.equal(signal.aborted, false);
      calls += 1;
      return { content: [{ type: 'text', text: JSON.stringify({ status: calls < 2 ? 'running' : 'done' }) }] };
    },
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(scriptInputs.map((event) => event.attempt_count), [0, 1, 2]);
  assert.ok(scriptInputs.every((event) => event.agent_id === 'child-a'));
  assert.ok(scriptInputs.every((event) => event.initial_result.status === 'running'));
  assert.deepEqual(result.toolUseResult, { status: 'done' });
});

test('a CLI JSON string callback reaches child termination scripts as task data', async () => {
  const options = makeLoop();
  options.event.tool_response = JSON.stringify({ task_id: 'task-a', status: 'running' });
  options.action.config.terminationScript = 'async def run(event, ccui): pass';
  const results = [];
  const result = await runSubagentMcpLoop({ ...options,
    scriptExecutor: async ({ event }) => {
      results.push(event.result);
      assert.deepEqual(event.initial_result, { task_id: 'task-a', status: 'running' });
      return { output: { status: event.result.status === 'done' ? 'success' : 'running' } };
    },
    mcpCaller: async () => ({ task_id: 'task-a', status: 'done' }),
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.attemptCount, 1);
  assert.deepEqual(results, [{ task_id: 'task-a', status: 'running' }, { task_id: 'task-a', status: 'done' }]);
  assert.deepEqual(result.toolUseResult, { task_id: 'task-a', status: 'done' });
});

test('subagent loops stop retrying after three consecutive MCP failures', async () => {
  let calls = 0;
  const result = await runSubagentMcpLoop(makeLoop({
    mcpCaller: async () => { calls += 1; throw new Error('MCP unavailable'); },
  }));
  assert.equal(calls, 3);
  assert.equal(result.status, 'failed');
  assert.equal(result.toolUseResult.status, 'failed');
  assert.match(result.toolUseResult.error, /MCP unavailable/);
});

test('subagent cancellation aborts the active MCP request and prevents more polling', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await runSubagentMcpLoop(makeLoop({
    signal: controller.signal,
    mcpCaller: async ({ signal }) => {
      calls += 1;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        controller.abort(new Error('Child was stopped'));
      });
    },
  }));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.toolUseResult.status, 'cancelled');
  assert.equal(calls, 1);
});

test('subagent polling obeys the maximum wait and returns a terminal replacement on deadline', async () => {
  const options = makeLoop();
  options.action.config.maxWaitMs = 25;
  let requestSignal;
  const result = await runSubagentMcpLoop({ ...options,
    mcpCaller: async ({ signal }) => {
      requestSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  assert.equal(result.status, 'timed_out');
  assert.equal(requestSignal.aborted, true);
  assert.equal(result.toolUseResult.status, 'timed_out');
});

test('child loop budgets extend SDK callback deadlines without overflowing JavaScript timers', () => {
  const hook = { eventName: 'PostToolUse', includeSubagents: true,
    postActions: [{ type: 'mcp_loop_run', config: { maxWaitMs: 2_700_000 } }],
  };
  assert.equal(subagentHookTimeoutSeconds(hook), 2760);
  assert.equal(subagentHookTimeoutSeconds({ ...hook, includeSubagents: false }), 60);
  assert.ok(subagentHookTimeoutSeconds({ ...hook, postActions: Array(10).fill({
    type: 'mcp_loop_run', config: { maxWaitMs: 604_800_000 },
  }) }) * 1000 <= 2_147_483_000);
});

test('a subagent deadline also bounds target preparation that does not accept an abort signal', async () => {
  const options = makeLoop();
  options.action.config.maxWaitMs = 15;
  const result = await runSubagentMcpLoop({ ...options,
    resolveTarget: () => new Promise(() => {}),
    mcpCaller: async () => assert.fail('Expired target resolution must never call MCP'),
  });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.attemptCount, 0);
});
