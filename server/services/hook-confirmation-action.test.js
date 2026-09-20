import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { HOOK_CONFIG_SCHEMA_SQL } from '../database/hook-config-schema.js';

import { createHookRuntimeSession } from './hook-runtime.js';

const event = { hook_event_name: 'PreToolUse', tool_name: 'mcp__demo__echo',
  tool_input: { text: 'demo', nested: { enabled: true, values: [0, false, null] } } };
const confirmation = { id: 'confirm', type: 'request_confirmation', position: 0,
  config: { condition: null, messageTemplate: '请确认 {{event.tool_name}}' } };

function fixture(t, overrides = {}, options = {}) {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)');
  database.exec(HOOK_CONFIG_SCHEMA_SQL);
  database.prepare('INSERT INTO users VALUES (1, ?)').run('demo');
  database.prepare(`INSERT INTO hooks (id, name, event_name, created_by, updated_by)
    VALUES ('confirmation', 'Confirm', 'PreToolUse', 1, 1)`).run();
  t.after(() => database.close());
  const hook = { id: 'confirmation', version: 1, eventName: 'PreToolUse', includeSubagents: true,
    extensionLogic: null, postActions: [confirmation], claudeResponse: { bindings: {} }, ...overrides };
  const runtime = createHookRuntimeSession({ hooks: [hook], database, userId: 1,
    scriptExecutor: async () => assert.fail('Pure confirmation must not need a script'), ...options });
  const invoke = (input = event) => runtime.hooks.PreToolUse[0].hooks[0](input);
  const audit = () => database.prepare('SELECT * FROM hook_executions ORDER BY rowid DESC LIMIT 1').get();
  return { database, runtime, invoke, audit };
}

test('a pure post action records parameters and asks on every parent and child invocation', async (t) => {
  const f = fixture(t);
  assert.equal(f.runtime.hasRequiredHook, true);
  for (const agent_id of [undefined, 'child', 'child']) {
    const response = await f.invoke({ ...event, agent_id });
    assert.deepEqual(response, { hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: '请确认 mcp__demo__echo',
    } });
    const record = f.audit();
    assert.equal(record.status, 'succeeded');
    const result = JSON.parse(record.actions_json).confirm.output;
    assert.equal(result.requested, true);
    assert.deepEqual(result.toolInput, event.tool_input);
    assert.equal(Object.hasOwn(result, 'approved'), false);
    assert.deepEqual(JSON.parse(record.logs_json)[0].data,
      { toolName: event.tool_name, toolInput: event.tool_input });
  }
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM hook_executions').get().n, 3);
  await f.invoke({ ...event, tool_input: { password: 'private-value', confirmed: true } });
  assert.equal(JSON.parse(f.audit().logs_json)[0].data.toolInput.password, '[redacted]');
  assert.equal(JSON.parse(f.audit().response_json).hookSpecificOutput.permissionDecision, 'ask');
});

test('a false condition and non-MCP calls defer without logging or requesting approval', async (t) => {
  const f = fixture(t, { postActions: [{ ...confirmation,
    config: { ...confirmation.config, condition: { source: 'reference', path: 'event.tool_input.confirm' } } }] });
  for (const input of [{ ...event, tool_input: { confirm: false } }, { ...event, tool_name: 'Read' }]) {
    assert.equal((await f.invoke(input)).hookSpecificOutput.permissionDecision, 'defer');
    assert.equal(JSON.parse(f.audit().actions_json).confirm.output.requested, false);
    assert.deepEqual(JSON.parse(f.audit().logs_json), []);
  }
  assert.equal((await f.invoke({ ...event, tool_input: { confirm: true } })).hookSpecificOutput.permissionDecision, 'ask');
});

test('confirmation cannot be bypassed with an allow binding and never overrides denial or a stop', async (t) => {
  for (const decision of ['allow', 'defer', 'ask', 'deny']) {
    const f = fixture(t, { claudeResponse: { bindings: {
      'hookSpecificOutput.permissionDecision': { source: 'literal', value: decision },
      'hookSpecificOutput.updatedInput': { source: 'literal', value: { text: 'updated' } },
    } } });
    const response = await f.invoke();
    assert.equal(response.hookSpecificOutput.permissionDecision, decision === 'deny' ? 'deny' : 'ask');
    assert.deepEqual(response.hookSpecificOutput.updatedInput, { text: 'updated' });
  }
  const stopped = fixture(t, { claudeResponse: { bindings: { continue: { source: 'literal', value: false } } } });
  const response = await stopped.invoke();
  assert.equal(response.continue, false);
  assert.notEqual(response.hookSpecificOutput.permissionDecision, 'ask');
});

test('malformed input, conditions and messages deny instead of silently omitting confirmation', async (t) => {
  const f = fixture(t);
  for (const input of [{ ...event, tool_name: '' }, { ...event, tool_name: null },
    ...[undefined, null, [], 'yes'].map((tool_input) => ({ ...event, tool_input }))]) {
    assert.equal((await f.invoke(input)).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(f.audit().status, 'failed');
  }
  for (const config of [
    { ...confirmation.config, condition: { source: 'reference', path: 'event.missing' } },
    { ...confirmation.config, condition: { source: 'literal', value: 'false' } },
    { ...confirmation.config, messageTemplate: '{{event.missing}}' },
    { ...confirmation.config, messageTemplate: '' },
  ]) {
    const invalid = fixture(t, { postActions: [{ ...confirmation, config }] });
    assert.equal((await invalid.invoke()).hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('confirmation remains required when scripts, earlier actions, variables or auditing fail', async (t) => {
  for (const failure of ['script', 'action', 'variables', 'audit']) {
    const overrides = failure === 'script'
      ? { extensionLogic: { language: 'javascript', code: 'check', outputs: [] } }
      : failure === 'action' ? { postActions: [{ id: 'prior', type: 'call_mcp_tool',
        config: { condition: null, inputs: {} } }, confirmation] }
        : failure === 'variables' ? { userVariables: [{ name: 'required', required: true }] } : {};
    const f = fixture(t, overrides, {
      scriptExecutor: async () => { throw new Error('script failed'); },
      mcpCaller: async () => { throw new Error('earlier action failed'); },
      resolveUserVariables: async () => { throw new Error('private variable failure'); },
      ...(failure === 'audit' ? { database: { prepare: () => { throw new Error('private database failure'); } } } : {}),
    });
    assert.equal(f.runtime.hasRequiredHook, true);
    assert.equal((await f.invoke()).hookSpecificOutput.permissionDecision, 'deny');
  }
});
