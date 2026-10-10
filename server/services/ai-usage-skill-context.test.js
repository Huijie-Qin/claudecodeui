import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { configureAiUsageTurnDatabase } from './ai-usage-turns.js';
import { createAiUsageSkillContextRecorder, createClaudeSkillContextCapture,
  leadingSkillName, migrateAiUsageSkillContext } from './ai-usage-skill-context.js';

const scope = { tenantId: 1, userId: 2, workspaceId: 3, provider: 'claude' };
const requestId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const skill = (id, extra = {}) => ({ type: 'assistant', parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', name: 'Skill', id, input: { skill: 'report', args: 'PRIVATE ARGUMENTS' } }] },
  ...extra });

function fixture(t, options = {}) {
  const database = new Database(':memory:');
  migrateAiUsageSkillContext(database);
  t.after(() => database.close());
  const warnings = [];
  let time = '2026-09-12T02:00:00.000Z';
  const now = () => time;
  const recorder = createAiUsageSkillContextRecorder({ database, now,
    logger: { warn: (text) => warnings.push(text) } });
  return { database, warnings, recorder, now, at: (value) => { time = value; },
    rows: (kind) => database.prepare(`SELECT * FROM ai_usage_skill_context ${kind ? 'WHERE context_kind=?' : ''}
      ORDER BY context_kind,context_id`).all(...(kind ? [kind] : [])),
    capture: (extra = {}) => createClaudeSkillContextCapture({ options: { ...scope, ...options, ...extra }, recorder, now }),
  };
}

test('leading command capture retains only the submitted name, never parameters or inline mentions', () => {
  assert.equal(leadingSkillName(' /plugin:report secret\nprivate body'), 'plugin:report');
  assert.equal(leadingSkillName('please use /report'), null);
  assert.equal(leadingSkillName('<command-name>/report</command-name>'), null);
  assert.equal(leadingSkillName('/folder/SKILL.md'), null);
  // Installed Skill validation belongs to the nightly resolver, not capture.
  assert.equal(leadingSkillName('/compact'), 'compact');
});

test('migration is idempotent and capture opens only the explicitly configured database', (t) => {
  const f = fixture(t);
  migrateAiUsageSkillContext(f.database);
  configureAiUsageTurnDatabase(f.database);
  t.after(() => configureAiUsageTurnDatabase(null));
  const recorder = createAiUsageSkillContextRecorder({ now: f.now });
  assert.deepEqual(recorder.recordRequest({ ...scope, contextId: requestId, requestId,
    origin: 'user', skillName: 'report' }), { changed: true });
  assert.equal(f.rows().length, 1);
});

test('request and distinct Skill tool IDs remain separate facts and late session binding is scoped', (t) => {
  const f = fixture(t);
  const capture = f.capture();
  capture.request({ messageId: requestId, command: '/report PRIVATE ARGUMENTS' });
  capture.observe(skill('tool-1'));
  capture.observe(skill('tool-1'));
  capture.observe(skill('tool-2'));
  capture.observe(skill('child', { parent_tool_use_id: 'agent-tool' }));
  assert.equal(f.rows().length, 4);
  capture.bindSession('session-1');
  assert.equal(f.rows().every((row) => row.session_id === 'session-1'), true);
  assert.equal(f.rows('tool').filter((row) => row.origin === 'user').length, 2);
  assert.equal(f.rows('tool').find((row) => row.context_id === 'child').request_id, null);
  assert.equal(JSON.stringify(f.rows()).includes('PRIVATE'), false);
  capture.bindSession('wrong-session');
  assert.equal(f.rows().every((row) => row.session_id === 'session-1'), true);
  assert.deepEqual(f.warnings, []);
});

test('malformed tool names cannot persist an embedded prompt body as a Skill name', (t) => {
  const f = fixture(t);
  f.recorder.recordTool({ ...scope, contextId: 'malformed', origin: 'unknown',
    skillName: 'report\nPRIVATE BODY', requestId: null });
  assert.equal(f.rows()[0].skill_name, null);
  assert.equal(JSON.stringify(f.rows()).includes('PRIVATE'), false);
});

test('normal messages and streaming tokens never create tool context rows', (t) => {
  const f = fixture(t);
  const capture = f.capture();
  capture.request({ messageId: requestId, command: 'normal request' });
  for (let index = 0; index < 50; index++) capture.observe({ type: 'stream_event', event: { delta: { text: 'x' } } });
  capture.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [
    { type: 'text', text: 'hello' }, { type: 'tool_use', name: 'Read', id: 'read', input: { file_path: 'SKILL.md' } },
  ] } });
  capture.observeTool({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'bash' });
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].skill_name, null);
});

test('inherited Skill replies cannot create new live skill execution context', (t) => {
  const f = fixture(t, { sessionId: 'forked-session' });
  const capture = f.capture();
  capture.request({ messageId: requestId, command: '/report' });
  capture.observe(skill('old', { forkedFrom: { sessionId: 'parent', messageUuid: 'old' } }));
  capture.observe(skill('old-normalized', { inherited: true }));
  capture.observe(skill('new'));
  assert.deepEqual(f.rows('tool').map((row) => row.context_id), ['new']);
});

test('supplements have independent UUIDs; merged inputs do not guess the current tool request', (t) => {
  const f = fixture(t, { sessionId: 'session-1' });
  const capture = f.capture();
  capture.request({ messageId: requestId, command: '/report first' });
  capture.observe(skill('before-supplement'));
  capture.request({ messageId: secondId, command: '/report second', supplemental: true });
  capture.observe(skill('after-supplement'));
  assert.equal(f.rows('request').length, 2);
  assert.equal(f.rows('request').every((row) => row.origin === 'user' && row.context_id === row.request_id), true);
  const tools = f.rows('tool');
  assert.equal(tools.find((row) => row.context_id === 'before-supplement').request_id, requestId);
  assert.equal(tools.find((row) => row.context_id === 'after-supplement').origin, 'unknown');
  assert.deepEqual(capture.identity, { requestId: null, origin: 'unknown' });
});

test('Hook follow-up requests and their nested Skill calls stay excluded-source hook', (t) => {
  const f = fixture(t, { hookRecovery: { hookId: 'hook-1' } });
  const capture = f.capture();
  capture.request({ messageId: requestId, command: '/report hook body' });
  capture.observe(skill('main'));
  capture.observe(skill('child', { parent_tool_use_id: 'agent-tool' }));
  assert.equal(f.rows().every((row) => row.origin === 'hook'), true);
  assert.equal(f.rows('tool').every((row) => row.request_id === requestId), true);
});

test('MCP resume inherits the original request and does not create a second slash submission', (t) => {
  const f = fixture(t, { sessionId: 'session-1' });
  const initial = f.capture();
  initial.request({ messageId: requestId, command: '/report original' });
  const resumed = f.capture({ mcpLoopResume: true, aiUsageSkillRequest: initial.identity });
  resumed.request({ messageId: secondId, command: '/report INTERNAL RESUME BODY' });
  resumed.observe(skill('resumed-tool'));
  assert.equal(f.rows('request').find((row) => row.context_id === secondId).skill_name, null);
  assert.equal(f.rows('request').find((row) => row.context_id === secondId).request_id, requestId);
  assert.equal(f.rows('tool')[0].request_id, requestId);
  const hookResume = f.capture({ mcpLoopResume: true, aiUsageSkillRequest: { requestId, origin: 'hook' } });
  hookResume.observe(skill('hook-resumed-tool'));
  assert.equal(f.rows('tool').find((row) => row.context_id === 'hook-resumed-tool').origin, 'hook');
});

test('MCP resume without a source request and unknown child ownership are not guessed user', (t) => {
  const f = fixture(t);
  const resumed = f.capture({ mcpLoopResume: true });
  resumed.request({ messageId: requestId, command: '/report internal' });
  resumed.observe(skill('orphan-resume'));
  const user = f.capture();
  user.request({ messageId: secondId, command: '/report' });
  user.observe(skill('child', { parent_tool_use_id: 'task-1' }));
  user.observe(skill('unidentified', { parent_tool_use_id: undefined }));
  assert.equal(f.rows('tool').every((row) => row.origin === 'unknown' && row.request_id === null), true);
});

test('PreToolUse observations are idempotently refined only by a known main or Hook origin', (t) => {
  const f = fixture(t);
  const capture = f.capture();
  capture.request({ messageId: requestId, command: '/report' });
  const pre = { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_use_id: 'tool-1', tool_input: { skill: 'report' } };
  capture.observeTool(pre);
  assert.equal(f.rows('tool')[0].origin, 'unknown');
  capture.observe(skill('tool-1'));
  capture.observeTool(pre);
  assert.equal(f.rows('tool').length, 1);
  assert.equal(f.rows('tool')[0].origin, 'user');
  assert.equal(f.rows('tool')[0].request_id, requestId);
});

test('real subagent IDs survive raw replays and cannot be reclassified as a user main tool', (t) => {
  const f = fixture(t);
  const capture = f.capture();
  capture.request({ messageId: requestId, command: '/report' });
  capture.observeTool({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_use_id: 'child-tool',
    agent_id: 'child-1', tool_input: { skill: 'report' } });
  capture.observe(skill('child-tool'));
  assert.equal(f.rows('tool')[0].subagent_id, 'child-1');
  assert.equal(f.rows('tool')[0].origin, 'unknown');
  assert.equal(f.rows('tool')[0].request_id, null);
  capture.observe(skill('late-child'));
  capture.observeTool({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_use_id: 'late-child',
    agent_id: 'child-2', tool_input: { skill: 'report' } });
  assert.equal(f.rows('tool').find((row) => row.context_id === 'late-child').origin, 'unknown');
});

test('Hook subagent markers preserve the first injection time and do not taint earlier calls', (t) => {
  const f = fixture(t, { sessionId: 'session-1' });
  const capture = f.capture();
  capture.request({ messageId: requestId, command: '/report' });
  capture.observe(skill('before', { parent_tool_use_id: 'task-1', agent_id: 'child-1' }));
  f.at('2026-09-12T02:01:00.000Z');
  capture.markSubagentHook({ agentId: 'child-1' });
  capture.observe(skill('after', { parent_tool_use_id: 'task-1', agent_id: 'child-1' }));
  f.at('2026-09-12T02:02:00.000Z');
  capture.markSubagentHook({ agentId: 'child-1' });
  assert.equal(f.rows('session').length, 1);
  assert.equal(f.rows('session')[0].context_id, 'subagent:child-1');
  assert.equal(f.rows('session')[0].occurred_at, '2026-09-12T02:01:00.000Z');
  assert.equal(f.rows('tool').find((row) => row.context_id === 'before').origin, 'unknown');
  assert.equal(f.rows('tool').find((row) => row.context_id === 'after').origin, 'hook');
});

test('recorder protects tenant scope and reports failures without breaking the conversation', (t) => {
  const f = fixture(t);
  const base = { ...scope, contextId: requestId, requestId, origin: 'user', skillName: 'report' };
  f.recorder.recordRequest(base);
  f.recorder.recordRequest({ ...base, tenantId: 2 });
  f.recorder.bindSession({ ...scope, requestId, sessionId: 'session-1' });
  assert.equal(f.rows().find((row) => row.tenant_id === 2).session_id, null);
  assert.equal(f.recorder.recordRequest({ ...base, tenantId: null }), null);
  assert.equal(f.recorder.recordRequest({ ...base, origin: 'invented' }), null);
  assert.equal(f.recorder.recordRequest({ ...base, requestId: secondId }), null);
  assert.equal(f.warnings.length, 3);
  const unavailable = createAiUsageSkillContextRecorder({ getDatabase: () => null,
    logger: { warn: (message) => f.warnings.push(message) } });
  assert.equal(unavailable.recordRequest(base), null);
  assert.equal(f.warnings.length, 4);
});

test('missing trusted ownership causes no capture writes', () => {
  const calls = [];
  const capture = createClaudeSkillContextCapture({ options: { tenantId: 1 }, recorder: {
    recordRequest: (row) => calls.push(row), recordTool: (row) => calls.push(row),
  } });
  capture.request({ messageId: requestId, command: '/report' });
  capture.observe(skill('tool'));
  assert.deepEqual(calls, []);
});
