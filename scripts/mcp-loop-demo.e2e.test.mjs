import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';

import {
  TWENTY_MINUTES_MS,
  createMcpLoopDemoTaskServer,
} from './mcp-loop-demo-task-service.mjs';
import { createMcpLoopDemoMcpServer } from './mcp-loop-demo-mcp.mjs';

const TERMINATION_SCRIPT = `async def run(event, ccui):
    status = (event.get("result") or {}).get("status")
    if status == "success":
        return {"output": {"status": "success"}}
    if status == "failed":
        return {"output": {"status": "failed"}}
    return {"output": {"status": "running"}}
`;
const execFileAsync = promisify(execFile);
const serverModuleRoot = process.env.CCUI_TEST_DIST_SERVER === '1'
  ? '../dist-server/server'
  : '../server';

function importServerModule(relativePath) {
  return import(`${serverModuleRoot}/${relativePath}`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('PostToolUse mcp_loop_run polls get_task_status and replaces running with success', async () => {
  assert.equal(TWENTY_MINUTES_MS, 1_200_000, 'the demo service defaults to a real 20-minute task');

  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-mcp-loop-e2e-'));
  process.env.DATABASE_PATH = path.join(testRoot, 'app.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');

  const [
    { HOOK_CONFIG_SCHEMA_SQL },
    { callHookMcpTool },
    { createHookRuntimeSession },
    { buildMcpLoopReplacement, createMcpLoopService },
  ] = await Promise.all([
    importServerModule('database/hook-config-schema.js'),
    importServerModule('services/hook-mcp-client.js'),
    importServerModule('services/hook-runtime.js'),
    importServerModule('services/mcp-loop-service.js'),
  ]);

  // Automated E2E uses the same service with an injected short duration. The
  // executable demo defaults to TWENTY_MINUTES_MS when this option is omitted.
  const taskServer = createMcpLoopDemoTaskServer({ durationMs: 300 });
  const taskAddress = await listen(taskServer);
  const taskServiceUrl = `http://127.0.0.1:${taskAddress.port}`;
  const helperToken = 'loop-private-token';
  const mcpServer = createMcpLoopDemoMcpServer({
    taskServiceUrl,
    requiredAuthorization: `Bearer ${helperToken}`,
  });
  const mcpAddress = await listen(mcpServer);
  const mcpUrl = `http://127.0.0.1:${mcpAddress.port}/mcp`;
  const helperPath = path.join(testRoot, 'headers-helper.py');
  await fs.writeFile(helperPath, [
    'import json',
    'import os',
    'token = os.environ["MCP_LOOP_AUTH_TOKEN"]',
    'print(json.dumps({"Authorization": f"Bearer {token}"}))',
    '',
  ].join('\n'));
  const headersHelperRunner = ({ command, env, timeoutMs }) => execFileAsync(
    '/bin/sh',
    ['-lc', command],
    {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      env: { ...process.env, ...env },
    },
  );
  const mcpServers = {
    loopdemo: {
      type: 'http',
      url: mcpUrl,
      headersHelper: `python3 '${helperPath.replaceAll("'", "'\\''")}'`,
      helperEnv: { MCP_LOOP_AUTH_TOKEN: helperToken },
    },
  };
  const qualifiedStatusTool = 'mcp__loopdemo__get_task_status';

  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)');
  database.exec(HOOK_CONFIG_SCHEMA_SQL);
  database.prepare('INSERT INTO users (id, username) VALUES (1, ?)').run('alice');
  database.prepare(`
    INSERT INTO hooks (
      id, name, event_name, created_by, updated_by, status, activation_scope
    ) VALUES ('wait-for-demo-task', '等待模拟任务', 'PostToolUse', 1, 1, 'published', 'all_users')
  `).run();

  try {
    const submitted = await callHookMcpTool({
      qualifiedToolName: 'mcp__loopdemo__execute_task',
      input: { should_fail: false },
      mcpServers,
      cwd: testRoot,
      timeoutMs: 2_000,
      headersHelperRunner,
    });
    assert.equal(submitted.status, 'running');
    assert.ok(submitted.task_id);

    const initialStatus = await callHookMcpTool({
      qualifiedToolName: qualifiedStatusTool,
      input: { task_id: submitted.task_id },
      mcpServers,
      cwd: testRoot,
      timeoutMs: 2_000,
      headersHelperRunner,
    });
    assert.equal(initialStatus.status, 'running');

    let terminalJob = null;
    const loopService = createMcpLoopService({
      database,
      schedulerIntervalMs: 10,
      resolveTargetIdentity: ({ hook }) => ({
        mcpServerId: 'loop-demo-server',
        toolName: hook.matcher.value,
      }),
      callTarget: (job, runtimeContext) => callHookMcpTool({
        qualifiedToolName: qualifiedStatusTool,
        input: job.inputs,
        mcpServers,
        cwd: testRoot,
        timeoutMs: job.perCallTimeoutMs,
        headersHelperRunner: runtimeContext.headersHelperRunner,
      }),
    });
    loopService.setHandlers({
      onTerminal: async (job) => {
        terminalJob = job;
      },
    });

    const hook = {
      id: 'wait-for-demo-task',
      name: '等待模拟任务',
      version: 1,
      eventName: 'PostToolUse',
      matcher: { mode: 'exact', value: qualifiedStatusTool },
      extensionLogic: null,
      postActions: [{
        id: 'wait-until-terminal',
        type: 'mcp_loop_run',
        position: 0,
        config: {
          pollIntervalMs: 30,
          perCallTimeoutMs: 2_000,
          maxWaitMs: 3_000,
          terminationScript: TERMINATION_SCRIPT,
          waitingLabel: '等待 20 分钟模拟任务',
        },
      }],
      claudeResponse: { bindings: {} },
    };

    let scheduledJob;
    const runtime = createHookRuntimeSession({
      hooks: [hook],
      userId: 1,
      workspaceRoot: testRoot,
      database,
      enqueueMcpLoop: async ({ hook: triggeredHook, action, event, executionId, input }) => {
        const scheduled = await loopService.enqueue({
          hook: triggeredHook,
          action,
          executionId,
          userId: 1,
          sessionId: event.session_id,
          toolUseId: event.tool_use_id,
          workspaceRoot: testRoot,
          inputs: input,
          initialResult: event.tool_response,
          runtimeContext: { headersHelperRunner },
        });
        scheduledJob = scheduled.job;
        return { scheduled: scheduled.scheduled, jobId: scheduled.job?.id, status: scheduled.job?.status };
      },
    });

    await runtime.hooks.PostToolUse[0].hooks[0]({
      hook_event_name: 'PostToolUse',
      session_id: 'session-e2e',
      tool_name: qualifiedStatusTool,
      tool_use_id: 'toolu_get_status_e2e',
      tool_input: { task_id: submitted.task_id },
      tool_response: initialStatus,
    }, 'toolu_get_status_e2e', { signal: new AbortController().signal });

    assert.equal(scheduledJob.status, 'queued');
    assert.deepEqual(scheduledJob.inputs, { task_id: submitted.task_id });

    const deadline = Date.now() + 5_000;
    while (!terminalJob && Date.now() < deadline) {
      await wait(20);
      await loopService.tick();
    }
    assert.ok(terminalJob, 'the loop should reach a terminal state');
    assert.equal(terminalJob.status, 'succeeded');
    assert.equal(terminalJob.lastResult.status, 'success');
    assert.equal(terminalJob.toolUseId, 'toolu_get_status_e2e');
    assert.ok(terminalJob.attemptCount >= 1);

    const statusCalls = mcpServer.demoState.calls.filter((call) => call.toolName === 'get_task_status');
    assert.ok(statusCalls.length >= 2, 'one initial query plus at least one loop query is expected');
    assert.ok(statusCalls.every((call) => call.input.task_id === submitted.task_id));

    const replacement = buildMcpLoopReplacement(terminalJob);
    assert.equal(replacement.toolId, 'toolu_get_status_e2e');
    assert.equal(replacement.toolUseResult.status, 'success');
    assert.equal(replacement.payload.replacesToolUseId, 'toolu_get_status_e2e');

    const execution = database.prepare('SELECT status, actions_json FROM hook_executions').get();
    assert.equal(execution.status, 'succeeded');
    const actions = JSON.parse(execution.actions_json);
    assert.equal(actions['wait-until-terminal'].output.scheduled, true);
    assert.equal(actions['wait-until-terminal'].output.jobId, scheduledJob.id);
  } finally {
    database.close();
    await Promise.all([close(mcpServer), close(taskServer)]);
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('mcp_loop_run terminates as failed when the Python script returns failed', async () => {
  const { createMcpLoopService } = await importServerModule('services/mcp-loop-service.js');
  const database = new Database(':memory:');
  let currentTime = 1_000;
  try {
    let terminalJob;
    const loopService = createMcpLoopService({
      database,
      now: () => currentTime,
      createId: () => 'failed-loop-job',
      callTarget: async () => ({ task_id: 'task-failed', status: 'failed' }),
    });
    loopService.setHandlers({ onTerminal: async (job) => { terminalJob = job; } });
    const scheduled = await loopService.enqueue({
      hook: { id: 'failed-hook', name: '等待失败任务' },
      action: {
        id: 'wait',
        config: {
          mcpServerId: 'loop-demo-server',
          toolName: 'mcp__loopdemo__get_task_status',
          pollIntervalMs: 10,
          perCallTimeoutMs: 1_000,
          maxWaitMs: 10_000,
          terminationScript: TERMINATION_SCRIPT,
        },
      },
      executionId: 'failed-execution',
      userId: 1,
      sessionId: 'failed-session',
      toolUseId: 'failed-tool-use',
      workspaceRoot: '/tmp',
      inputs: { task_id: 'task-failed' },
      initialResult: { task_id: 'task-failed', status: 'running' },
    });
    assert.equal(scheduled.scheduled, true);
    currentTime += 10;
    await loopService.tick();
    assert.equal(terminalJob.status, 'failed');
    assert.equal(terminalJob.lastResult.status, 'failed');
  } finally {
    database.close();
  }
});
