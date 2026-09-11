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

test('subagent inheritance filters tool callbacks before scripts, variables, or audit side effects', async () => {
  for (const eventName of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']) {
    for (const includeSubagents of [false, true, undefined]) {
      const database = createDatabase();
      const executed = [];
      const hook = {
        id: 'hook-1', eventName, includeSubagents, matcher: { value: 'Bash' },
        extensionLogic: { language: 'javascript', code: 'test' },
      };
      try {
        const runtime = createHookRuntimeSession({ hooks: [hook], database,
          scriptExecutor: async ({ event }) => { executed.push(event.agent_id || 'main'); return {}; },
        });
        assert.equal(runtime.hooks[eventName][0].matcher, 'Bash');
        const callback = runtime.hooks[eventName][0].hooks[0];
        for (const agentId of [undefined, 'child-a', 'child-b']) {
          await callback({ hook_event_name: eventName, agent_id: agentId, agent_type: 'code-reviewer' });
        }
        const expected = includeSubagents === false ? ['main'] : ['main', 'child-a', 'child-b'];
        assert.deepEqual(executed, expected);
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM hook_executions').get().count, expected.length);
      } finally { database.close(); }
    }
  }
});

test('inherited Stop runs once per child as SubagentStop and preserves original script input', async () => {
  const database = createDatabase();
  const seen = [];
  const hook = { id: 'hook-1', eventName: 'Stop', includeSubagents: true,
    extensionLogic: { language: 'javascript', code: 'test' },
  };
  try {
    const runtime = createHookRuntimeSession({ hooks: [hook], database,
      scriptExecutor: async ({ event }) => { seen.push(event); return {}; },
    });
    assert.equal(runtime.hooks.Stop.length, 1);
    assert.equal(runtime.hooks.SubagentStop.length, 1);
    assert.equal(runtime.hooks.SubagentStop[0].matcher, undefined);
    await runtime.hooks.Stop[0].hooks[0]({ hook_event_name: 'Stop', agent_type: 'reviewer' });
    for (const agentId of ['child-a', 'child-b']) {
      await runtime.hooks.Stop[0].hooks[0]({ hook_event_name: 'Stop', agent_id: agentId });
      await runtime.hooks.SubagentStop[0].hooks[0]({ hook_event_name: 'SubagentStop', agent_id: agentId });
    }
    assert.deepEqual(seen.map((event) => event.hook_event_name), ['Stop', 'SubagentStop', 'SubagentStop']);
    assert.deepEqual(database.prepare('SELECT event_name FROM hook_executions ORDER BY rowid').all()
      .map((row) => row.event_name), ['Stop', 'SubagentStop', 'SubagentStop']);
    for (const includeSubagents of [false, undefined]) {
      const direct = createHookRuntimeSession({ hooks: [{ ...hook, includeSubagents }], database });
      assert.equal(direct.hooks.SubagentStop, undefined);
    }
  } finally { database.close(); }
});

test('explicit subagent lifecycle hooks remain active regardless of inheritance toggle', async () => {
  const database = createDatabase();
  try {
    for (const eventName of ['SubagentStart', 'SubagentStop']) {
      for (const includeSubagents of [false, true, undefined]) {
        let executions = 0;
        const hook = { id: 'hook-1', eventName, includeSubagents,
          extensionLogic: { language: 'javascript', code: 'test' },
        };
        const runtime = createHookRuntimeSession({ hooks: [hook], database,
          scriptExecutor: async () => { executions += 1; return {}; },
        });
        await runtime.hooks[eventName][0].hooks[0]({ hook_event_name: eventName, agent_id: 'child' });
        assert.equal(executions, 1);
        assert.equal(runtime.hooks[eventName].length, 1);
      }
    }
  } finally { database.close(); }
});

test('inherited Stop sends messages and materialized Skills to each child without queueing the main session', async () => {
  const database = createDatabase();
  const preparedAgents = [];
  const mainMessages = [];
  const hook = {
    id: 'hook-1', eventName: 'Stop', includeSubagents: true,
    postActions: [
      { id: 'message', type: 'send_agent_message', config: { messageTemplate: 'Review {{event.agent_id}}' } },
      { id: 'skill', type: 'invoke_skill', config: { skillId: 'builtin:test', skillName: 'test', argumentsTemplate: '{{event.agent_id}}' } },
    ],
  };
  try {
    const runtime = createHookRuntimeSession({ hooks: [hook], database,
      skillContentLoader: loadTestHookSkill,
      prepareSubagentSkillRecovery: async ({ event, modelContent }) => {
        preparedAgents.push(event.agent_id);
        return `Skill root: /workspace/.cloudcli/hook-config/skills/test\n${modelContent}`;
      },
      enqueueAgentMessage: async (request) => { mainMessages.push(request); },
      enqueueSkillRecovery: async () => assert.fail('Child Skill must not enqueue main session'),
    });
    const callback = runtime.hooks.SubagentStop[0].hooks[0];
    for (const agentId of ['child-a', 'child-b']) {
      const event = { hook_event_name: 'SubagentStop', agent_id: agentId, stop_hook_active: false };
      const response = await callback(event);
      assert.equal(response.decision, 'block');
      assert.match(response.reason, new RegExp(`Review ${agentId}`));
      assert.match(response.reason, /Skill root: \/workspace/);
      assert.match(response.reason, /HOOK_NOTIFICATION_SKILL_EXECUTED/);
      assert.deepEqual(await callback(event), {}, 'Same child does not receive duplicate followups');
    }
    assert.deepEqual(mainMessages, []);
    assert.deepEqual(preparedAgents, ['child-a', 'child-b']);
    assert.deepEqual(await callback({ hook_event_name: 'SubagentStop', agent_id: 'recovery-child', stop_hook_active: true }), {});
    assert.deepEqual(preparedAgents, ['child-a', 'child-b']);
  } finally { database.close(); }
});

test('required inherited Stop checks fail closed on child script and audit errors', async () => {
  for (const failAudit of [false, true]) {
    const database = createDatabase();
    const hook = { id: 'hook-1', eventName: 'Stop', includeSubagents: true,
      extensionLogic: { language: 'javascript', code: 'validate', failClosed: true },
    };
    try {
      const runtime = createHookRuntimeSession({ hooks: [hook],
        database: failAudit ? { prepare: () => { throw new Error('Audit unavailable'); } } : database,
        scriptExecutor: async () => { throw new Error('Validation unavailable'); },
      });
      assert.equal(runtime.hasRequiredStopHook, true);
      const response = await runtime.hooks.SubagentStop[0].hooks[0]({ hook_event_name: 'SubagentStop', agent_id: 'child' });
      assert.equal(response.continue, false);
      assert.equal(response.decision, undefined);
    } finally { database.close(); }
  }
});

test('concurrent Stop callbacks deliver a recovery Skill only once to the same child', async () => {
  const database = createDatabase();
  let prepared = 0;
  const hook = { id: 'hook-1', eventName: 'Stop', includeSubagents: true,
    postActions: [{ id: 'skill', type: 'invoke_skill', config: { skillId: 'builtin:test', skillName: 'test', argumentsTemplate: '' } }],
  };
  try {
    const runtime = createHookRuntimeSession({ hooks: [hook], database,
      skillContentLoader: loadTestHookSkill,
      prepareSubagentSkillRecovery: async ({ modelContent }) => { prepared += 1; return modelContent; },
    });
    const callback = runtime.hooks.SubagentStop[0].hooks[0];
    const event = { hook_event_name: 'SubagentStop', agent_id: 'child-a' };
    const responses = await Promise.all([callback(event), callback(event)]);
    assert.equal(prepared, 1);
    assert.equal(responses.filter((response) => response.decision === 'block').length, 1);
  } finally { database.close(); }
});

test('subagent MCP loops return the final tool output to the same child without scheduling the root', async () => {
  const database = createDatabase();
  const waits = new Map();
  const hook = { id: 'hook-1', eventName: 'PostToolUse', includeSubagents: true,
    matcher: { value: 'mcp__status__poll' },
    postActions: [{ id: 'loop', type: 'mcp_loop_run', config: {
      pollIntervalMs: 1, perCallTimeoutMs: 100, maxWaitMs: 2000,
      successWhen: { field: 'status', equals: 'done' },
    } }],
  };
  try {
    const runtime = createHookRuntimeSession({ hooks: [hook], database,
      onSubagentLoopWait: ({ id, waiting }) => {
        if (waiting) waits.set(id, true);
        else assert.equal(waits.delete(id), true, 'Every wait releases exactly once');
      },
      resolveMcpAction: async ({ action }) => {
        assert.equal(action.config.toolName, hook.matcher.value);
        return { qualifiedToolName: action.config.toolName };
      },
      mcpCaller: async ({ input }) => ({ status: 'done', child: input.child }),
      enqueueMcpLoop: async () => assert.fail('Child loop must not schedule root'),
    });
    assert.equal(runtime.hooks.PostToolUse[0].timeout, 62);
    const responses = await Promise.all(['child-a', 'child-b'].map((agentId) => runtime.hooks.PostToolUse[0].hooks[0]({
      hook_event_name: 'PostToolUse', agent_id: agentId, tool_use_id: `${agentId}-tool`,
      tool_input: { child: agentId }, tool_response: { status: 'running' },
    })));
    assert.deepEqual(responses.map((response) => response.hookSpecificOutput.updatedMCPToolOutput), [
      [{ type: 'text', text: JSON.stringify({ status: 'done', child: 'child-a' }) }],
      [{ type: 'text', text: JSON.stringify({ status: 'done', child: 'child-b' }) }],
    ]);
    assert.equal(waits.size, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM hook_data_records WHERE record_type = 'mcp_loop_attempt'").get().count, 4);
  } finally { database.close(); }
});

test('a failed subagent loop hook releases the stream watchdog wait', async () => {
  const transitions = [];
  const hook = { id: 'broken-audit', eventName: 'PostToolUse', includeSubagents: true,
    postActions: [{ id: 'loop', type: 'mcp_loop_run', config: { maxWaitMs: 2000 } }],
  };
  const runtime = createHookRuntimeSession({ hooks: [hook],
    database: { prepare: () => { throw new Error('Audit unavailable'); } },
    onSubagentLoopWait: (transition) => transitions.push(transition),
  });
  await assert.rejects(runtime.hooks.PostToolUse[0].hooks[0]({
    hook_event_name: 'PostToolUse', agent_id: 'child',
  }), /Audit unavailable/);
  assert.deepEqual(transitions.map(({ waiting }) => waiting), [true, false]);
  assert.equal(transitions[0].id, transitions[1].id);
});

test('required Stop checks still terminate if the audit database is unavailable', async () => {
  const hook = {
    id: 'broken-audit', eventName: 'Stop',
    extensionLogic: { language: 'javascript', code: 'unused', failClosed: true },
  };
  const runtime = createHookRuntimeSession({
    hooks: [hook], workspaceRoot: process.cwd(), userId: 1,
    database: { prepare: () => { throw new Error('Database is unavailable'); } },
  });
  const response = await runtime.hooks.Stop[0].hooks[0]({ hook_event_name: 'Stop', session_id: 'audit-failure' });
  assert.equal(response.continue, false);
  assert.match(response.stopReason, /验收记录/);
});

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

test('fail-closed Stop errors terminate execution and audit the exact response', async () => {
  const database = createDatabase();
  const hook = {
    id: 'hook-1', name: 'Report validator', version: 1, eventName: 'Stop', matcher: {},
    extensionLogic: { language: 'javascript', code: 'validate', outputs: [], failClosed: true },
    postActions: [], claudeResponse: { bindings: {} },
  };
  try {
    const runtime = createHookRuntimeSession({
      hooks: [hook], userId: 1, database,
      scriptExecutor: async () => { throw new Error('validator failed with private details'); },
    });
    assert.equal(runtime.hasRequiredStopHook, true);
    const response = await runtime.executeHook(hook, { hook_event_name: 'Stop', session_id: 'report-session' });
    assert.equal(response.continue, false);
    assert.match(response.stopReason, /校验失败/);
    assert.doesNotMatch(response.stopReason, /private details/);
    assert.equal(response.decision, undefined, 'A broken validator terminates; it does not ask the agent to retry indefinitely');
    const audit = database.prepare('SELECT status, response_json FROM hook_executions').get();
    assert.equal(audit.status, 'failed');
    assert.deepEqual(JSON.parse(audit.response_json), response);
  } finally { database.close(); }
});

test('legacy Stop and non-Stop hooks retain their existing fail-open behavior', async () => {
  for (const [eventName, failClosed] of [['Stop', undefined], ['Stop', false], ['StopFailure', true], ['PreToolUse', true]]) {
    const database = createDatabase();
    const hook = {
      id: 'hook-1', name: 'Optional Hook', version: 1, eventName, matcher: {},
      extensionLogic: { language: 'javascript', code: 'validate', outputs: [], failClosed },
      postActions: [], claudeResponse: { bindings: {} },
    };
    try {
      const runtime = createHookRuntimeSession({
        hooks: [hook], userId: 1, database,
        scriptExecutor: async () => { throw new Error('optional failure'); },
      });
      assert.equal(runtime.hasRequiredStopHook, false);
      assert.deepEqual(await runtime.executeHook(hook, { hook_event_name: eventName }), {});
      assert.deepEqual(JSON.parse(database.prepare('SELECT response_json FROM hook_executions').get().response_json), {});
    } finally { database.close(); }
  }
});

test('required Stop checks can block repeatedly and then pass in the same runtime', async () => {
  const database = createDatabase();
  const hook = {
    id: 'hook-1', name: 'Report validator', version: 1, eventName: 'Stop', matcher: {},
    extensionLogic: {
      language: 'javascript', code: 'validate', failClosed: true,
      outputs: [{ name: 'decision', type: 'string' }, { name: 'reason', type: 'string' }],
    },
    postActions: [],
    claudeResponse: { bindings: {
      decision: { source: 'reference', path: 'script.output.decision' },
      reason: { source: 'reference', path: 'script.output.reason' },
    } },
  };
  let attempts = 0;
  try {
    const runtime = createHookRuntimeSession({
      hooks: [hook], userId: 1, database,
      scriptExecutor: async () => ({ output: ++attempts < 3 ? { decision: 'block', reason: 'Missing required report section' } : {} }),
    });
    for (const stop_hook_active of [false, true]) {
      assert.deepEqual(await runtime.executeHook(hook, { hook_event_name: 'Stop', session_id: 'same-session', stop_hook_active }), {
        decision: 'block', reason: 'Missing required report section',
      });
    }
    assert.deepEqual(await runtime.executeHook(hook, { hook_event_name: 'Stop', session_id: 'same-session', stop_hook_active: true }), {});
    assert.equal(attempts, 3);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM hook_executions').get().count, 3);
  } finally { database.close(); }
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

test('Python Hook imports are limited to the server environment allowlist', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-python-imports-'));
  const envName = 'CCUI_HOOK_PYTHON_IMPORT_ALLOWLIST';
  const previousAllowlist = process.env[envName];
  try {
    delete process.env[envName];
    await assert.rejects(
      executeHookScript({
        hookId: 'python-import-default-deny',
        language: 'python',
        workspaceRoot,
        event: {},
        env: {},
        code: 'import json\n\nasync def run(event, ccui):\n    return {"output": {"ok": True}}',
      }),
      /json is not allowed by CCUI_HOOK_PYTHON_IMPORT_ALLOWLIST/,
    );

    process.env[envName] = 'json,re,math,datetime';
    const result = await executeHookScript({
      hookId: 'python-import-allowlist',
      language: 'python',
      workspaceRoot,
      event: { value: 'task-42' },
      env: {},
      code: `import json
import math
import re
from datetime import datetime

async def run(event, ccui):
    matched = re.fullmatch(r"task-\\d+", event["value"]) is not None
    return {"output": {
        "json": json.dumps({"matched": matched}),
        "root": math.sqrt(81),
        "year": datetime(2026, 1, 1).year,
    }}`,
    });
    assert.deepEqual(result, {
      output: { json: '{"matched": true}', root: 9, year: 2026 },
    });

    await assert.rejects(
      executeHookScript({
        hookId: 'python-import-blocked',
        language: 'python',
        workspaceRoot,
        event: {},
        env: {},
        code: 'import os\n\nasync def run(event, ccui):\n    return {"output": {"ok": True}}',
      }),
      /os is not allowed by CCUI_HOOK_PYTHON_IMPORT_ALLOWLIST/,
    );
    await assert.rejects(
      executeHookScript({
        hookId: 'python-submodule-blocked',
        language: 'python',
        workspaceRoot,
        event: {},
        env: {},
        code: 'import json.tool\n\nasync def run(event, ccui):\n    return {"output": {"ok": True}}',
      }),
      /json\.tool is not allowed by CCUI_HOOK_PYTHON_IMPORT_ALLOWLIST/,
    );
  } finally {
    if (previousAllowlist === undefined) delete process.env[envName];
    else process.env[envName] = previousAllowlist;
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

for (const language of ['javascript', 'python']) {
  test(`${language} Hooks pass personal variables to scripts and Skills while redacting audit and display values`, async () => {
    const database = createDatabase();
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-user-variables-'));
    const secret = 'personal-secret-123';
    const queued = [];
    const activities = [];
    try {
      const hook = {
        id: 'hook-1', version: 1, name: 'Personal Skill', eventName: 'Stop', matcher: {},
        userVariables: [
          { name: 'credential', label: '凭据', required: true, secret: true },
          { name: 'project', label: '项目', required: false, secret: false },
        ],
        extensionLogic: {
          language,
          code: language === 'javascript'
            ? 'export async function run(event, ccui) { const value = ccui.env.userVariables.credential; await ccui.log.info(value, { detail: value }); await ccui.records.write("personal", { detail: value }); return { output: { echo: value } }; }'
            : 'async def run(event, ccui):\n    value = ccui.env.userVariables["credential"]\n    await ccui.log.info(value, {"detail": value})\n    await ccui.records.write("personal", {"detail": value})\n    return {"output": {"echo": value}}',
          outputs: [{ name: 'echo', type: 'string' }],
        },
        postActions: [{ id: 'skill', type: 'invoke_skill', config: {
          skillId: 'builtin:hook-notification', skillName: 'hook-notification',
          argumentsTemplate: '{{script.output.echo}} / {{ccui.env.userVariables.project}}',
        } }],
        claudeResponse: { bindings: {} },
      };
      const runtime = createHookRuntimeSession({ hooks: [hook], database, workspaceRoot, userId: 1,
        resolveUserVariables: async () => ({ credential: secret }),
        skillContentLoader: async (_id, _name, args) => `Skill payload: ${args}`,
        enqueueSkillRecovery: async (payload) => { queued.push(payload); return { detail: secret }; },
        onExecutionActivity: (activity) => activities.push(activity),
      });
      await runtime.executeHook(hook, { hook_event_name: 'Stop', session_id: 'session-1', last_assistant_message: secret });
      assert.equal(queued.length, 1);
      assert.equal(queued[0].argumentsText, `${secret} / `);
      assert.equal(queued[0].modelContent, `Skill payload: ${secret} / `);
      assert.doesNotMatch(queued[0].displayCommand, new RegExp(secret));
      assert.match(queued[0].displayCommand, /\[redacted\]/);
      assert.doesNotMatch(JSON.stringify(activities), new RegExp(secret));
      const execution = database.prepare('SELECT * FROM hook_executions').get();
      assert.equal(execution.status, 'succeeded');
      assert.doesNotMatch(JSON.stringify(execution), new RegExp(secret));
      assert.doesNotMatch(JSON.stringify(database.prepare('SELECT * FROM hook_data_records').all()), new RegExp(secret));
    } finally {
      database.close();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
}

test('missing required variables prevent all Hook side effects and short secrets do not corrupt execution status', async () => {
  const database = createDatabase();
  const hook = { id: 'hook-1', version: 1, name: 'Personal', eventName: 'Stop',
    userVariables: [{ name: 'value', label: '必填值', required: true, secret: true }],
    extensionLogic: { language: 'javascript', code: 'injected', outputs: [] },
    postActions: [], claudeResponse: { bindings: {} },
  };
  let calls = 0;
  let value = {};
  try {
    const runtime = createHookRuntimeSession({ hooks: [hook], userId: 1, database,
      resolveUserVariables: () => value,
      scriptExecutor: async () => { calls += 1; throw new Error('failed with value a'); },
    });
    await runtime.executeHook(hook, { hook_event_name: 'Stop', session_id: 'same-session' });
    assert.equal(calls, 0);
    value = { value: 'a' };
    await runtime.executeHook(hook, { hook_event_name: 'Stop', session_id: 'same-session' });
    assert.equal(calls, 1);
    const executions = database.prepare('SELECT * FROM hook_executions ORDER BY started_at_ms').all();
    assert.equal(executions.length, 2);
    assert.ok(executions.every((execution) => execution.status === 'failed' && execution.session_id === 'same-session'));
    assert.match(executions[1].error_message, /f\[redacted\]iled/);
  } finally { database.close(); }
});

test('personal variables reach MCP inputs and Agent content with redacted display text', async () => {
  const database = createDatabase();
  const secret = 'unique-secret-456';
  let received;
  let message;
  const hook = { id: 'hook-1', version: 1, name: 'Personal', eventName: 'Stop',
    userVariables: [{ name: 'value', label: '凭据', required: true, secret: true }],
    postActions: [
      { id: 'mcp', type: 'call_mcp_tool', config: { toolName: 'mcp__service__call', inputs: { value: { source: 'reference', path: 'ccui.env.userVariables.value' } } } },
      { id: 'agent', type: 'send_agent_message', config: { messageTemplate: 'Use {{actions.mcp.output.detail}}' } },
    ], claudeResponse: { bindings: {} },
  };
  try {
    const runtime = createHookRuntimeSession({ hooks: [hook], userId: 1, database,
      resolveUserVariables: () => ({ value: secret }),
      mcpCaller: async ({ input }) => { received = input; return { detail: input.value }; },
      enqueueAgentMessage: async (payload) => { message = payload; },
    });
    await runtime.executeHook(hook, { hook_event_name: 'Stop' });
    assert.deepEqual(received, { value: secret });
    assert.equal(message.messageText, `Use ${secret}`);
    assert.equal(message.displayMessage, 'Use [redacted]');
    assert.doesNotMatch(JSON.stringify(database.prepare('SELECT * FROM hook_executions').all()), new RegExp(secret));
  } finally { database.close(); }
});
