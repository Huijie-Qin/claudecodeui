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
      tool_use_id: 'tool-1',
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
    const skillDirectory = path.join(workspaceRoot, '.claude', 'skills', 'notify-user');
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(
      path.join(skillDirectory, 'SKILL.md'),
      '---\nname: notify-user\n---\nSend this notification: $ARGUMENTS\n',
      'utf8',
    );
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
          skillName: 'notify-user',
          argumentsTemplate: 'user={{ccui.env.userId}} error={{event.error_details}}',
          maxTurns: 2,
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
    assert.equal(scheduled[0].displayCommand, '/notify-user user=1 error=rate limited');
    assert.match(scheduled[0].modelContent, /Send this notification: user=1 error=rate limited/);
    assert.match(scheduled[0].modelContent, /at most 2 agent turns/);
    const executions = database.prepare('SELECT status, actions_json FROM hook_executions ORDER BY rowid').all();
    assert.equal(executions.length, 2);
    assert.equal(JSON.parse(executions[1].actions_json).recover.output.reason, 'already_scheduled');
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Stop Skill action appends a new turn after a normal answer and keeps the Stop response', async () => {
  const database = createDatabase();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-runtime-'));
  try {
    const skillDirectory = path.join(workspaceRoot, '.claude', 'skills', 'summarize-answer');
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(
      path.join(skillDirectory, 'SKILL.md'),
      '---\nname: summarize-answer\n---\nSummarize the completed answer for user $ARGUMENTS\n',
      'utf8',
    );
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
          skillName: 'summarize-answer',
          argumentsTemplate: '{{ccui.env.userId}}',
          maxTurns: 2,
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
      enqueueSkillRecovery: async (request) => scheduled.push(request),
    });
    const output = await runtime.executeHook(hook, {
      hook_event_name: 'Stop',
      session_id: 'completed-session',
      stop_hook_active: false,
      last_assistant_message: 'done',
    });
    assert.deepEqual(output, { systemMessage: 'normal answer completed' });
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].displayCommand, '/summarize-answer 1');
    assert.match(scheduled[0].modelContent, /Summarize the completed answer for user 1/);
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
