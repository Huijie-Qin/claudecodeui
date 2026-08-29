import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { HOOK_CONFIG_SCHEMA_SQL } from '../database/hook-config-schema.js';

import { callHookMcpTool } from './hook-mcp-client.js';
import { createHookRuntimeSession, mergeSdkHooks } from './hook-runtime.js';
import { executeHookScript } from './hook-script-executor.js';

async function loadTestHookSkill(skillId, skillName, argumentsText) {
  assert.equal(skillId, `builtin:${skillName}`);
  return `Run the test Hook Skill.\nHOOK_NOTIFICATION_SKILL_EXECUTED\nPayload: ${argumentsText}\n`;
}

function createDatabase() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)');
  database.exec(HOOK_CONFIG_SCHEMA_SQL);
  database.prepare('INSERT INTO users (id, username) VALUES (1, ?)').run('alice');
  database.prepare(`
    INSERT INTO hooks (
      id, name, event_name, created_by, updated_by, status, activation_scope
    ) VALUES ('hook-1', 'Tool guard', 'PreToolUse', 1, 1, 'published', 'all_users')
  `).run();
  return database;
}

test('configured Hook executes script, MCP action, and assembles Claude output', async () => {
  const database = createDatabase();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-runtime-'));
  try {
    const hook = {
      id: 'hook-1',
      name: 'Tool guard',
      version: 3,
      eventName: 'PreToolUse',
      matcher: { mode: 'exact', value: 'mcp__sms__send' },
      extensionLogic: {
        language: 'javascript',
        code: 'unused in injected executor',
        outputs: [{ name: 'recipient', type: 'string' }],
      },
      postActions: [{
        id: 'notify',
        type: 'call_mcp_tool',
        config: {
          toolName: 'mcp__sms__send',
          inputs: {
            recipient: { source: 'reference', path: 'script.output.recipient' },
            message: { source: 'template', template: 'tool={{event.tool_name}} user={{ccui.env.userId}}' },
          },
        },
      }],
      claudeResponse: {
        bindings: {
          'hookSpecificOutput.additionalContext': {
            source: 'template',
            template: 'sent={{actions.notify.output.sent}}',
          },
          continue: { source: 'literal', value: true },
        },
      },
    };
    let mcpInput;
    const runtime = createHookRuntimeSession({
      hooks: [hook],
      userId: 1,
      username: 'alice',
      tenantId: 2,
      workspaceId: 3,
      workspaceRoot,
      database,
      scriptExecutor: async ({ onRecord, onLog }) => {
        await onRecord('analysis', { rows: 9 });
        await onLog('script ran', { ok: true });
        return { output: { recipient: '13800000000', ignored: 'not declared' } };
      },
      mcpCaller: async ({ input }) => {
        mcpInput = input;
        return { sent: true };
      },
    });

    assert.equal(runtime.hooks.PreToolUse[0].matcher, 'mcp__sms__send');
    const output = await runtime.hooks.PreToolUse[0].hooks[0]({
      hook_event_name: 'PreToolUse',
      session_id: 'session-1',
      tool_name: 'mcp__sms__send',
      tool_input: {},
    }, 'tool-1', { signal: new AbortController().signal });

    assert.deepEqual(mcpInput, {
      recipient: '13800000000',
      message: 'tool=mcp__sms__send user=1',
    });
    assert.deepEqual(output, {
      continue: true,
      hookSpecificOutput: {
        additionalContext: 'sent=true',
        hookEventName: 'PreToolUse',
      },
    });
    const execution = database.prepare('SELECT * FROM hook_executions').get();
    assert.equal(execution.status, 'succeeded');
    assert.ok(Number.isInteger(execution.started_at_ms));
    assert.ok(Number.isInteger(execution.completed_at_ms));
    assert.ok(execution.completed_at_ms >= execution.started_at_ms);
    assert.equal(execution.tool_use_id, 'tool-1');
    assert.equal(JSON.parse(execution.script_output_json).recipient, '13800000000');
    assert.equal(JSON.parse(execution.logs_json)[0].message, 'script ran');
    const record = database.prepare('SELECT * FROM hook_data_records').get();
    assert.equal(record.record_type, 'analysis');
    assert.deepEqual(JSON.parse(record.data_json), { rows: 9 });
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('write_record post action persists mapped Hook data without a script API call', async () => {
  const database = createDatabase();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-runtime-'));
  try {
    const hook = {
      id: 'hook-1',
      name: 'Record completion',
      version: 1,
      eventName: 'Stop',
      matcher: {},
      extensionLogic: null,
      postActions: [{
        id: 'record-stop',
        type: 'write_record',
        config: {
          recordType: 'conversation_completion',
          condition: null,
          fields: {
            sessionId: { source: 'reference', path: 'event.session_id' },
            status: { source: 'literal', value: 'success' },
            userId: { source: 'reference', path: 'ccui.env.userId' },
          },
        },
      }],
      claudeResponse: { bindings: {} },
    };
    const activities = [];
    const runtime = createHookRuntimeSession({
      hooks: [hook],
      userId: 1,
      username: 'alice',
      workspaceRoot,
      database,
      onExecutionActivity: (activity) => activities.push(activity),
    });

    const output = await runtime.executeHook(hook, {
      hook_event_name: 'Stop',
      session_id: 'session-record-1',
      last_assistant_message: 'done',
    });

    assert.deepEqual(output, {});
    const record = database.prepare('SELECT * FROM hook_data_records').get();
    assert.equal(record.record_type, 'conversation_completion');
    assert.deepEqual(JSON.parse(record.data_json), {
      sessionId: 'session-record-1',
      status: 'success',
      userId: 1,
    });
    const execution = database.prepare('SELECT actions_json FROM hook_executions').get();
    const actionOutput = JSON.parse(execution.actions_json)['record-stop'].output;
    assert.equal(actionOutput.recorded, true);
    assert.equal(actionOutput.type, 'conversation_completion');
    assert.deepEqual(actionOutput.data, {
      sessionId: 'session-record-1',
      status: 'success',
      userId: 1,
    });
    assert.deepEqual(activities.at(-1).actions['record-stop'].output.data, {
      sessionId: 'session-record-1',
      status: 'success',
      userId: 1,
    });
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('write_record condition can skip persistence before resolving record fields', async () => {
  const database = createDatabase();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-runtime-'));
  try {
    const hook = {
      id: 'hook-1',
      name: 'Conditional record',
      version: 1,
      eventName: 'Stop',
      matcher: {},
      extensionLogic: {
        language: 'javascript',
        code: 'unused in injected executor',
        outputs: [{ name: 'detected', type: 'boolean' }],
      },
      postActions: [{
        id: 'record-if-detected',
        type: 'write_record',
        config: {
          recordType: 'conditional_record',
          condition: { source: 'reference', path: 'script.output.detected' },
          fields: {
            missingWhenSkipped: { source: 'reference', path: 'script.output.notDeclared' },
          },
        },
      }],
      claudeResponse: { bindings: {} },
    };
    const runtime = createHookRuntimeSession({
      hooks: [hook],
      userId: 1,
      workspaceRoot,
      database,
      scriptExecutor: async () => ({ output: { detected: false } }),
    });

    await runtime.executeHook(hook, {
      hook_event_name: 'Stop',
      session_id: 'session-record-skip',
    });

    assert.equal(database.prepare('SELECT COUNT(*) AS total FROM hook_data_records').get().total, 0);
    const execution = database.prepare('SELECT status, actions_json FROM hook_executions').get();
    assert.equal(execution.status, 'succeeded');
    assert.deepEqual(JSON.parse(execution.actions_json)['record-if-detected'].output, {
      recorded: false,
      reason: 'condition_false',
    });
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('call_mcp_tool condition skips the tool before resolving inputs', async () => {
  const database = createDatabase();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-runtime-'));
  try {
    const hook = {
      id: 'hook-1',
      name: 'Conditional SQL syntax check',
      version: 1,
      eventName: 'Stop',
      matcher: {},
      extensionLogic: {
        language: 'javascript',
        code: 'unused in injected executor',
        outputs: [{ name: 'detected', type: 'boolean' }],
      },
      postActions: [{
        id: 'check-sql-if-detected',
        type: 'call_mcp_tool',
        config: {
          toolName: 'mcp__sql-syntax-checker__check_sql_syntax',
          condition: { source: 'reference', path: 'script.output.detected' },
          inputs: {
            sql: { source: 'reference', path: 'script.output.notNeededWhenSkipped' },
          },
        },
      }],
      claudeResponse: { bindings: {} },
    };
    let callCount = 0;
    const runtime = createHookRuntimeSession({
      hooks: [hook],
      userId: 1,
      workspaceRoot,
      database,
      scriptExecutor: async () => ({ output: { detected: false } }),
      mcpCaller: async () => {
        callCount += 1;
        return { valid: true };
      },
    });

    await runtime.executeHook(hook, {
      hook_event_name: 'Stop',
      session_id: 'session-mcp-skip',
    });

    assert.equal(callCount, 0);
    const execution = database.prepare('SELECT status, actions_json FROM hook_executions').get();
    assert.equal(execution.status, 'succeeded');
    assert.deepEqual(JSON.parse(execution.actions_json)['check-sql-if-detected'].output, {
      called: false,
      reason: 'condition_false',
    });
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('mcp_loop_run reuses the complete input from the Matcher-triggering tool call', async () => {
  const database = createDatabase();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-runtime-'));
  try {
    const hook = {
      id: 'hook-1',
      name: 'Wait for status',
      version: 1,
      eventName: 'PostToolUse',
      matcher: { value: 'mcp__tasks__get_task_status' },
      extensionLogic: null,
      postActions: [{
        id: 'wait-for-status',
        type: 'mcp_loop_run',
        config: {
          pollIntervalMs: 10_000,
          perCallTimeoutMs: 15_000,
          maxWaitMs: 300_000,
          terminationScript: 'async def run(event, ccui):\n    return {"output": {"status": "running"}}\n',
        },
      }],
      claudeResponse: { bindings: {} },
    };
    let loopRequest;
    const runtime = createHookRuntimeSession({
      hooks: [hook],
      userId: 1,
      workspaceRoot,
      database,
      enqueueMcpLoop: async (request) => {
        loopRequest = request;
        return { scheduled: true, jobId: 'loop-job' };
      },
    });

    await runtime.executeHook(hook, {
      hook_event_name: 'PostToolUse',
      session_id: 'session-loop',
      tool_name: 'mcp__tasks__get_task_status',
      tool_use_id: 'tool-loop',
      tool_input: { task_id: 'task-123', options: { verbose: true } },
      tool_response: { status: 'running' },
    });

    assert.deepEqual(loopRequest.input, {
      task_id: 'task-123',
      options: { verbose: true },
    });
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('SQL Check Hook sends the effective workspace rule IDs to its MCP tool', async () => {
  const database = createDatabase();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-runtime-'));
  try {
    const hook = {
      id: 'hook-1',
      name: 'SQL Check 强制校验',
      version: 1,
      bindingController: 'sql_check',
      eventName: 'Stop',
      matcher: {},
      extensionLogic: null,
      postActions: [{
        id: 'check-sql',
        type: 'call_mcp_tool',
        config: {
          toolName: 'mcp__sql-syntax-checker__check_sql_syntax',
          inputs: {
            sql: { source: 'reference', path: 'event.last_assistant_message' },
          },
        },
      }],
      claudeResponse: { bindings: {} },
    };
    let mcpInput;
    const runtime = createHookRuntimeSession({
      hooks: [hook],
      userId: 1,
      tenantId: 2,
      workspaceId: 3,
      sqlCheckRuleIds: ['require_where', 'limit_rows'],
      workspaceRoot,
      database,
      mcpCaller: async ({ input }) => {
        mcpInput = input;
        return { valid: true };
      },
    });

    await runtime.executeHook(hook, {
      hook_event_name: 'Stop',
      session_id: 'session-sql-check',
      last_assistant_message: '```sql\nSELECT * FROM users;\n```',
    });

    assert.deepEqual(mcpInput, {
      sql: '```sql\nSELECT * FROM users;\n```',
      rule_ids: ['require_where', 'limit_rows'],
    });
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Hook failures are audited and fail open to Claude', async () => {
  const database = createDatabase();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-runtime-'));
  try {
    const hook = {
      id: 'hook-1',
      name: 'Broken Hook',
      version: 1,
      eventName: 'PreToolUse',
      matcher: {},
      extensionLogic: {
        language: 'javascript',
        code: 'throw',
        outputs: [],
      },
      postActions: [],
      claudeResponse: { bindings: { continue: { source: 'literal', value: false } } },
    };
    const runtime = createHookRuntimeSession({
      hooks: [hook],
      userId: 1,
      workspaceRoot,
      database,
      scriptExecutor: async () => {
        throw new Error('script exploded');
      },
    });
    const output = await runtime.executeHook(hook, {
      hook_event_name: 'PreToolUse',
      session_id: 'session-2',
      tool_input: { apiToken: 'should-not-be-audited' },
    });
    assert.deepEqual(output, {});
    const execution = database.prepare('SELECT status, error_message, input_json FROM hook_executions').get();
    assert.equal(execution.status, 'failed');
    assert.match(execution.error_message, /script exploded/);
    assert.equal(JSON.parse(execution.input_json).tool_input.apiToken, '[redacted]');
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('StopFailure Skill recovery appends one new turn and never returns fields to Claude', async () => {
  const database = createDatabase();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-runtime-'));
  try {
    const hook = {
      id: 'hook-1',
      name: 'Recover failure',
      version: 1,
      eventName: 'StopFailure',
      matcher: {},
      extensionLogic: null,
      postActions: [{
        id: 'recover',
        type: 'invoke_skill',
        config: {
          skillId: 'builtin:hook-notification',
          skillName: 'hook-notification',
          argumentsTemplate: 'user={{ccui.env.userId}} error={{event.error_details}}',
        },
      }],
      claudeResponse: { bindings: {} },
    };
    const scheduled = [];
    const runtime = createHookRuntimeSession({
      hooks: [hook],
      userId: 1,
      workspaceRoot,
      database,
      skillContentLoader: loadTestHookSkill,
      enqueueSkillRecovery: async (request) => scheduled.push(request),
    });
    const event = {
      hook_event_name: 'StopFailure',
      session_id: 'failed-session',
      error: 'server_error',
      error_details: 'rate limited',
    };
    assert.deepEqual(await runtime.executeHook(hook, event), {});
    assert.deepEqual(await runtime.executeHook(hook, event), {});
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].displayCommand, '/hook-notification user=1 error=rate limited');
    assert.match(scheduled[0].modelContent, /Payload: user=1 error=rate limited/);
    assert.doesNotMatch(scheduled[0].modelContent, /agent turns?/i);
    const executions = database.prepare('SELECT status, actions_json FROM hook_executions ORDER BY rowid').all();
    assert.equal(executions.length, 2);
    assert.equal(JSON.parse(executions[1].actions_json).recover.output.reason, 'already_scheduled');
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('invoke_skill skips recovery when its condition resolves to false', async () => {
  const database = createDatabase();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-runtime-'));
  try {
    const hook = {
      id: 'hook-1',
      name: 'Recover only HTTP 200 failures',
      version: 1,
      eventName: 'StopFailure',
      matcher: {},
      extensionLogic: {
        language: 'javascript',
        code: 'export async function run() { return { output: { shouldRecover: false } }; }',
        outputs: [{ name: 'shouldRecover', type: 'boolean' }],
      },
      postActions: [{
        id: 'recover',
        type: 'invoke_skill',
        config: {
          skillId: 'builtin:hook-notification',
          skillName: 'hook-notification',
          condition: { source: 'reference', path: 'script.output.shouldRecover' },
          argumentsTemplate: 'details={{event.error_details}}',
        },
      }],
      claudeResponse: { bindings: {} },
    };
    const scheduled = [];
    const runtime = createHookRuntimeSession({
      hooks: [hook],
      userId: 1,
      workspaceRoot,
      database,
      skillContentLoader: loadTestHookSkill,
      enqueueSkillRecovery: async (request) => scheduled.push(request),
    });

    assert.deepEqual(await runtime.executeHook(hook, {
      hook_event_name: 'StopFailure',
      session_id: 'failed-session',
      error: 'server_error',
      error_details: 'rate limited',
    }), {});
    assert.equal(scheduled.length, 0);
    const execution = database.prepare('SELECT actions_json FROM hook_executions').get();
    assert.deepEqual(JSON.parse(execution.actions_json).recover.output, {
      scheduled: false,
      reason: 'condition_false',
    });
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Stop Skill action appends a new turn after a normal answer and keeps the Stop response', async () => {
  const database = createDatabase();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-runtime-'));
  try {
    const hook = {
      id: 'hook-1',
      name: 'Continue after normal answer',
      version: 1,
      eventName: 'Stop',
      matcher: {},
      extensionLogic: null,
      postActions: [{
        id: 'continue-with-skill',
        type: 'invoke_skill',
        config: {
          skillId: 'builtin:hook-notification',
          skillName: 'hook-notification',
          argumentsTemplate: '{{ccui.env.userId}}',
        },
      }],
      claudeResponse: {
        bindings: { systemMessage: { source: 'literal', value: 'normal answer completed' } },
      },
    };
    const scheduled = [];
    const runtime = createHookRuntimeSession({
      hooks: [hook],
      userId: 1,
      workspaceRoot,
      database,
      skillContentLoader: loadTestHookSkill,
      enqueueSkillRecovery: async (request) => {
        scheduled.push(request);
        return { queuePosition: 1, status: 'queued', executionMode: 'original_session' };
      },
    });
    const output = await runtime.executeHook(hook, {
      hook_event_name: 'Stop',
      session_id: 'completed-session',
      stop_hook_active: false,
      last_assistant_message: 'done',
    });
    assert.deepEqual(output, { systemMessage: 'normal answer completed' });
    assert.equal(scheduled.length, 1);
    assert.equal(typeof scheduled[0].executionId, 'string');
    assert.equal(scheduled[0].argumentsText, '1');
    assert.equal(scheduled[0].displayCommand, '/hook-notification 1');
    assert.match(scheduled[0].modelContent, /Payload: 1/);
    const execution = database.prepare(
      'SELECT actions_json FROM hook_executions ORDER BY rowid DESC LIMIT 1',
    ).get();
    assert.deepEqual(JSON.parse(execution.actions_json)['continue-with-skill'].output, {
      scheduled: true,
      skillName: 'hook-notification',
      queuePosition: 1,
      status: 'queued',
      executionMode: 'original_session',
    });
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Stop Agent message action queues a templated next turn without loading a Skill', async () => {
  const database = createDatabase();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-runtime-'));
  try {
    const hook = {
      id: 'hook-1',
      name: 'Continue directly',
      version: 1,
      eventName: 'Stop',
      matcher: {},
      extensionLogic: null,
      postActions: [{
        id: 'follow-up',
        type: 'send_agent_message',
        config: {
          condition: null,
          messageTemplate: '继续分析会话 {{event.session_id}}，用户 {{ccui.env.userId}}',
        },
      }],
      claudeResponse: { bindings: {} },
    };
    const scheduled = [];
    let skillLoads = 0;
    const runtime = createHookRuntimeSession({
      hooks: [hook],
      userId: 1,
      workspaceRoot,
      database,
      skillContentLoader: async () => {
        skillLoads += 1;
        return 'unexpected';
      },
      enqueueAgentMessage: async (request) => {
        scheduled.push(request);
        return { queuePosition: 1, status: 'queued' };
      },
    });
    const event = {
      hook_event_name: 'Stop',
      session_id: 'session-direct',
      stop_hook_active: false,
      last_assistant_message: 'done',
    };
    assert.deepEqual(await runtime.executeHook(hook, event), {});
    assert.deepEqual(await runtime.executeHook(hook, event), {});
    assert.equal(skillLoads, 0);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].messageText, '继续分析会话 session-direct，用户 1');
    const messageLength = scheduled[0].messageText.length;
    const executions = database.prepare('SELECT actions_json FROM hook_executions ORDER BY rowid').all();
    assert.deepEqual(JSON.parse(executions[0].actions_json)['follow-up'].output, {
      scheduled: true,
      messageLength,
      queuePosition: 1,
      status: 'queued',
    });
    assert.equal(JSON.parse(executions[1].actions_json)['follow-up'].output.reason, 'already_scheduled');
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('every Hook execution reports one activity lifecycle even without a follow-up action', async () => {
  const database = createDatabase();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-runtime-'));
  try {
    const hook = {
      id: 'hook-1',
      name: 'Record completion',
      description: 'Persist completion metadata',
      version: 1,
      eventName: 'Stop',
      matcher: {},
      extensionLogic: null,
      postActions: [],
      claudeResponse: { bindings: {} },
    };
    const activities = [];
    const runtime = createHookRuntimeSession({
      hooks: [hook],
      userId: 1,
      workspaceRoot,
      database,
      onExecutionActivity: (activity) => activities.push(activity),
    });

    await runtime.executeHook(hook, {
      hook_event_name: 'Stop',
      session_id: 'session-activity',
      last_assistant_message: 'done',
    });

    assert.deepEqual(activities.map((activity) => activity.status), ['running', 'succeeded']);
    assert.equal(activities[0].executionId, activities[1].executionId);
    assert.equal(activities[0].hook.id, 'hook-1');
    assert.equal(activities[0].event.session_id, 'session-activity');
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Hook Skill action uses the configured content loader without creating a workspace copy', async () => {
  const database = createDatabase();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-runtime-'));
  try {
    const hook = {
      id: 'hook-1',
      name: 'Notify on completion',
      version: 1,
      eventName: 'Stop',
      matcher: {},
      extensionLogic: null,
      postActions: [{
        id: 'notify',
        type: 'invoke_skill',
        config: {
          skillId: 'builtin:hook-notification',
          skillName: 'hook-notification',
          argumentsTemplate: 'status=success session={{event.session_id}}',
        },
      }],
      claudeResponse: { bindings: {} },
    };
    const scheduled = [];
    const runtime = createHookRuntimeSession({
      hooks: [hook],
      userId: 1,
      workspaceRoot,
      database,
      skillContentLoader: loadTestHookSkill,
      enqueueSkillRecovery: async (request) => scheduled.push(request),
    });
    await runtime.executeHook(hook, {
      hook_event_name: 'Stop',
      session_id: 'completed-session',
      stop_hook_active: false,
      last_assistant_message: 'done',
    });
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].displayCommand, '/hook-notification status=success session=completed-session');
    assert.match(scheduled[0].modelContent, /HOOK_NOTIFICATION_SKILL_EXECUTED/);
    assert.match(scheduled[0].modelContent, /Payload: status=success session=completed-session/);
    await assert.rejects(
      fs.access(path.join(workspaceRoot, '.claude', 'skills', 'hook-notification', 'SKILL.md')),
    );
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('JavaScript Hook worker exposes only controlled workspace APIs', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-script-'));
  try {
    const result = await executeHookScript({
      hookId: 'worker-test',
      language: 'javascript',
      workspaceRoot,
      event: { value: 'hello' },
      env: { userId: 1 },
      code: `export async function run(event, ccui) {
        await ccui.workspace.writeText('result.txt', event.value);
        return { output: { value: await ccui.workspace.readText('result.txt'), userId: ccui.env.userId } };
      }`,
    });
    assert.deepEqual(result, { output: { value: 'hello', userId: 1 } });
    await assert.rejects(
      executeHookScript({
        hookId: 'escape-test',
        language: 'javascript',
        workspaceRoot,
        event: {},
        env: {},
        code: `export async function run(event, ccui) { await ccui.workspace.readText('../outside.txt'); }`,
      }),
      /inside the current workspace/,
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Python Hook process exposes the same controlled workspace, environment, and record APIs', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-python-'));
  const records = [];
  try {
    const result = await executeHookScript({
      hookId: 'python-test',
      language: 'python',
      workspaceRoot,
      event: { value: 'hello from python' },
      env: { userId: 7 },
      onRecord: async (recordType, data) => {
        records.push({ recordType, data });
        return { id: records.length };
      },
      code: `async def run(event, ccui):
    await ccui.workspace.write_text("python-result.txt", event["value"])
    value = await ccui.workspace.read_text("python-result.txt")
    await ccui.records.write("python_scenario", {"value": value})
    return {"output": {"value": value, "userId": ccui.env.userId}}`,
    });
    assert.deepEqual(result, { output: { value: 'hello from python', userId: 7 } });
    assert.deepEqual(records, [
      { recordType: 'python_scenario', data: { value: 'hello from python' } },
    ]);
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'python-result.txt'), 'utf8'), 'hello from python');
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Hook MCP runner performs a real direct stdio tool call without a model turn', async () => {
  const serverCode = `
    import { Server } from '@modelcontextprotocol/sdk/server/index.js';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
    import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
    const server = new Server(
      { name: 'hook-test-server', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => ({
      content: [{ type: 'text', text: JSON.stringify({ echoed: request.params.arguments.value }) }],
    }));
    await server.connect(new StdioServerTransport());
  `;
  const output = await callHookMcpTool({
    qualifiedToolName: 'mcp__test_server__echo',
    input: { value: 'hello' },
    mcpServers: {
      test_server: {
        command: process.execPath,
        args: ['--input-type=module', '-e', serverCode],
      },
    },
    cwd: process.cwd(),
  });
  assert.deepEqual(output, { echoed: 'hello' });
});

test('mergeSdkHooks preserves built-in and configured callbacks', () => {
  const builtIn = { PreToolUse: [{ matcher: 'mcp__.*', hooks: [async () => ({})] }] };
  const configured = {
    PreToolUse: [{ matcher: 'Bash', hooks: [async () => ({})] }],
    Stop: [{ hooks: [async () => ({})] }],
  };
  const merged = mergeSdkHooks(builtIn, configured);
  assert.equal(merged.PreToolUse.length, 2);
  assert.equal(merged.Stop.length, 1);
});
