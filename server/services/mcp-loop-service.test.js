import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createMcpLoopService } from './mcp-loop-service.js';

test('MCP loop prints a redacted execution record for every polling attempt', async () => {
  const database = new Database(':memory:');
  let currentTime = 1_000;
  const calls = [
    {
      state: 'running',
      token: 'must-not-be-logged',
      nested: { authorization: 'Bearer must-not-be-logged' },
    },
    new Error('Bearer must-not-be-logged'),
    {
      state: 'success',
      auth_key: 'must-not-be-logged',
      digest: 'a'.repeat(64),
    },
  ];
  const entries = [];
  const service = createMcpLoopService({
    database,
    now: () => currentTime,
    createId: () => 'loop-job-1',
    resolveTargetIdentity: async () => ({
      mcpServerId: 'mcp-server-1',
      toolName: 'mcp__demo__get_task_status',
    }),
    callTarget: async () => {
      const next = calls.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    scriptExecutor: async ({ event }) => ({
      output: { status: event.result.state === 'success' ? 'success' : 'running' },
    }),
    logger: {
      info: (message, details) => entries.push({ message, details }),
      error: () => {},
    },
  });

  try {
    const scheduled = await service.enqueue({
      hook: { id: 'hook-1', name: 'Wait for task', matcher: { value: 'mcp__demo__get_task_status' } },
      action: {
        id: 'loop-action-1',
        config: {
          terminationScript: 'async def run(event, ccui): pass',
          pollIntervalMs: 10,
          perCallTimeoutMs: 1_000,
          maxWaitMs: 60_000,
        },
      },
      executionId: 'hook-execution-1',
      tenantId: 2,
      workspaceId: 3,
      userId: 4,
      sessionId: 'session-1',
      toolUseId: 'tool-use-1',
      workspaceRoot: '/workspace',
      inputs: { task_id: 'task-1' },
      initialResult: { state: 'running' },
    });
    assert.equal(scheduled.scheduled, true);

    currentTime = 1_010;
    await service.tick();
    currentTime = 1_020;
    await service.tick();
    currentTime = 1_030;
    await service.tick();

    assert.deepEqual(entries.map((entry) => entry.message), [
      '[McpLoop:loop-job-1] attempt_completed',
      '[McpLoop:loop-job-1] attempt_failed',
      '[McpLoop:loop-job-1] attempt_completed',
    ]);
    assert.deepEqual(entries.map((entry) => entry.details.attemptCount), [1, 2, 3]);
    assert.equal(entries[0].details.terminationOutcome, 'running');
    assert.equal(entries[0].details.result.token, '[redacted]');
    assert.equal(entries[0].details.result.nested.authorization, '[redacted]');
    assert.equal(entries[1].details.willRetry, true);
    assert.equal(entries[1].details.failureStage, 'mcp_call');
    assert.equal(Object.hasOwn(entries[1].details, 'result'), false);
    assert.equal(entries[1].details.error, 'Bearer [redacted]');
    assert.equal(entries[2].details.terminationOutcome, 'succeeded');
    assert.equal(entries[2].details.result.auth_key, '[redacted]');
    assert.equal(entries[2].details.result.digest, '[redacted]');
    assert.equal(service.getJob('loop-job-1').status, 'succeeded');

    const attempts = database.prepare(`
      SELECT * FROM mcp_loop_attempts
      WHERE hook_execution_id = ?
      ORDER BY attempt_count ASC
    `).all('hook-execution-1');
    assert.deepEqual(attempts.map((attempt) => attempt.attempt_count), [0, 1, 2, 3]);
    assert.deepEqual(attempts.map((attempt) => attempt.script_status), [
      'completed',
      'completed',
      'not_run',
      'completed',
    ]);
    assert.equal(JSON.parse(attempts[0].script_input_json).attempt_count, 0);
    assert.equal(JSON.parse(attempts[0].script_output_json).output.status, 'running');
    assert.equal(JSON.parse(attempts[1].script_input_json).result.token, 'must-not-be-logged');
    assert.equal(JSON.parse(attempts[1].script_output_json).output.status, 'running');
    assert.equal(attempts[2].failure_stage, 'mcp_call');
    assert.equal(attempts[2].script_input_json, null);
    assert.equal(attempts[2].script_output_json, null);
    assert.equal(JSON.parse(attempts[3].script_output_json).output.status, 'success');
    assert.equal(attempts[3].termination_outcome, 'succeeded');
  } finally {
    database.close();
  }
});

test('MCP loop persists the initial script input and output when no background job is scheduled', async () => {
  const database = new Database(':memory:');
  const service = createMcpLoopService({
    database,
    now: () => 5_000,
    resolveTargetIdentity: async () => ({ mcpServerId: 'server-1', toolName: 'status' }),
    scriptExecutor: async ({ event }) => ({
      output: { status: event.result.state === 'failed' ? 'failed' : 'running' },
    }),
    logger: { info: () => {}, error: () => {} },
  });

  try {
    const result = await service.enqueue({
      hook: { id: 'hook-1', name: 'Wait', matcher: { value: 'status' } },
      action: {
        id: 'action-1',
        config: {
          terminationScript: 'async def run(event, ccui): pass',
          pollIntervalMs: 10,
          perCallTimeoutMs: 1_000,
          maxWaitMs: 60_000,
        },
      },
      executionId: 'execution-initial-terminal',
      sessionId: 'session-1',
      toolUseId: 'tool-use-1',
      workspaceRoot: '/workspace',
      inputs: { task_id: 'task-1' },
      initialResult: { state: 'failed' },
    });

    assert.deepEqual(result, {
      scheduled: false,
      status: 'failed',
      initialResult: { state: 'failed' },
    });
    const attempt = database.prepare(`
      SELECT * FROM mcp_loop_attempts
      WHERE hook_execution_id = ? AND attempt_count = 0
    `).get('execution-initial-terminal');
    assert.equal(attempt.job_id, null);
    assert.equal(attempt.script_status, 'completed');
    assert.equal(attempt.termination_outcome, 'failed');
    assert.deepEqual(JSON.parse(attempt.script_input_json).result, { state: 'failed' });
    assert.deepEqual(JSON.parse(attempt.script_output_json), { output: { status: 'failed' } });
  } finally {
    database.close();
  }
});

test('MCP loop prints the MCP result when the termination script fails', async () => {
  const database = new Database(':memory:');
  let currentTime = 2_000;
  const entries = [];
  const service = createMcpLoopService({
    database,
    now: () => currentTime,
    createId: () => 'loop-job-script-error',
    resolveTargetIdentity: async () => ({ mcpServerId: 'server-1', toolName: 'status' }),
    callTarget: async () => ({ state: 'running', password: 'must-not-be-logged' }),
    scriptExecutor: async ({ event }) => {
      if (event.attempt_count === 0) return { output: { status: 'running' } };
      throw new Error('termination failed');
    },
    logger: {
      info: (message, details) => entries.push({ message, details }),
      error: () => {},
    },
  });

  try {
    await service.enqueue({
      hook: { id: 'hook-1', name: 'Wait', matcher: { value: 'status' } },
      action: {
        id: 'action-1',
        config: {
          terminationScript: 'async def run(event, ccui): pass',
          pollIntervalMs: 10,
          perCallTimeoutMs: 1_000,
          maxWaitMs: 60_000,
        },
      },
      executionId: 'execution-1',
      sessionId: 'session-1',
      toolUseId: 'tool-use-1',
      workspaceRoot: '/workspace',
      inputs: {},
      initialResult: { state: 'running' },
    });

    currentTime = 2_010;
    await service.tick();

    assert.equal(entries.length, 1);
    assert.equal(entries[0].message, '[McpLoop:loop-job-script-error] attempt_failed');
    assert.equal(entries[0].details.failureStage, 'termination_script');
    assert.equal(entries[0].details.result.state, 'running');
    assert.equal(entries[0].details.result.password, '[redacted]');
    assert.equal(entries[0].details.error, 'termination failed');
  } finally {
    database.close();
  }
});
