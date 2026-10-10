import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { AI_USAGE_SCHEMA_SQL } from '../database/ai-usage-schema.js';

import { createAiUsageTurnRecorder, createClaudeUsageTurnCapture, wrapClaudeUsageStopHooks } from './ai-usage-turns.js';

function fixture() {
  const database = new Database(':memory:');
  database.exec(AI_USAGE_SCHEMA_SQL);
  const warnings = [];
  let time = '2026-09-11T02:00:00.000Z';
  const now = () => time;
  const recorder = createAiUsageTurnRecorder({ database, now, logger: { warn: (value) => warnings.push(value) } });
  const options = { tenantId: 1, userId: 2, workspaceId: 3, sessionId: 'session-1' };
  return { database, recorder, options, warnings, now, at: (value) => { time = value; },
    rows: () => database.prepare('SELECT * FROM ai_usage_turn_facts ORDER BY started_at').all(),
    capture: (extra = {}) => createClaudeUsageTurnCapture({ options, recorder, now, ...extra }),
  };
}

const assistant = () => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } });
const stop = { hook_event_name: 'Stop' };

test('inherited SDK replies cannot complete a new turn or reset its response boundary', () => {
  const f = fixture();
  const forkedFrom = { sessionId: 'parent', messageUuid: 'old-response' };
  try {
    const replayOnly = f.capture({ clientMessageId: 'replay-only' });
    f.at('2026-09-11T02:01:00.000Z');
    replayOnly.observe({ ...assistant(), forkedFrom });
    replayOnly.complete();
    assert.equal(f.rows()[0].terminal_status, 'unsupported');
    assert.equal(f.rows()[0].response_completed_at, null);
    const fresh = f.capture({ clientMessageId: 'fresh' });
    f.at('2026-09-11T02:02:00.000Z');
    fresh.observe(assistant());
    f.at('2026-09-11T02:03:00.000Z');
    fresh.observe({ type: 'system', subtype: 'task_started', forkedFrom });
    fresh.observe({ type: 'result', is_error: true, forkedFrom });
    fresh.complete();
    assert.equal(f.rows()[1].terminal_status, 'completed');
    assert.equal(f.rows()[1].response_completed_at, '2026-09-11T02:02:00.000Z');
  } finally { f.database.close(); }
});

test('two request-response rounds count 2 + 3 minutes, never the 28 minute idle interval', () => {
  const f = fixture();
  try {
    const first = f.capture({ clientMessageId: 'first' });
    f.at('2026-09-11T02:02:00.000Z');
    first.observe(assistant()); first.onStop(stop); first.complete();
    f.at('2026-09-11T02:30:00.000Z');
    const second = f.capture({ clientMessageId: 'second' });
    f.at('2026-09-11T02:33:00.000Z');
    second.observe(assistant()); second.onStop(stop); second.complete();
    assert.equal(f.rows().reduce((total, row) => total + Date.parse(row.response_completed_at) - Date.parse(row.started_at), 0), 300_000);
    assert.equal(f.rows().length, 2);
  } finally { f.database.close(); }
});

test('cross-midnight request retains exact boundaries and stays pending until completion', () => {
  const f = fixture();
  try {
    f.at('2026-09-11T15:58:00.000Z');
    const capture = f.capture();
    assert.equal(f.rows()[0].terminal_status, 'pending');
    assert.equal(f.rows()[0].response_completed_at, null);
    f.at('2026-09-11T16:03:00.000Z');
    capture.onStop(stop); capture.complete();
    const [row] = f.rows();
    assert.equal(Date.parse(row.response_completed_at) - Date.parse(row.started_at), 300_000);
  } finally { f.database.close(); }
});

test('Stop post-actions and grace period do not extend the response timestamp', () => {
  const f = fixture();
  try {
    const capture = f.capture();
    f.at('2026-09-11T02:02:00.000Z');
    capture.observe(assistant()); capture.onStop(stop);
    assert.equal(f.rows()[0].terminal_status, 'pending', 'Stop candidate alone cannot finalize a turn');
    f.at('2026-09-11T02:04:00.000Z');
    capture.observe({ type: 'result', subtype: 'success' }); capture.complete();
    const [row] = f.rows();
    assert.equal(row.response_completed_at, '2026-09-11T02:02:00.000Z');
    assert.equal(row.terminal_at, '2026-09-11T02:04:00.000Z');
  } finally { f.database.close(); }
});

test('buffered primary and child messages cannot extend an already observed Stop boundary', () => {
  const f = fixture();
  try {
    const capture = f.capture();
    f.at('2026-09-11T02:01:00.000Z'); capture.onStop(stop);
    f.at('2026-09-11T02:02:00.000Z'); capture.observe(assistant());
    f.at('2026-09-11T02:05:00.000Z');
    capture.observe({ ...assistant(), parent_tool_use_id: 'child-1' });
    capture.onStop({ ...stop, agent_id: 'child-1' }); capture.complete();
    assert.equal(f.rows()[0].response_completed_at, '2026-09-11T02:01:00.000Z');
  } finally { f.database.close(); }
});

test('a blocked Stop is invalidated until the final response completes', async () => {
  const f = fixture();
  try {
    const capture = f.capture();
    f.at('2026-09-11T02:01:00.000Z'); capture.onStop(stop);
    const wrapped = wrapClaudeUsageStopHooks({ Stop: [{ hooks: [async () => ({ decision: 'block' })] }] }, capture);
    assert.deepEqual(await wrapped.Stop[0].hooks[0](stop), { decision: 'block' });
    f.at('2026-09-11T02:03:00.000Z'); capture.observe(assistant()); capture.onStop(stop);
    f.at('2026-09-11T02:05:00.000Z'); capture.complete();
    assert.equal(f.rows()[0].response_completed_at, '2026-09-11T02:03:00.000Z');
  } finally { f.database.close(); }
});

test('internal Hook follow-ups are excluded and MCP resumes retain the same request identity', () => {
  const f = fixture();
  try {
    f.capture({ options: { ...f.options, hookRecovery: { hookId: 'hook-1' } } }).complete();
    assert.equal(f.rows().length, 0);
    const first = f.capture();
    f.at('2026-09-11T02:04:00.000Z');
    const resumed = f.capture({ options: { ...f.options, mcpLoopResume: true, aiUsageTurn: first.identity } });
    resumed.onStop(stop); resumed.complete();
    assert.equal(f.rows().length, 1);
    assert.equal(f.rows()[0].started_at, '2026-09-11T02:00:00.000Z');
  } finally { f.database.close(); }
});

test('queued independent turns cannot be deduplicated by an inherited logRequestId', () => {
  const f = fixture();
  try {
    const options = { ...f.options, logRequestId: 'reused-runtime-log' };
    f.capture({ options, clientMessageId: 'first-client-id' });
    f.capture({ options, clientMessageId: 'second-client-id' });
    f.capture({ options });
    f.capture({ options });
    assert.equal(f.rows().length, 4);
    assert.equal(new Set(f.rows().map((row) => row.request_key)).size, 4);
  } finally { f.database.close(); }
});

test('start, completion and binding are idempotent and protect tenant ownership', () => {
  const f = fixture();
  try {
    const args = { ...f.options, provider: 'claude', requestKey: 'request-1', sessionKey: null };
    const first = f.recorder.start(args);
    const duplicate = f.recorder.start(args);
    assert.equal(first.turnKey, duplicate.turnKey);
    assert.equal(duplicate.changed, false);
    f.recorder.bindSession({ ...first, sessionKey: 'actual-session' });
    f.recorder.bindSession({ ...first, sessionKey: 'other-session' });
    assert.equal(f.rows()[0].session_key, 'actual-session');
    f.at('2026-09-11T02:01:00.000Z');
    f.recorder.complete({ ...first, tenantId: 9, responseCompletedAt: f.now() });
    assert.equal(f.rows()[0].terminal_status, 'pending');
    f.recorder.complete({ ...first, responseCompletedAt: f.now() });
    f.at('2026-09-11T02:10:00.000Z');
    f.recorder.complete({ ...first, responseCompletedAt: f.now() });
    assert.equal(f.rows()[0].response_completed_at, '2026-09-11T02:01:00.000Z');
    assert.equal(f.database.prepare('SELECT generation FROM ai_usage_dirty_tenants').get().generation, 3);
  } finally { f.database.close(); }
});

test('failed, cancelled and ambiguous rounds never fabricate successful duration', () => {
  const f = fixture();
  try {
    for (const status of ['failed', 'cancelled', 'aborted', 'incomplete', 'unsupported']) {
      const capture = f.capture({ clientMessageId: status });
      capture.onStop(stop); capture.terminal(status); capture.complete();
    }
    const error = f.capture({ clientMessageId: 'sdk-error' });
    error.onStop(stop); error.observe({ type: 'result', is_error: true }); error.complete();
    f.capture({ clientMessageId: 'no-boundary' }).complete();
    assert.equal(f.rows().every((row) => row.response_completed_at === null), true);
  } finally { f.database.close(); }
});

test('database errors roll back facts and are warned without breaking the caller', () => {
  const f = fixture();
  try {
    f.database.exec('DROP TABLE ai_usage_dirty_tenants');
    assert.doesNotThrow(() => f.capture());
    assert.equal(f.rows().length, 0);
    assert.match(f.warnings[0], /start turn failed/);
  } finally { f.database.close(); }
});

test('missing trusted tenant context creates no attributed data and reversed timestamps are rejected', () => {
  const f = fixture();
  try {
    f.capture({ options: { ...f.options, tenantId: null } });
    assert.equal(f.rows().length, 0);
    const capture = f.capture();
    f.at('2026-09-11T01:00:00.000Z'); capture.onStop(stop); capture.complete();
    assert.equal(f.rows()[0].terminal_status, 'pending');
    assert.match(f.warnings.at(-1), /before request start/);
  } finally { f.database.close(); }
});
