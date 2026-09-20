import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';
import { migrateAiSessionSummarySchema, SESSION_SUMMARY_VERSION } from '../database/ai-session-summary-schema.js';

import { tokenTotal, createSessionTokenAccumulator } from './ai-session-tokens.js';
import { collectSessionSummaries, replaceSessionSummaries, buildSessionSummaryCandidate, publishSessionSummaryCandidate } from './ai-session-summary.js';
import { collectReportSessionUsage, replaceReportSessionUsage, validateReportSessionUsageCandidate } from './ai-usage-session-source.js';
import { mergeSessionReportFact } from './ai-usage-session-report.js';

const through = '2026-09-17T16:00:00.000Z';
const time = '2026-09-10T02:00:00.000Z';
const scope = [1, 10, 3, 'claude', 'real-session-id'];
const key = JSON.stringify(scope);
const response = (id, usage = { input_tokens: 100, output_tokens: 10 }, timestamp = time) => ({
  type: 'assistant', timestamp, sessionId: 'real-session-id', uuid: `fragment-${id}`,
  message: { id, role: 'assistant', stop_reason: 'end_turn', usage },
});

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER,display_name TEXT,status TEXT);
    CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT,status TEXT);
    CREATE TABLE agent_session_messages(id INTEGER PRIMARY KEY,tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,
      provider TEXT,provider_session_id TEXT,normalized_json TEXT,provider_timestamp TEXT);
    INSERT INTO users VALUES (3,'alice');`);
  migrateAiUsageSchema(db);
  function fact(dataset, id, value = {}, occurredAt = time, sessionKey = key, priority = 10) {
    const s = JSON.parse(sessionKey);
    db.prepare(`INSERT INTO ai_usage_fact_rows
      (tenant_id,source_key,dataset,row_key,stat_date,user_id,workspace_id,session_key,occurred_at,value_json,priority)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(s[0], `source-${priority}-${id}`, dataset, id, occurredAt.slice(0, 10),
      s[2], s[1], sessionKey, occurredAt, JSON.stringify(value), priority);
  }
  function message(id, raw, sessionScope = scope) {
    db.prepare('INSERT INTO agent_session_messages VALUES(?,?,?,?,?,?,?,?)')
      .run(id, ...sessionScope, JSON.stringify(raw), raw.timestamp);
  }
  async function native(rows, options = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ccui-session-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const filename = path.join(dir, 'session.jsonl');
    const content = Buffer.from(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    await writeFile(filename, content);
    const info = await stat(filename);
    db.prepare(`INSERT INTO ai_usage_source_states
      (tenant_id,source_key,offset,size,mtime_ms,identity,fingerprint,state_json) VALUES(?,?,?,?,?,?,?,?)`)
      .run(1, `jsonl:${key}:${filename}`, content.length, content.length, info.mtimeMs, `${info.dev}:${info.ino}`,
        createHash('sha256').update(content.subarray(0, 4096)).digest('hex'),
        JSON.stringify({ sessionKey: key, readable: true, isMain: true, ...options }));
    return filename;
  }
  async function materialize(batchId) {
    // Fixture counterpart of the normal fact -> original-report stage. Use the
    // production merge so completion buckets and day slices have one definition.
    db.exec('DELETE FROM ai_usage_report_rows');
    const write = db.prepare('INSERT OR REPLACE INTO ai_usage_report_rows VALUES(?,?,?,?,?,?,?,?,?,?)');
    for (const row of db.prepare(`SELECT * FROM (SELECT *,ROW_NUMBER() OVER(
      PARTITION BY tenant_id,dataset,row_key ORDER BY priority DESC,source_key) choice
      FROM ai_usage_fact_rows) WHERE choice=1 ORDER BY dataset,row_key`).all()) {
      const value = JSON.parse(row.value_json);
      let rowKey = row.row_key;
      let output = value;
      if (row.dataset === 'interactions' || row.dataset === 'turns') {
        if (row.dataset === 'turns' && value.durationMs === undefined && value.requestStartedAt && value.responseCompletedAt) {
          value.durationMs = Date.parse(value.responseCompletedAt) - Date.parse(value.requestStartedAt);
          row.value_json = JSON.stringify(value);
        }
        rowKey = JSON.stringify([row.dataset,row.session_key,row.user_id,row.workspace_id,value.templateId || null,value.status || null]);
        const previous = db.prepare('SELECT * FROM ai_usage_report_rows WHERE tenant_id=? AND dataset=? AND stat_date=? AND row_key=?')
          .get(row.tenant_id,row.dataset,row.stat_date,rowKey);
        output = mergeSessionReportFact(row, previous ? JSON.parse(previous.value_json) : null);
        if (previous && previous.occurred_at < row.occurred_at) row.occurred_at = previous.occurred_at;
      }
      write.run(row.tenant_id,row.dataset,rowKey,row.stat_date,row.user_id,row.workspace_id,row.subject_id,
        row.session_key,row.occurred_at,JSON.stringify(output));
    }
    const usage = await collectReportSessionUsage({ database: db, tenantId: 1, through });
    db.transaction(() => replaceReportSessionUsage(db, 1, usage))();
    if (batchId) {
      db.prepare('DELETE FROM ai_usage_report_staging WHERE batch_id=?').run(batchId);
      db.prepare('INSERT INTO ai_usage_report_staging SELECT ?,* FROM ai_usage_report_rows WHERE tenant_id=1').run(batchId);
    }
  }
  const collect = async () => {
    await materialize();
    return collectSessionSummaries({ database: db, tenantId: 1, through });
  };
  return { db, fact, message, native, collect, materialize };
}

test('provider-specific cache accounting, integer validation and known zero', () => {
  assert.equal(tokenTotal('claude', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30,
    cache_creation_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 40 } }), 190);
  assert.equal(tokenTotal('codex', { input_tokens: 100, output_tokens: 20, cached_input_tokens: 60,
    reasoning_output_tokens: 10 }), 120);
  assert.equal(tokenTotal('codex', { total_tokens: 120, input_tokens: 100, output_tokens: 20, cached_input_tokens: 60 }), 120);
  assert.equal(tokenTotal('claude', { input_tokens: 0, output_tokens: 0 }), 0);
  for (const input of [-1, 1.2, '30', null, Number.MAX_SAFE_INTEGER]) {
    assert.equal(tokenTotal('claude', { input_tokens: input, output_tokens: 10 }), null);
  }
  assert.equal(tokenTotal('other', { total_tokens: 123 }), null);
});

test('deduplicate model response IDs, not log UUIDs; do not add SDK result aggregates', () => {
  const tokens = createSessionTokenAccumulator('claude', through);
  tokens.observe(response('r1'));
  tokens.observe({ ...response('r1'), uuid: 'another-fragment' });
  tokens.observe(response('r2', { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 100 }));
  tokens.observe({ type: 'result', timestamp: time, usage: { input_tokens: 120, output_tokens: 13 } });
  tokens.observe(response('after-cutoff', undefined, through));
  assert.equal(tokens.result().total, 233);
});

test('inherited native and normalized responses do not contribute tokens or completion times', () => {
  const tokens = createSessionTokenAccumulator('claude', through);
  const forkedFrom = { sessionId: 'parent', messageUuid: 'original-fragment' };
  tokens.observe({ ...response('old'), forkedFrom });
  tokens.observe({ type: 'claude-response', data: { ...response('wrapped-old'), forkedFrom }, timestamp: time });
  tokens.observe({ ...response('old-missing-usage', {}), inherited: true });
  assert.deepEqual(tokens.result(), { total: null, end: null });
  const newTime = '2026-09-11T02:00:00.000Z';
  tokens.observe(response('new', { input_tokens: 4, output_tokens: 2 }, newTime));
  assert.deepEqual(tokens.result(), { total: 6, end: newTime });
});

test('DB session usage excludes inherited response copies before accumulating tokens', async t => {
  const { fact, message, collect } = fixture(t);
  fact('interactions', 'first', {}, '2026-09-11T02:00:00.000Z');
  message(1, { ...response('parent'), inherited: true });
  message(2, response('new', { input_tokens: 6, output_tokens: 3 }, '2026-09-11T02:01:00.000Z'));
  const [row] = await collect();
  assert.equal(row.total_tokens, 9);
  assert.equal(row.start_time, '2026-09-11 10:00:00');
  assert.equal(row.end_time, '2026-09-11 10:01:00');
});

test('streaming snapshots mature once; unresolved missing usage stays unknown', () => {
  const tokens = createSessionTokenAccumulator('claude', through);
  tokens.observe(response('one', {}));
  tokens.observe(response('one', { input_tokens: 5, output_tokens: 1 }, '2026-09-10T02:00:01Z'));
  tokens.observe(response('one', { input_tokens: 5, output_tokens: 8 }, '2026-09-10T02:00:02Z'));
  assert.equal(tokens.result().total, 13);
  tokens.observe(response('missing', {}));
  assert.equal(tokens.result().total, null);
});

test('Codex uses latest cumulative usage rather than summing snapshots or cached input', () => {
  const tokens = createSessionTokenAccumulator('codex', through);
  const snapshot = (total, timestamp) => ({ timestamp, type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: { total_tokens: total, cached_input_tokens: 50 } },
  } });
  tokens.observe(snapshot(100, time));
  tokens.observe(snapshot(150, '2026-09-10T02:00:01Z'));
  tokens.observe(snapshot(150, '2026-09-10T02:00:02Z'));
  tokens.observe(snapshot(100, time));
  assert.equal(tokens.result().total, 150);
});

test('one lifetime row spans days; skills deduplicate, caller identity remains independent of publisher', async t => {
  const { db, fact, message, collect } = fixture(t);
  fact('interactions', 'first');
  fact('interactions', 'second', {}, '2026-09-12T02:00:00Z');
  fact('turns', 'finished', { turnKey: 'request-finished', status: 'completed',
    requestStartedAt: '2026-09-12T02:00:00Z', responseCompletedAt: '2026-09-12T02:03:01.987Z' });
  fact('turns', 'pending', { status: 'pending', responseCompletedAt: '2026-09-13T02:03:00Z' });
  fact('skill_invocations', 'tool1', { skillName: 'sql-helper' });
  fact('skill_invocations', 'tool2', { skillName: 'sql-helper' });
  fact('skill_invocations', 'tool3', { skillName: 'review' });
  db.exec("UPDATE ai_usage_fact_rows SET user_id=99 WHERE dataset='skill_invocations'");
  message(1, response('model-response'));
  const rows = await collect();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], id: null }, { id: null, tenant_id: 1, workspace_id: 10, user_id: 3,
    provider: 'claude', session_id: 'real-session-id', user_name: 'alice', total_tokens: 110,
    skill_list: '["review","sql-helper"]', start_time: '2026-09-10 10:00:00', end_time: '2026-09-12 10:03:01',
    ai_active_duration_seconds: 181.987 });
  replaceSessionSummaries(db, 1, rows);
  replaceSessionSummaries(db, 1, rows);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_session_summary').get().n, 1);
});

test('native history wins over DB copy, response copies dedup and subagent end does not extend main session', async t => {
  const { fact, message, native, collect } = fixture(t);
  fact('interactions', 'first');
  const r1 = response('r1');
  await native([r1, { ...r1, uuid: 'copy' }, response('r2')]);
  await native([response('child', undefined, '2026-09-11T00:00:00Z')], { isMain: false });
  message(1, response('database-copy', { input_tokens: 9000, output_tokens: 10 }));
  const [row] = await collect();
  assert.equal(row.total_tokens, 330);
  assert.equal(row.end_time, '2026-09-10 10:00:00');
});

test('unknown usage and unfinished response are NULL, never fabricated zero/end time', async t => {
  const { fact, message, collect } = fixture(t);
  fact('interactions', 'first');
  const r = response('tools', {});
  r.message.stop_reason = 'tool_use';
  message(1, r);
  const [row] = await collect();
  assert.equal(row.total_tokens, null);
  assert.equal(row.end_time, null);
  assert.equal(row.skill_list, '[]');
  assert.equal(row.ai_active_duration_seconds, null);
});

test('unreadable indexed transcript invalidates usage instead of silently using a partial DB copy', async t => {
  const { fact, message, native, collect } = fixture(t);
  fact('interactions', 'first');
  const file = await native([response('one')]);
  await rm(file);
  message(1, response('one'));
  assert.equal((await collect())[0].total_tokens, null);
});

test('highest priority correction, tenant/workspace/provider boundaries and deleted session exclusion', async t => {
  const { db, fact, collect } = fixture(t);
  fact('interactions', 'original');
  fact('interactions', 'original', {}, '2026-09-11T02:00:00Z', key, 30);
  // Original session_index permits a reused provider ID for another user,
  // not two conflicting workspace owners of the same provider/session/user.
  fact('interactions', 'other-workspace', {}, time, JSON.stringify([1, 20, 4, 'claude', 'real-session-id']));
  fact('interactions', 'other-provider', {}, time, JSON.stringify([1, 10, 3, 'codex', 'real-session-id']));
  fact('interactions', 'other-tenant', {}, time, JSON.stringify([2, 10, 3, 'claude', 'real-session-id']));
  let rows = await collect();
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map(row => row.id)).size, 3);
  assert.equal(rows.find(row => row.provider === 'claude' && row.workspace_id === 10).start_time, '2026-09-11 10:00:00');
  db.prepare('INSERT INTO session_index VALUES(?,?,?,?,?,?)').run(...scope, 'deleted');
  rows = await collect();
  assert.equal(rows.length, 2);
});

test('candidate is invisible until atomic publish; interrupted collection preserves prior rows', async t => {
  const { db, fact, collect, materialize } = fixture(t);
  fact('interactions', 'first');
  const rows = await collect();
  replaceSessionSummaries(db, 1, rows);
  fact('skill_invocations', 'skill', { skillName: 'new-skill' });
  const progress = {};
  const batch = { id: 'candidate', tenant_id: 1, target_through: through };
  await materialize(batch.id);
  const store = { database: db, assertLease() {}, transaction: fn => db.transaction(fn)() };
  await assert.rejects(buildSessionSummaryCandidate({ store, batch, progress, checkpoint: async () => {},
    checkWindow() { throw new Error('window closed'); } }), /window closed/);
  assert.equal(db.prepare('SELECT skill_list FROM ai_session_summary').get().skill_list, '[]');
  await buildSessionSummaryCandidate({ store, batch, progress, checkpoint: async () => {}, checkWindow() {} });
  assert.equal(progress.sessionSummary.ready, true);
  assert.equal(progress.sessionSummary.version, SESSION_SUMMARY_VERSION);
  assert.equal(db.prepare('SELECT skill_list FROM ai_session_summary').get().skill_list, '[]');
  assert.throws(() => db.transaction(() => { publishSessionSummaryCandidate(db, batch); throw new Error('rollback'); })());
  assert.equal(db.prepare('SELECT skill_list FROM ai_session_summary').get().skill_list, '[]');
  db.transaction(() => publishSessionSummaryCandidate(db, batch))();
  assert.equal(db.prepare('SELECT skill_list FROM ai_session_summary').get().skill_list, '["new-skill"]');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_session_summary_staging').get().n, 0);
});

test('actual duration sums completed turns in seconds, excluding idle gaps and unfinished turns', async t => {
  const { fact, collect } = fixture(t);
  fact('interactions', 'first');
  fact('turns', 'round-1', { turnKey: 'r1', status: 'completed', requestStartedAt: time,
    responseCompletedAt: '2026-09-10T02:01:00.123Z' });
  fact('turns', 'round-2', { turnKey: 'r2', status: 'completed', requestStartedAt: '2026-09-10T02:20:00Z',
    responseCompletedAt: '2026-09-10T02:22:00.456Z' }, '2026-09-10T02:20:00Z');
  for (const status of ['pending', 'failed', 'aborted', 'unsupported']) {
    fact('turns', status, { turnKey: status, status, requestStartedAt: time,
      responseCompletedAt: '2026-09-10T03:00:00Z' });
  }
  const [row] = await collect();
  assert.equal(row.ai_active_duration_seconds, 180.579);
  assert.equal(row.start_time, '2026-09-10 10:00:00');
  assert.equal(row.end_time, '2026-09-10 10:22:00');
});

test('cross-day fact slices and duplicate sources do not double-count a single request', async t => {
  const { fact, collect } = fixture(t);
  const start = '2026-09-10T15:58:00Z';
  fact('interactions', 'first', {}, start);
  const value = { turnKey: 'cross-midnight', status: 'completed', requestStartedAt: start,
    responseCompletedAt: '2026-09-10T16:03:00Z' };
  fact('turns', 'request-day-1', { ...value, durationMs: 120000 }, start);
  fact('turns', 'request-day-1', { ...value, durationMs: 120000 }, start, key, 30);
  fact('turns', 'request-day-2', { ...value, durationMs: 180000 }, start);
  fact('turns', 'future', { ...value, turnKey: 'future-end', responseCompletedAt: through }, start);
  assert.equal((await collect())[0].ai_active_duration_seconds, 300);
});

test('duration corrections replace values and invalid/missing boundaries never use the session span', async t => {
  const { db, fact, collect } = fixture(t);
  fact('interactions', 'first');
  const value = { turnKey: 'r1', status: 'completed', requestStartedAt: time,
    responseCompletedAt: '2026-09-10T02:01:00Z' };
  fact('turns', 'corrected', value);
  fact('turns', 'corrected', { ...value, responseCompletedAt: '2026-09-10T02:00:40Z' }, time, key, 30);
  fact('turns', 'missing-start', { status: 'completed', turnKey: 'missing', responseCompletedAt: '2026-09-10T05:00:00Z' });
  fact('turns', 'invalid', { ...value, turnKey: 'invalid', requestStartedAt: '2026-09-10T04:00:00Z' });
  assert.equal((await collect())[0].ai_active_duration_seconds, 40);
  db.exec("DELETE FROM ai_usage_fact_rows WHERE dataset='turns'");
  assert.equal((await collect())[0].ai_active_duration_seconds, null);
  fact('turns', 'known-zero', { ...value, responseCompletedAt: time });
  assert.equal((await collect())[0].ai_active_duration_seconds, 0);
});

test('duration schema migration preserves old public/staging fields and is idempotent', async t => {
  const { db, fact, collect } = fixture(t);
  fact('interactions', 'first');
  const [row] = await collect();
  replaceSessionSummaries(db, 1, [row]);
  db.exec(`INSERT INTO ai_session_summary_staging SELECT 'old-batch',* FROM ai_session_summary;
    ALTER TABLE ai_session_summary DROP COLUMN ai_active_duration_seconds;
    ALTER TABLE ai_session_summary_staging DROP COLUMN ai_active_duration_seconds;`);
  const before = db.prepare('SELECT * FROM ai_session_summary').get();
  const staged = db.prepare('SELECT * FROM ai_session_summary_staging').get();
  migrateAiSessionSummarySchema(db);
  migrateAiSessionSummarySchema(db);
  assert.deepEqual(db.prepare('SELECT * FROM ai_session_summary').get(), { ...before, ai_active_duration_seconds: null });
  assert.deepEqual(db.prepare('SELECT * FROM ai_session_summary_staging').get(), { ...staged, ai_active_duration_seconds: null });
  assert.equal(db.prepare('PRAGMA table_info(ai_session_summary)').all().find(column => column.name === 'ai_active_duration_seconds').type, 'REAL');
});

test('summary is reproducible from sources, never from existing summary values; source corrections replace totals', async t => {
  const { db, fact, message, collect } = fixture(t);
  fact('interactions', 'first');
  fact('turns', 'request', { turnKey: 'request', status: 'completed', requestStartedAt: time,
    responseCompletedAt: '2026-09-10T02:01:00Z' });
  fact('skill_invocations', 'tool', { skillName: 'sql-helper', callerUserId: 3 });
  message(1, response('original'));
  const original = await collect();
  replaceSessionSummaries(db, 1, original);
  db.exec(`UPDATE ai_session_summary SET user_name='not-a-source',total_tokens=999,
    skill_list='["not-a-call"]',ai_active_duration_seconds=999`);
  assert.deepEqual(await collect(), original);
  db.exec(`UPDATE users SET username='alice-renamed' WHERE id=3;
    UPDATE ai_usage_fact_rows SET value_json=json_set(value_json,'$.responseCompletedAt','2026-09-10T02:00:40Z') WHERE dataset='turns';
    DELETE FROM ai_usage_fact_rows WHERE dataset='skill_invocations';
    UPDATE agent_session_messages SET normalized_json=json_set(normalized_json,'$.message.usage.output_tokens',20);`);
  const corrected = await collect();
  assert.equal(corrected[0].id, original[0].id);
  assert.equal(corrected[0].user_name, 'alice-renamed');
  assert.equal(corrected[0].total_tokens, 120);
  assert.equal(corrected[0].skill_list, '[]');
  assert.equal(corrected[0].ai_active_duration_seconds, 40);
  replaceSessionSummaries(db, 1, corrected);
  assert.deepEqual(await collect(), corrected);
});

test('original scope conflicts block the upstream report, while projections retain the published snapshot', async t => {
  const { db, fact, collect, materialize } = fixture(t);
  fact('interactions', 'first');
  db.prepare('INSERT INTO session_index VALUES(?,?,?,?,?,?)').run(...scope, 'active');
  const original = await collect();
  replaceSessionSummaries(db, 1, original);
  const batch = { id: 'scope-check', tenant_id: 1, target_through: through };
  await materialize(batch.id);
  await buildSessionSummaryCandidate({ store: { database: db, assertLease() {}, transaction: fn => db.transaction(fn)() },
    batch, progress: {}, checkpoint: async () => {}, checkWindow() {} });
  db.exec('UPDATE session_index SET tenant_id=2');
  await assert.rejects(collect(), /SESSION_SUMMARY_SOURCE_SCOPE_CONFLICT/);
  assert.throws(() => validateReportSessionUsageCandidate(db, batch), /SESSION_SUMMARY_SOURCE_SCOPE_CONFLICT/);
  assert.deepEqual(await collectSessionSummaries({ database: db, tenantId: 1, through, batchId: batch.id }), original);
  assert.deepEqual(db.prepare('SELECT * FROM ai_session_summary').all(), original);
  db.exec(`UPDATE session_index SET tenant_id=1;
    INSERT INTO workspaces VALUES(10,2,'other-tenant','active')`);
  await assert.rejects(collect(), /SESSION_SUMMARY_WORKSPACE_SCOPE_CONFLICT/);
});

test('fact scope must agree with the original request identity; publisher identity is not the caller', async t => {
  const { db, fact, collect } = fixture(t);
  fact('interactions', 'first');
  fact('skill_invocations', 'tool', { skillName: 'sql-helper', callerUserId: 3 });
  db.exec("UPDATE ai_usage_fact_rows SET user_id=99 WHERE dataset='skill_invocations'");
  assert.equal((await collect())[0].skill_list, '["sql-helper"]');
  db.exec("UPDATE ai_usage_fact_rows SET value_json=json_set(value_json,'$.callerUserId',4) WHERE dataset='skill_invocations'");
  await assert.rejects(collect(), /SESSION_SUMMARY_FACT_SCOPE_CONFLICT/);
  db.exec("DELETE FROM ai_usage_fact_rows WHERE dataset='skill_invocations'; UPDATE ai_usage_fact_rows SET workspace_id=20");
  await assert.rejects(collect(), /SESSION_SUMMARY_FACT_SCOPE_CONFLICT/);
});

test('session projection queries ONLY ai_usage_report_rows; raw corrections are invisible until report refresh', async t => {
  const { db, fact, message, collect } = fixture(t);
  fact('interactions', 'first');
  fact('turns', 'round', { status: 'completed', requestStartedAt: time, responseCompletedAt: '2026-09-10T02:01:00Z' });
  fact('skill_invocations', 'tool', { skillName: 'sql-helper', callerUserId: 3 });
  message(1, response('r1'));
  const original = await collect();
  const reportOnly = { prepare(sql) {
    assert.match(sql, /FROM ai_usage_report_rows /);
    assert.doesNotMatch(sql, /fact_rows|source_states|session_index|agent_session_messages|users|ai_session_summary/);
    return db.prepare(sql);
  } };
  db.exec(`DELETE FROM ai_usage_fact_rows; DELETE FROM agent_session_messages;
    UPDATE users SET username='not-yet-published'`);
  assert.deepEqual(await collectSessionSummaries({ database: reportOnly, tenantId: 1, through }), original);
  db.exec(`UPDATE ai_usage_report_rows SET value_json=json_set(value_json,'$.totalTokens',45,'$.userName','已发布用户名')
    WHERE dataset='session_usage';
    UPDATE ai_usage_report_rows SET value_json=json_set(value_json,'$.skillName','published-skill') WHERE dataset='skill_invocations';`);
  const [updated] = await collectSessionSummaries({ database: reportOnly, tenantId: 1, through });
  assert.equal(updated.total_tokens, 45);
  assert.equal(updated.user_name, '已发布用户名');
  assert.equal(updated.skill_list, '["published-skill"]');
  assert.equal(updated.ai_active_duration_seconds, 60);
});

test('unupgraded or stale report data fails closed instead of bypassing the original report', async t => {
  const { db, fact, collect } = fixture(t);
  fact('interactions', 'first');
  fact('turns', 'round', { status: 'completed', requestStartedAt: time, responseCompletedAt: '2026-09-10T02:01:00Z' });
  await collect();
  const project = () => collectSessionSummaries({ database: db, tenantId: 1, through });
  db.exec("UPDATE ai_usage_report_rows SET value_json=json_remove(value_json,'$.durationByCompletion') WHERE dataset='turns'");
  await assert.rejects(project(), /SESSION_REPORT_UPGRADE_REQUIRED/);
  await collect();
  db.exec("UPDATE ai_usage_report_rows SET value_json=json_set(value_json,'$.through','2026-09-16T16:00:00Z') WHERE dataset='session_usage'");
  await assert.rejects(project(), /SESSION_REPORT_USAGE_STALE/);
  db.exec("DELETE FROM ai_usage_report_rows WHERE dataset='session_usage'");
  await assert.rejects(project(), /SESSION_REPORT_USAGE_MISSING/);
});

test('published and candidate report snapshots never mix; keyset pagination includes all sessions', async t => {
  const { db, fact, collect, materialize } = fixture(t);
  for (let i = 0; i < 505; i++) fact('interactions', `message-${i}`, {}, time,
    JSON.stringify([1,10,3,'claude',`session-${i}`]));
  const published = await collect();
  assert.equal(published.length, 505);
  const batchId = 'isolated-candidate';
  await materialize(batchId);
  db.exec("UPDATE ai_usage_report_staging SET value_json=json_set(value_json,'$.totalTokens',9) WHERE dataset='session_usage'");
  assert.deepEqual(await collectSessionSummaries({ database: db, tenantId: 1, through }), published);
  const candidate = await collectSessionSummaries({ database: db, tenantId: 1, through, batchId });
  assert.equal(candidate.length, 505);
  assert.ok(candidate.every(row => row.total_tokens === 9));
  assert.deepEqual(await collectSessionSummaries({ database: db, tenantId: 2, through, batchId }), []);
});
