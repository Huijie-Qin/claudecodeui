import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import Database from 'better-sqlite3';

import {
  HOOK_CONFIG_SCHEMA_SQL,
  migrateHookActivationModel,
  migrateHookConfigurationModel,
} from '../database/hook-config-schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';

import {
  HOOK_EVENTS,
  allowedClaudeOutputs,
  allowedPostActions,
  createHookConfigService,
} from './hook-configs.js';
import { createHookRuntimeSession } from './hook-runtime.js';
import { HOOK_SCRIPT_API_METHODS } from './hook-script-executor.js';

const BASE_EVENT = Object.freeze({
  session_id: 'session-scenarios',
  transcript_path: '/workspace/transcript.jsonl',
  cwd: '/workspace',
  permission_mode: 'bypassPermissions',
});

const EVENT_SAMPLES = Object.freeze({
  Setup: { trigger: 'init' },
  SessionStart: { source: 'startup', model: 'claude-sonnet-4-5' },
  Stop: { stop_hook_active: false, last_assistant_message: 'done' },
  StopFailure: { error: 'server_error', error_details: 'upstream unavailable', last_assistant_message: 'failed' },
  SessionEnd: { reason: 'clear' },
  UserPromptSubmit: { prompt: '检查这个项目', session_title: '项目检查' },
  UserPromptExpansion: {
    expansion_type: 'slash_command',
    command_name: 'review',
    command_args: 'src',
    command_source: 'project',
    prompt: 'Review src',
  },
  Notification: { title: 'Permission required', message: 'Claude needs attention', notification_type: 'permission_prompt' },
  PreToolUse: { tool_name: 'Read', tool_input: { file_path: 'README.md' }, tool_use_id: 'tool-pre' },
  PostToolUse: {
    tool_name: 'Read',
    tool_input: { file_path: 'README.md' },
    tool_response: { content: 'README content' },
    tool_use_id: 'tool-post',
  },
  PostToolUseFailure: {
    tool_name: 'Read',
    tool_input: { file_path: 'missing.md' },
    tool_use_id: 'tool-failure',
    error: 'File not found',
    is_interrupt: false,
  },
  PermissionRequest: {
    tool_name: 'Write',
    tool_input: { file_path: 'output.txt', content: 'hello' },
    permission_suggestions: [],
  },
  PermissionDenied: {
    tool_name: 'Write',
    tool_input: { file_path: 'output.txt', content: 'hello' },
    tool_use_id: 'tool-denied',
    reason: 'User denied permission',
  },
  SubagentStart: { agent_id: 'agent-1', agent_type: 'Explore' },
  SubagentStop: {
    stop_hook_active: false,
    agent_id: 'agent-1',
    agent_transcript_path: '/workspace/agent-1.jsonl',
    agent_type: 'Explore',
    last_assistant_message: 'subagent done',
  },
  TeammateIdle: { teammate_name: 'researcher', team_name: 'review-team' },
  TaskCreated: {
    task_id: 'task-1',
    task_subject: 'Review code',
    task_description: 'Review the service',
    teammate_name: 'reviewer',
    team_name: 'review-team',
  },
  TaskCompleted: {
    task_id: 'task-1',
    task_subject: 'Review code',
    task_description: 'Review the service',
    teammate_name: 'reviewer',
    team_name: 'review-team',
  },
  PreCompact: { trigger: 'auto', custom_instructions: null },
  PostCompact: { trigger: 'auto', compact_summary: 'Conversation summary' },
  Elicitation: {
    mcp_server_name: 'notify',
    message: 'Confirm notification',
    mode: 'form',
    elicitation_id: 'elicit-1',
    requested_schema: { type: 'object', properties: { confirmed: { type: 'boolean' } } },
  },
  ElicitationResult: {
    mcp_server_name: 'notify',
    elicitation_id: 'elicit-1',
    mode: 'form',
    action: 'accept',
    content: { confirmed: true },
  },
  ConfigChange: { source: 'skills', file_path: '/workspace/.claude/skills/notify/SKILL.md' },
  InstructionsLoaded: {
    file_path: '/workspace/CLAUDE.md',
    memory_type: 'Project',
    load_reason: 'session_start',
    globs: ['**/*.js'],
  },
  CwdChanged: { old_cwd: '/workspace', new_cwd: '/workspace/packages/app' },
  FileChanged: { file_path: '/workspace/.env', event: 'change' },
  WorktreeCreate: { name: 'feature-hook' },
  WorktreeRemove: { worktree_path: '/workspace/.claude/worktrees/feature-hook' },
});

const MATCHERS = Object.freeze({
  Setup: 'init',
  SessionStart: 'startup',
  StopFailure: 'server_error',
  SessionEnd: 'clear',
  UserPromptExpansion: 'review',
  Notification: 'permission_prompt',
  PreToolUse: '^Read$',
  PostToolUse: '^Read$',
  PostToolUseFailure: '^Read$',
  PermissionRequest: '^Write$',
  PermissionDenied: '^Write$',
  SubagentStart: 'Explore',
  SubagentStop: 'Explore',
  PreCompact: 'auto',
  PostCompact: 'auto',
  Elicitation: 'notify',
  ElicitationResult: 'notify',
  ConfigChange: 'skills',
  InstructionsLoaded: 'session_start',
  FileChanged: '.env',
});

const EVENT_SPECIFIC_BINDINGS = Object.freeze({
  Setup: {
    'hookSpecificOutput.additionalContext': { source: 'literal', value: 'setup context' },
  },
  SessionStart: {
    'hookSpecificOutput.additionalContext': { source: 'literal', value: 'session context' },
  },
  UserPromptSubmit: {
    'hookSpecificOutput.sessionTitle': { source: 'literal', value: 'Hook 标题' },
  },
  UserPromptExpansion: {
    'hookSpecificOutput.additionalContext': { source: 'literal', value: 'expanded context' },
  },
  Notification: {
    'hookSpecificOutput.additionalContext': { source: 'literal', value: 'notification context' },
  },
  PreToolUse: {
    'hookSpecificOutput.permissionDecision': { source: 'literal', value: 'allow' },
    'hookSpecificOutput.updatedInput': { source: 'reference', path: 'event.tool_input' },
  },
  PostToolUse: {
    'hookSpecificOutput.updatedMCPToolOutput': { source: 'reference', path: 'event.tool_response' },
  },
  PostToolUseFailure: {
    'hookSpecificOutput.additionalContext': { source: 'literal', value: 'tool failure context' },
  },
  PermissionRequest: {
    'hookSpecificOutput.decision': { source: 'literal', value: { behavior: 'allow' } },
  },
  PermissionDenied: {
    'hookSpecificOutput.retry': { source: 'literal', value: true },
  },
  SubagentStart: {
    'hookSpecificOutput.additionalContext': { source: 'literal', value: 'subagent context' },
  },
  Elicitation: {
    'hookSpecificOutput.action': { source: 'literal', value: 'accept' },
    'hookSpecificOutput.content': { source: 'literal', value: { confirmed: true } },
  },
  ElicitationResult: {
    'hookSpecificOutput.action': { source: 'literal', value: 'decline' },
    'hookSpecificOutput.content': { source: 'literal', value: { reason: 'policy' } },
  },
  CwdChanged: {
    'hookSpecificOutput.watchPaths': { source: 'literal', value: ['packages/app'] },
  },
  FileChanged: {
    'hookSpecificOutput.watchPaths': { source: 'literal', value: ['.env'] },
  },
  WorktreeCreate: {
    'hookSpecificOutput.worktreePath': { source: 'literal', value: '/workspace/.claude/worktrees/feature-hook' },
  },
});

const SCRIPT_CODE = `export async function run(event, ccui) {
  await ccui.records.write('event_scenario', {
    eventName: event.hook_event_name,
    userId: ccui.env.userId,
  });
  return { output: { seen: event.hook_event_name } };
}`;

function createFixture({ hookMcpCatalog } = {}) {
  const database = new Database(':memory:');
  // Node 24 can collect transient better-sqlite3 Statement wrappers while a
  // spawned SDK/MCP child process is exiting, which triggers an upstream native
  // cleanup assertion. Keep the wrappers alive for the fixture lifetime; close()
  // still finalizes them normally.
  const retainedStatements = [];
  const prepare = database.prepare.bind(database);
  database.prepare = (...args) => {
    const statement = prepare(...args);
    retainedStatements.push(statement);
    return statement;
  };
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT 1,
      is_system_admin BOOLEAN NOT NULL DEFAULT 0
    );
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ${HOOK_CONFIG_SCHEMA_SQL}
    ${MULTITENANCY_SCHEMA_SQL}
  `);
  migrateHookConfigurationModel(database);
  migrateHookActivationModel(database);
  database.prepare('INSERT INTO users (id, username) VALUES (1, ?)').run('admin');
  database.prepare('INSERT INTO users (id, username) VALUES (2, ?)').run('member');
  const configValues = new Map();
  return {
    database,
    service: createHookConfigService({
      database,
      ...(hookMcpCatalog ? { hookMcpCatalog } : {}),
      configStore: {
        get: (key) => configValues.get(key) || null,
        set: (key, value) => configValues.set(key, value),
      },
    }),
  };
}

function createEventInput(eventName, workspaceRoot) {
  return {
    ...BASE_EVENT,
    cwd: workspaceRoot,
    transcript_path: path.join(workspaceRoot, 'transcript.jsonl'),
    ...EVENT_SAMPLES[eventName],
    hook_event_name: eventName,
  };
}

function createHookInput(eventName) {
  const matcher = MATCHERS[eventName]
    ? { mode: 'exact', value: MATCHERS[eventName] }
    : {};
  const bindings = eventName === 'StopFailure'
    ? {}
    : {
        systemMessage: {
          source: 'template',
          template: 'handled={{script.output.seen}} user={{ccui.env.userId}}',
        },
        ...(EVENT_SPECIFIC_BINDINGS[eventName] || {}),
      };
  return {
    name: `${eventName} scenario`,
    description: `Configuration-driven runtime test for ${eventName}`,
    eventName,
    matcher,
    extensionLogic: {
      language: 'javascript',
      code: SCRIPT_CODE,
      outputs: [{ name: 'seen', type: 'string' }],
    },
    postActions: [],
    claudeResponse: { bindings },
  };
}

function expectedHookSpecificOutput(eventName, event) {
  const values = {};
  for (const [outputPath, binding] of Object.entries(EVENT_SPECIFIC_BINDINGS[eventName] || {})) {
    const key = outputPath.slice('hookSpecificOutput.'.length);
    values[key] = binding.source === 'reference'
      ? binding.path === 'event.tool_input' ? event.tool_input : event.tool_response
      : binding.value;
  }
  return Object.keys(values).length > 0
    ? { ...values, hookEventName: eventName }
    : null;
}

function createHookProtocolProcess({ createInput, report }) {
  return () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const events = new EventEmitter();
    let exitCode = null;
    let killed = false;
    let finished = false;
    let inputBuffer = '';
    let pendingCallbacks = [];
    let activeCallback = null;

    const writeMessage = (message) => {
      if (!stdout.destroyed && !stdout.writableEnded) {
        stdout.write(`${JSON.stringify(message)}\n`);
      }
    };
    const exit = (code, signal = null) => {
      if (finished) return;
      finished = true;
      exitCode = code;
      stdout.end();
      setImmediate(() => events.emit('exit', code, signal));
    };
    const finishSession = () => {
      writeMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 0,
        num_turns: 1,
        result: 'hook protocol matrix completed',
        session_id: 'hook-protocol-session',
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        uuid: '00000000-0000-4000-8000-000000000001',
      });
      setTimeout(() => exit(0), 5);
    };
    const sendNextCallback = () => {
      if (activeCallback || finished) return;
      activeCallback = pendingCallbacks.shift() || null;
      if (!activeCallback) {
        finishSession();
        return;
      }
      const input = createInput(activeCallback.eventName);
      writeMessage({
        type: 'control_request',
        request_id: activeCallback.requestId,
        request: {
          subtype: 'hook_callback',
          callback_id: activeCallback.callbackId,
          input,
          ...(input.tool_use_id ? { tool_use_id: input.tool_use_id } : {}),
        },
      });
    };
    const handleSdkMessage = (message) => {
      if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
        report.initialize = message.request;
        pendingCallbacks = Object.entries(message.request.hooks || {}).flatMap(([eventName, matchers]) => (
          matchers.flatMap((matcher, matcherIndex) => matcher.hookCallbackIds.map((callbackId, callbackIndex) => ({
            eventName,
            callbackId,
            requestId: `hook-${eventName}-${matcherIndex}-${callbackIndex}`,
          })))
        ));
        writeMessage({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: message.request_id,
            response: { protocolVersion: 'hook-test' },
          },
        });
        setImmediate(sendNextCallback);
        return;
      }
      if (message.type === 'control_response' && activeCallback
          && message.response?.request_id === activeCallback.requestId) {
        report.responses.push({
          eventName: activeCallback.eventName,
          callbackId: activeCallback.callbackId,
          response: message.response,
        });
        activeCallback = null;
        setImmediate(sendNextCallback);
      }
    };

    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      inputBuffer += chunk;
      const lines = inputBuffer.split(/\r?\n/);
      inputBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) handleSdkMessage(JSON.parse(line));
      }
    });

    return {
      stdin,
      stdout,
      get killed() {
        return killed;
      },
      get exitCode() {
        return exitCode;
      },
      kill(signal) {
        killed = true;
        exitCode = null;
        exit(null, signal);
        return true;
      },
      on: events.on.bind(events),
      once: events.once.bind(events),
      off: events.off.bind(events),
    };
  };
}

test('all 28 Claude Agent SDK Hook events execute from published CCUI configurations', async () => {
  assert.deepEqual([...Object.keys(EVENT_SAMPLES)].sort(), [...HOOK_EVENTS].sort());
  const { database, service } = createFixture();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-scenarios-'));
  try {
    for (const eventName of HOOK_EVENTS) {
      const created = service.createHook({ input: createHookInput(eventName), userId: 1 });
      const published = service.publishHook({ hookId: created.id, userId: 1 });
      service.replaceHookBindings({ hookId: created.id, userIds: [2], boundBy: 1 });
      service.setUserHookEnabled({ userId: 2, hookId: created.id, enabled: true });
      const binding = service.getHook(created.id);
      assert.equal(published.status, 'published', `${eventName} should publish`);
      assert.equal(binding.boundUserCount, 1, `${eventName} should bind the target user`);
    }

    const effectiveHooks = service.listActiveHooksForUser(2);
    assert.equal(effectiveHooks.length, HOOK_EVENTS.length);
    const runtime = createHookRuntimeSession({
      hooks: effectiveHooks,
      userId: 2,
      username: 'member',
      tenantId: 11,
      workspaceId: 22,
      workspaceRoot,
      database,
    });

    for (const eventName of HOOK_EVENTS) {
      const configuredHook = effectiveHooks.find((hook) => hook.eventName === eventName);
      assert.ok(configuredHook, `${eventName} configuration should be effective for the user`);
      const compiledMatchers = runtime.hooks[eventName];
      assert.equal(compiledMatchers.length, 1, `${eventName} should compile one SDK matcher`);
      assert.equal(
        compiledMatchers[0].matcher,
        MATCHERS[eventName] || undefined,
        `${eventName} matcher should compile unchanged`,
      );
      const event = createEventInput(eventName, workspaceRoot);
      const output = await compiledMatchers[0].hooks[0](
        event,
        event.tool_use_id,
        { signal: new AbortController().signal },
      );
      if (eventName === 'StopFailure') {
        assert.deepEqual(output, {}, 'StopFailure return values are ignored by Claude and must remain empty');
      } else {
        assert.equal(output.systemMessage, `handled=${eventName} user=2`);
        const expectedSpecific = expectedHookSpecificOutput(eventName, event);
        if (expectedSpecific) assert.deepEqual(output.hookSpecificOutput, expectedSpecific);
        else assert.equal(output.hookSpecificOutput, undefined);
      }
    }

    const executions = database.prepare(`
      SELECT event_name, status, script_output_json, error_message
      FROM hook_executions
      ORDER BY rowid
    `).all();
    assert.equal(executions.length, HOOK_EVENTS.length);
    assert.deepEqual(executions.map((row) => row.event_name), HOOK_EVENTS);
    for (const execution of executions) {
      assert.equal(execution.status, 'succeeded', `${execution.event_name} execution should succeed`);
      assert.equal(execution.error_message, null);
      assert.deepEqual(JSON.parse(execution.script_output_json), { seen: execution.event_name });
    }

    const records = database.prepare(`
      SELECT record_type, data_json FROM hook_data_records ORDER BY rowid
    `).all();
    assert.equal(records.length, HOOK_EVENTS.length);
    for (const [index, record] of records.entries()) {
      assert.equal(record.record_type, 'event_scenario');
      assert.deepEqual(JSON.parse(record.data_json), {
        eventName: HOOK_EVENTS[index],
        userId: 2,
      });
    }
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('the real Agent SDK control channel registers and dispatches all 28 configured Hook events', async () => {
  const { database, service } = createFixture();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-sdk-protocol-'));
  const report = { initialize: null, responses: [] };
  try {
    for (const eventName of HOOK_EVENTS) {
      const created = service.createHook({ input: createHookInput(eventName), userId: 1 });
      service.publishHook({ hookId: created.id, userId: 1 });
      service.replaceHookBindings({ hookId: created.id, userIds: [2], boundBy: 1 });
      service.setUserHookEnabled({ userId: 2, hookId: created.id, enabled: true });
    }
    const effectiveHooks = service.listActiveHooksForUser(2);
    const runtime = createHookRuntimeSession({
      hooks: effectiveHooks,
      userId: 2,
      username: 'member',
      tenantId: 11,
      workspaceId: 22,
      workspaceRoot,
      database,
    });
    const queryInstance = claudeQuery({
      prompt: 'Run the SDK Hook protocol test without a model request.',
      options: {
        cwd: workspaceRoot,
        hooks: runtime.hooks,
        pathToClaudeCodeExecutable: path.join(workspaceRoot, 'fake-claude.mjs'),
        spawnClaudeCodeProcess: createHookProtocolProcess({
          createInput: (eventName) => createEventInput(eventName, workspaceRoot),
          report,
        }),
      },
    });
    let resultMessage = null;
    for await (const message of queryInstance) {
      if (message.type === 'result') resultMessage = message;
    }

    assert.equal(resultMessage?.subtype, 'success');
    assert.ok(report.initialize, 'SDK must send an initialize control request');
    assert.deepEqual(Object.keys(report.initialize.hooks).sort(), [...HOOK_EVENTS].sort());
    assert.equal(report.responses.length, HOOK_EVENTS.length);
    assert.deepEqual(report.responses.map((entry) => entry.eventName).sort(), [...HOOK_EVENTS].sort());

    for (const eventName of HOOK_EVENTS) {
      const initialized = report.initialize.hooks[eventName];
      assert.equal(initialized.length, 1);
      assert.equal(initialized[0].matcher, MATCHERS[eventName] || undefined);
      assert.equal(initialized[0].hookCallbackIds.length, 1);

      const protocolResponse = report.responses.find((entry) => entry.eventName === eventName)?.response;
      assert.equal(protocolResponse?.subtype, 'success', protocolResponse?.error);
      const output = protocolResponse.response;
      if (eventName === 'StopFailure') {
        assert.deepEqual(output, {});
      } else {
        assert.equal(output.systemMessage, `handled=${eventName} user=2`);
        const event = createEventInput(eventName, workspaceRoot);
        const expectedSpecific = expectedHookSpecificOutput(eventName, event);
        if (expectedSpecific) assert.deepEqual(output.hookSpecificOutput, expectedSpecific);
        else assert.equal(output.hookSpecificOutput, undefined);
      }
    }

    const executionSummary = database.prepare(`
      SELECT status, COUNT(*) AS count FROM hook_executions GROUP BY status
    `).all();
    assert.deepEqual(executionSummary, [{ status: 'succeeded', count: HOOK_EVENTS.length }]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM hook_data_records').get().count, HOOK_EVENTS.length);
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

const FULL_MATRIX_SCRIPT_OUTPUTS = Object.freeze([
  { name: 'eventName', type: 'string' },
  { name: 'userId', type: 'number' },
  { name: 'text', type: 'string' },
  { name: 'json', type: 'object' },
  { name: 'exists', type: 'boolean' },
  { name: 'entries', type: 'array' },
]);

const SCRIPT_API_METHODS_EXERCISED = Object.freeze([
  'workspace.readText',
  'workspace.writeText',
  'workspace.readJson',
  'workspace.writeJson',
  'workspace.list',
  'workspace.exists',
  'records.write',
  'log.info',
]);

const JAVASCRIPT_FULL_API_SCRIPT = `export async function run(event, ccui) {
  const base = 'matrix/' + event.hook_event_name + '-javascript';
  await ccui.workspace.writeText(base + '.txt', event.hook_event_name);
  const text = await ccui.workspace.readText(base + '.txt');
  await ccui.workspace.writeJson(base + '.json', { eventName: event.hook_event_name, language: 'javascript' });
  const json = await ccui.workspace.readJson(base + '.json');
  const exists = await ccui.workspace.exists(base + '.txt');
  const entries = await ccui.workspace.list('matrix');
  await ccui.records.write('matrix_javascript', { eventName: event.hook_event_name, userId: ccui.env.userId });
  await ccui.log.info('javascript matrix executed', { eventName: event.hook_event_name });
  return { output: { eventName: event.hook_event_name, userId: ccui.env.userId, text, json, exists, entries } };
}`;

const PYTHON_FULL_API_SCRIPT = `async def run(event, ccui):
    base = "matrix/" + event["hook_event_name"] + "-python"
    await ccui.workspace.write_text(base + ".txt", event["hook_event_name"])
    text = await ccui.workspace.read_text(base + ".txt")
    await ccui.workspace.write_json(base + ".json", {"eventName": event["hook_event_name"], "language": "python"})
    json_value = await ccui.workspace.read_json(base + ".json")
    exists = await ccui.workspace.exists(base + ".txt")
    entries = await ccui.workspace.list("matrix")
    await ccui.records.write("matrix_python", {"eventName": event["hook_event_name"], "userId": ccui.env.userId})
    await ccui.log.info("python matrix executed", {"eventName": event["hook_event_name"]})
    return {"output": {"eventName": event["hook_event_name"], "userId": ccui.env.userId, "text": text, "json": json_value, "exists": exists, "entries": entries}}`;

const CLAUDE_OUTPUT_LITERALS = Object.freeze({
  continue: true,
  stopReason: 'matrix stop reason',
  suppressOutput: true,
  systemMessage: 'matrix system message',
  decision: 'approve',
  reason: 'matrix decision reason',
  'hookSpecificOutput.additionalContext': 'matrix additional context',
  'hookSpecificOutput.initialUserMessage': 'matrix initial message',
  'hookSpecificOutput.watchPaths': ['src', 'docs'],
  'hookSpecificOutput.sessionTitle': 'matrix session title',
  'hookSpecificOutput.permissionDecision': 'allow',
  'hookSpecificOutput.permissionDecisionReason': 'matrix permission reason',
  'hookSpecificOutput.updatedInput': { value: 'updated' },
  'hookSpecificOutput.updatedMCPToolOutput': { content: [{ type: 'text', text: 'updated' }] },
  'hookSpecificOutput.decision': { behavior: 'allow' },
  'hookSpecificOutput.retry': true,
  'hookSpecificOutput.action': 'accept',
  'hookSpecificOutput.content': { accepted: true },
  'hookSpecificOutput.worktreePath': '/workspace/.claude/worktrees/matrix',
});

const MCP_SERVER_MODULE_URL = import.meta.resolve('@modelcontextprotocol/sdk/server/index.js');
const MCP_STDIO_MODULE_URL = import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js');
const MCP_TYPES_MODULE_URL = import.meta.resolve('@modelcontextprotocol/sdk/types.js');
const MATRIX_MCP_SERVER_CODE = `
  import { Server } from '${MCP_SERVER_MODULE_URL}';
  import { StdioServerTransport } from '${MCP_STDIO_MODULE_URL}';
  import { CallToolRequestSchema, ListToolsRequestSchema } from '${MCP_TYPES_MODULE_URL}';
  const server = new Server(
    { name: 'hook-matrix-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  const inputSchema = {
    type: 'object',
    required: ['event_name', 'payload', 'user_id', 'literal'],
    properties: {
      event_name: { type: 'string' },
      payload: { type: 'string' },
      user_id: { type: 'number' },
      literal: { type: 'boolean' },
    },
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', inputSchema }] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: 'text', text: JSON.stringify({ received: request.params.arguments }) }],
  }));
  await server.connect(new StdioServerTransport());
`;

function seedFullMatrixResources(database) {
  database.prepare('INSERT INTO tenants (id, code, name) VALUES (11, ?, ?)').run('matrix', 'Hook Matrix');
  database.prepare(`
    INSERT INTO mcp_server_presets (
      tenant_id, name, display_name, description, transport, config_json,
      status, last_test_status, tool_count, tools_json,
      created_by_user_id, updated_by_user_id
    ) VALUES (11, 'matrix_server', 'Matrix MCP', '', 'http', '{}',
      'published', 'healthy', 1, ?, 1, 1)
  `).run(JSON.stringify([{
    name: 'echo',
    inputSchema: {
      type: 'object',
      required: ['event_name', 'payload', 'user_id', 'literal'],
      properties: {
        event_name: { type: 'string' },
        payload: { type: 'string' },
        user_id: { type: 'number' },
        literal: { type: 'boolean' },
      },
    },
  }]));
}

function fullMatrixHookInput(eventName, suffix, overrides = {}) {
  return {
    name: `${eventName} ${suffix}`,
    description: `Full behavior matrix: ${eventName} / ${suffix}`,
    eventName,
    matcher: MATCHERS[eventName] ? { value: MATCHERS[eventName] } : {},
    extensionLogic: null,
    postActions: [],
    claudeResponse: { bindings: {} },
    ...overrides,
  };
}

function publishBoundMatrixHook(service, eventName, suffix, overrides) {
  const created = service.createHook({
    input: fullMatrixHookInput(eventName, suffix, overrides),
    userId: 1,
  });
  const validatedSkills = created.postActions
    .filter((action) => action.type === 'invoke_skill')
    .map((action) => ({ skillId: action.config.skillId, name: action.config.skillName }));
  const published = service.publishHook({ hookId: created.id, userId: 1, validatedSkills });
  service.replaceHookBindings({ hookId: created.id, userIds: [2], boundBy: 1 });
  service.setUserHookEnabled({ userId: 2, hookId: created.id, enabled: true });
  const binding = service.getHook(created.id);
  assert.equal(published.status, 'published', `${eventName}/${suffix} must publish`);
  assert.equal(binding.boundUserCount, 1, `${eventName}/${suffix} must bind the target user`);
  const effective = service.listActiveHooksForUser(2).find((hook) => hook.id === created.id);
  assert.ok(effective, `${eventName}/${suffix} must be effective for another user`);
  return effective;
}

function setExpectedOutputPath(target, dottedPath, value) {
  const segments = dottedPath.split('.');
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current[segments[index]] ||= {};
    current = current[segments[index]];
  }
  current[segments.at(-1)] = value;
}

function expectedSingleClaudeOutput(eventName, outputPath, value) {
  const expected = {};
  setExpectedOutputPath(expected, outputPath, value);
  if (outputPath.startsWith('hookSpecificOutput.')) {
    expected.hookSpecificOutput.hookEventName = eventName;
  }
  return expected;
}

function getLatestExecution(database, hookId) {
  return database.prepare(`
    SELECT * FROM hook_executions WHERE hook_id = ? ORDER BY rowid DESC LIMIT 1
  `).get(hookId);
}

async function executePublishedMatrixHook({
  database,
  hook,
  workspaceRoot,
  mcpServers,
  enqueueSkillRecovery,
}) {
  const runtime = createHookRuntimeSession({
    hooks: [hook],
    userId: 2,
    username: 'member',
    tenantId: 11,
    workspaceId: 22,
    workspaceRoot,
    mcpServers,
    skillContentLoader: async (skillId, skillName, argumentsText) => {
      assert.equal(skillId, `builtin:${skillName}`);
      return `Run the matrix Hook Skill.\nPayload: ${argumentsText}\n`;
    },
    enqueueSkillRecovery,
    database,
  });
  const compiled = runtime.hooks[hook.eventName];
  assert.equal(compiled.length, 1, `${hook.name} must compile one SDK callback`);
  assert.equal(compiled[0].matcher, MATCHERS[hook.eventName] || undefined);
  const event = createEventInput(hook.eventName, workspaceRoot);
  const output = await compiled[0].hooks[0](
    event,
    event.tool_use_id,
    { signal: new AbortController().signal },
  );
  const execution = getLatestExecution(database, hook.id);
  assert.ok(execution, `${hook.name} must create an audit execution`);
  assert.equal(execution.status, 'succeeded', execution.error_message || `${hook.name} must succeed`);
  return { event, execution, output };
}

test('every Hook event publishes and executes every behavior allowed by its capability matrix', async () => {
  assert.deepEqual([...SCRIPT_API_METHODS_EXERCISED].sort(), [...HOOK_SCRIPT_API_METHODS].sort());
  const matrixMcpServerId = 'hook-mcp-matrix-server';
  const { database, service } = createFixture({
    hookMcpCatalog: {
      listServers: () => [{ id: matrixMcpServerId, name: 'matrix_server' }],
      listToolResources: () => [{
        name: 'mcp__matrix_server__echo',
        mcpServerId: matrixMcpServerId,
        inputSchema: {
          type: 'object',
          required: ['event_name', 'payload', 'user_id', 'literal'],
          properties: {
            event_name: { type: 'string' },
            payload: { type: 'string' },
            user_id: { type: 'number' },
            literal: { type: 'boolean' },
          },
        },
      }],
    },
  });
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-hook-full-matrix-'));
  const recoveries = [];
  const coverage = {
    javascript: 0,
    python: 0,
    callMcpTool: 0,
    writeRecord: 0,
    invokeSkill: 0,
    claudeOutputs: 0,
  };
  const executedHookIds = new Set();
  const mcpServers = {
    matrix_server: {
      command: process.execPath,
      args: ['--input-type=module', '-e', MATRIX_MCP_SERVER_CODE],
    },
  };
  const enqueueSkillRecovery = async (recovery) => {
    recoveries.push(recovery);
  };

  try {
    seedFullMatrixResources(database);

    for (const eventName of HOOK_EVENTS) {
      for (const language of ['javascript', 'python']) {
        const code = language === 'python' ? PYTHON_FULL_API_SCRIPT : JAVASCRIPT_FULL_API_SCRIPT;
        const bindings = eventName === 'StopFailure'
          ? {}
          : language === 'python'
            ? { systemMessage: { source: 'reference', path: 'script.output.eventName' } }
            : { systemMessage: { source: 'template', template: 'script={{script.output.eventName}}' } };
        const hook = publishBoundMatrixHook(service, eventName, `script-${language}`, {
          extensionLogic: { language, code, outputs: FULL_MATRIX_SCRIPT_OUTPUTS },
          claudeResponse: { bindings },
        });
        const { execution, output } = await executePublishedMatrixHook({
          database,
          hook,
          workspaceRoot,
          mcpServers,
          enqueueSkillRecovery,
        });
        const scriptOutput = JSON.parse(execution.script_output_json);
        assert.equal(scriptOutput.eventName, eventName);
        assert.equal(scriptOutput.userId, 2);
        assert.equal(scriptOutput.text, eventName);
        assert.deepEqual(scriptOutput.json, { eventName, language });
        assert.equal(scriptOutput.exists, true);
        assert.ok(scriptOutput.entries.some((entry) => entry.name === `${eventName}-${language}.txt`));
        assert.equal(JSON.parse(execution.logs_json).length, 1);
        const record = database.prepare(`
          SELECT record_type, data_json FROM hook_data_records
          WHERE hook_id = ? ORDER BY rowid DESC LIMIT 1
        `).get(hook.id);
        assert.equal(record.record_type, `matrix_${language}`);
        assert.deepEqual(JSON.parse(record.data_json), { eventName, userId: 2 });
        if (eventName === 'StopFailure') assert.deepEqual(output, {});
        else assert.equal(output.systemMessage, language === 'python' ? eventName : `script=${eventName}`);
        coverage[language] += 1;
        executedHookIds.add(hook.id);
      }

      for (const actionType of allowedPostActions(eventName)) {
        if (actionType === 'call_mcp_tool') {
          const inputs = {
            event_name: { source: 'reference', path: 'event.hook_event_name' },
            payload: {
              source: 'template',
              template: 'event={{event.hook_event_name}} user={{ccui.env.userId}}',
            },
            user_id: { source: 'reference', path: 'ccui.env.userId' },
            literal: { source: 'literal', value: true },
          };
          const bindings = eventName === 'StopFailure'
            ? {}
            : {
                systemMessage: {
                  source: 'template',
                  template: 'mcp={{actions.call-mcp.output}}',
                },
              };
          const hook = publishBoundMatrixHook(service, eventName, 'action-call-mcp', {
            postActions: [{
              id: 'call-mcp',
              type: 'call_mcp_tool',
              position: 0,
              config: { toolName: 'mcp__matrix_server__echo', inputs },
            }],
            claudeResponse: { bindings },
          });
          const { execution, output } = await executePublishedMatrixHook({
            database,
            hook,
            workspaceRoot,
            mcpServers,
            enqueueSkillRecovery,
          });
          const received = {
            event_name: eventName,
            payload: `event=${eventName} user=2`,
            user_id: 2,
            literal: true,
          };
          const actionOutput = { received };
          assert.deepEqual(JSON.parse(execution.actions_json), {
            'call-mcp': { output: actionOutput },
          });
          if (eventName === 'StopFailure') assert.deepEqual(output, {});
          else assert.equal(output.systemMessage, `mcp=${JSON.stringify(actionOutput)}`);
          coverage.callMcpTool += 1;
          executedHookIds.add(hook.id);
          continue;
        }

        if (actionType === 'invoke_skill') {
          const errorTemplate = eventName === 'StopFailure' ? ' error={{event.error}}' : '';
          const hook = publishBoundMatrixHook(service, eventName, 'action-invoke-skill', {
            postActions: [{
              id: 'invoke-skill',
              type: 'invoke_skill',
              position: 0,
              config: {
                skillId: 'builtin:hook-notification',
                skillName: 'hook-notification',
                argumentsTemplate: `event={{event.hook_event_name}}${errorTemplate} user={{ccui.env.userId}}`,
              },
            }],
          });
          const { execution, output } = await executePublishedMatrixHook({
            database,
            hook,
            workspaceRoot,
            mcpServers,
            enqueueSkillRecovery,
          });
          assert.deepEqual(output, {});
          assert.deepEqual(JSON.parse(execution.actions_json), {
            'invoke-skill': {
              output: { scheduled: true, skillName: 'hook-notification' },
            },
          });
          const expectedArguments = eventName === 'StopFailure'
            ? 'event=StopFailure error=server_error user=2'
            : 'event=Stop user=2';
          assert.ok(recoveries.at(-1).modelContent.includes(expectedArguments));
          coverage.invokeSkill += 1;
          executedHookIds.add(hook.id);
          continue;
        }

        if (actionType === 'write_record') {
          const hook = publishBoundMatrixHook(service, eventName, 'action-write-record', {
            postActions: [{
              id: 'write-record',
              type: 'write_record',
              position: 0,
              config: {
                recordType: 'matrix_post_action',
                condition: null,
                fields: {
                  eventName: { source: 'reference', path: 'event.hook_event_name' },
                  userId: { source: 'reference', path: 'ccui.env.userId' },
                  literal: { source: 'literal', value: true },
                },
              },
            }],
          });
          const { execution } = await executePublishedMatrixHook({
            database,
            hook,
            workspaceRoot,
            mcpServers,
            enqueueSkillRecovery,
          });
          const record = database.prepare(`
            SELECT record_type, data_json FROM hook_data_records
            WHERE hook_id = ? ORDER BY rowid DESC LIMIT 1
          `).get(hook.id);
          assert.equal(record.record_type, 'matrix_post_action');
          assert.deepEqual(JSON.parse(record.data_json), {
            eventName,
            userId: 2,
            literal: true,
          });
          assert.equal(JSON.parse(execution.actions_json)['write-record'].output.recorded, true);
          coverage.writeRecord += 1;
          executedHookIds.add(hook.id);
          continue;
        }

        assert.fail(`No full-matrix execution test exists for post action ${actionType}`);
      }

      for (const outputPath of allowedClaudeOutputs(eventName)) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(CLAUDE_OUTPUT_LITERALS, outputPath),
          `No full-matrix literal exists for ${eventName}/${outputPath}`,
        );
        const value = CLAUDE_OUTPUT_LITERALS[outputPath];
        const hook = publishBoundMatrixHook(service, eventName, `response-${outputPath}`, {
          claudeResponse: {
            bindings: { [outputPath]: { source: 'literal', value } },
          },
        });
        const { output } = await executePublishedMatrixHook({
          database,
          hook,
          workspaceRoot,
          mcpServers,
          enqueueSkillRecovery,
        });
        assert.deepEqual(output, expectedSingleClaudeOutput(eventName, outputPath, value));
        coverage.claudeOutputs += 1;
        executedHookIds.add(hook.id);
      }
    }

    const expectedClaudeOutputs = HOOK_EVENTS.reduce(
      (total, eventName) => total + allowedClaudeOutputs(eventName).size,
      0,
    );
    assert.deepEqual(coverage, {
      javascript: HOOK_EVENTS.length,
      python: HOOK_EVENTS.length,
      callMcpTool: HOOK_EVENTS.length,
      writeRecord: HOOK_EVENTS.length,
      invokeSkill: 2,
      claudeOutputs: expectedClaudeOutputs,
    });
    assert.equal(recoveries.length, 2);
    assert.equal(executedHookIds.size, (HOOK_EVENTS.length * 4) + 2 + expectedClaudeOutputs);

    const publishedCounts = database.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published,
        SUM(CASE WHEN activation_scope = 'manual' THEN 1 ELSE 0 END) AS manual_scope
      FROM hooks
    `).get();
    assert.equal(publishedCounts.total, executedHookIds.size);
    assert.equal(publishedCounts.published, executedHookIds.size);
    assert.equal(publishedCounts.manual_scope, executedHookIds.size);
    const executions = database.prepare(`
      SELECT status, COUNT(*) AS count FROM hook_executions GROUP BY status
    `).all();
    assert.deepEqual(executions, [{ status: 'succeeded', count: executedHookIds.size }]);
  } finally {
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
