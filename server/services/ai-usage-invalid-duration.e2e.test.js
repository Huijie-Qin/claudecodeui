import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';

import { readAiUsageConfig } from './ai-usage-config.js';
import { createAiUsageStore } from './ai-usage-db.js';
import { runAiUsageWindow } from './ai-usage-batches.js';

const config = { ...readAiUsageConfig({ AI_USAGE_ENABLED: 'true' }), batchSize: 1 };
const night = () => new Date('2026-09-11T18:10:00.000Z');
const nextNight = () => new Date('2026-09-12T18:10:00.000Z');
const time = '2026-09-11T02:00:00.000Z';
const scope = [1, 10, 1, 'claude', 'shared-session'];
const quietLogger = { info() {}, warn() {}, error() {} };

function fixture(t, tenants = 1) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER,display_name TEXT,status TEXT);
    CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,
      provider TEXT,provider_session_id TEXT,status TEXT);`);
  for (let tenant = 1; tenant <= tenants; tenant++) {
    db.prepare("INSERT INTO tenants VALUES(?,'active')").run(tenant);
    db.prepare('INSERT INTO users VALUES(?,?)').run(tenant, `user-${tenant}`);
    db.prepare("INSERT INTO workspaces VALUES(?,?,?,'active')").run(tenant * 10, tenant, `workspace-${tenant}`);
  }
  migrateAiUsageSchema(db);
  const store = createAiUsageStore(db, { clock: night });
  const warnings = [];
  const publications = [];
  const logger = { ...quietLogger,
    warn(message, detail) { if (message === '[AI usage] duration_record_skipped') warnings.push(detail); },
    info(message, detail) { if (message === '[AI usage] batch_published') publications.push(detail); },
  };
  function interaction(identity = scope) {
    const [tenantId, workspaceId, userId, provider, sessionId] = identity;
    const sessionKey = JSON.stringify(identity);
    store.put(tenantId, `interaction:${sessionKey}`, [{ dataset: 'interactions', row_key: `interaction:${sessionKey}`,
      stat_date: '2026-09-11', occurred_at: time, user_id: userId, workspace_id: workspaceId, session_key: sessionKey,
      value: { provider, providerSessionId: sessionId } }]);
  }
  function fact(id, overrides = {}, { identity = scope, priority = 10, source = `fixture:${id}`, rawJson } = {}) {
    const [tenantId, workspaceId, userId, provider, sessionId] = identity;
    store.put(tenantId, source, [{ dataset: 'turns', row_key: id, stat_date: '2026-09-11',
      user_id: userId, workspace_id: workspaceId, session_key: JSON.stringify(identity), occurred_at: time,
      value: { provider, providerSessionId: sessionId, turnKey: id, status: 'completed', durationMs: 60000,
        requestStartedAt: '2026-09-11T02:05:00.000Z', responseCompletedAt: '2026-09-11T02:06:00.000Z', ...overrides } }],
    { priority });
    if (rawJson !== undefined) db.prepare('UPDATE ai_usage_fact_rows SET value_json=? WHERE tenant_id=? AND source_key=?')
      .run(rawJson, tenantId, source);
  }
  function goodPair(identity = scope) {
    interaction(identity);
    fact('a-good', { durationMs: 120000, requestStartedAt: time, responseCompletedAt: '2026-09-11T02:02:00.000Z' }, { identity });
    fact('c-good', { durationMs: 180000, requestStartedAt: '2026-09-11T02:10:00.000Z',
      responseCompletedAt: '2026-09-11T02:13:00.000Z' }, { identity });
  }
  function rawTurn(id, start, end, { identity = scope, status = 'completed' } = {}) {
    const [tenantId, workspaceId, userId, provider, sessionId] = identity;
    db.prepare(`INSERT INTO ai_usage_turn_facts(turn_key,tenant_id,user_id,workspace_id,session_key,provider,
      started_at,response_completed_at,terminal_status,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(id, tenantId, userId, workspaceId, sessionId, provider, start, end, status, time);
  }
  const run = options => runAiUsageWindow({ database: db, config, now: night, logger, ...options });
  return { db, warnings, publications, interaction, fact, goodPair, rawTurn, run };
}

function activeBatch(db, tenantId = 1) {
  const batch = db.prepare(`SELECT b.* FROM ai_usage_batches b JOIN ai_usage_tenant_state s
    ON s.active_batch_id=b.id AND s.tenant_id=b.tenant_id WHERE b.tenant_id=?`).get(tenantId);
  return batch && { ...batch, coverage: JSON.parse(batch.coverage_json), progress: JSON.parse(batch.progress_json) };
}

function sources(db) {
  return db.prepare('SELECT * FROM ai_usage_fact_rows ORDER BY tenant_id,source_key,dataset,row_key').all();
}

function snapshot(db, tenantId = 1) {
  const tables = ['ai_usage_report_rows', 'ai_dashboard_integration_detail', 'ai_dashboard_ai_detail', 'ai_session_summary'];
  return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} WHERE tenant_id=?`).all(tenantId)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
}

function assertDuration(db, milliseconds, { identity = scope, completedTurns } = {}) {
  const [tenantId, , userId, provider, sessionId] = identity;
  const sessionKey = JSON.stringify(identity);
  const report = db.prepare(`SELECT value_json FROM ai_usage_report_rows
    WHERE tenant_id=? AND session_key=? AND dataset='turns' AND json_extract(value_json,'$.status')='completed'`)
    .all(tenantId, sessionKey).map(row => JSON.parse(row.value_json));
  assert.equal(report.reduce((sum, value) => sum + value.durationMs, 0), milliseconds, 'original report duration');
  if (completedTurns != null) assert.equal(report.reduce((sum, value) => sum + value.turnCount, 0), completedTurns);
  assert.equal(db.prepare('SELECT SUM(ai_active_duration_ms) duration FROM ai_dashboard_integration_detail WHERE tenant_id=? AND user_id=?')
    .get(tenantId, userId).duration, milliseconds, 'wide report duration');
  assert.equal(db.prepare('SELECT SUM(ai_active_duration_seconds) duration FROM ai_dashboard_ai_detail WHERE tenant_id=? AND user_id=?')
    .get(tenantId, userId).duration, milliseconds / 1000, 'daily AI duration');
  assert.equal(db.prepare('SELECT ai_active_duration_seconds duration FROM ai_session_summary WHERE tenant_id=? AND provider=? AND session_id=?')
    .get(tenantId, provider, sessionId).duration, milliseconds / 1000, 'session summary duration');
}

const badValues = [
  ['negative duration', { durationMs: -1 }],
  ['fractional duration', { durationMs: 1.5 }],
  ['string duration', { durationMs: '60000' }],
  ['null duration', { durationMs: null }],
  ['missing duration', { durationMs: undefined }],
  ['unsafe duration', { durationMs: Number.MAX_SAFE_INTEGER + 1 }],
  ['missing start', { requestStartedAt: undefined }],
  ['invalid start', { requestStartedAt: 'invalid-time' }],
  ['missing completion', { responseCompletedAt: undefined }],
  ['invalid completion', { responseCompletedAt: 'invalid-time' }],
  ['completion before start', { responseCompletedAt: '2026-09-11T02:04:00.000Z' }],
  ['duration exceeding request interval', { durationMs: 60001 }],
  ['malformed JSON', {}, '{invalid'],
  ['JSON null', {}, 'null'],
  ['JSON array', {}, '[]'],
  ['JSON primitive', {}, '5'],
];

for (const [name, value, rawJson] of badValues) {
  test(`a ${name} record between valid turns is skipped without resetting the session's duration`, async t => {
    const f = fixture(t);
    f.goodPair();
    f.fact('b-bad', value, { rawJson });
    const original = sources(f.db);
    const result = await f.run();
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.published, 1);
    assertDuration(f.db, 300000, { completedTurns: 2 });
    assert.deepEqual(sources(f.db), original, 'retain captured source facts');
    const batch = activeBatch(f.db);
    assert.equal(batch.coverage.skippedDurationRecords, 1);
    assert.equal(batch.progress.durationAnomalies.partitions, 1);
    assert.equal(f.publications[0].skippedDurationRecords, 1);
    assert.equal(f.warnings.length, 1);
    assert.equal(f.warnings[0].batchId, batch.id);
    assert.equal(f.warnings[0].tenantId, 1);
    assert.equal(f.warnings[0].stage, 'partitions');
    assert.equal(f.warnings[0].rowKey, 'b-bad');
    assert.equal(f.warnings[0].sessionKey, JSON.stringify(scope));
    assert.ok(f.warnings[0].reason);
  });
}

for (const occurredAt of [null, 'invalid-time']) {
  test(`a turn with occurred_at=${occurredAt} cannot interrupt valid duration publication`, async t => {
    const f = fixture(t);
    f.goodPair();
    f.fact('b-bad-time');
    f.db.prepare("UPDATE ai_usage_fact_rows SET occurred_at=? WHERE row_key='b-bad-time'").run(occurredAt);
    const original = sources(f.db);
    const result = await f.run();
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assertDuration(f.db, 300000, { completedTurns: 2 });
    assert.deepEqual(sources(f.db), original);
    assert.equal(activeBatch(f.db).coverage.skippedDurationRecords, 1);
    assert.equal(f.warnings[0].rowKey, 'b-bad-time');
  });
}

for (const [name, start, end] of [
  ['invalid completion', '2026-09-11T02:05:00.000Z', 'not-a-completion'],
  ['missing completion', '2026-09-11T02:05:00.000Z', null],
  ['invalid start', 'not-a-start', '2026-09-11T02:06:00.000Z'],
]) {
  test(`captured source ${name} cannot change historical duration or stop publication`, async t => {
    const f = fixture(t);
    f.goodPair();
    f.rawTurn('a-good', time, '2026-09-11T02:02:00.000Z');
    f.rawTurn('b-bad', start, end);
    f.rawTurn('c-good', '2026-09-11T02:10:00.000Z', '2026-09-11T02:13:00.000Z');
    const originals = f.db.prepare('SELECT * FROM ai_usage_turn_facts ORDER BY turn_key').all();
    const result = await f.run();
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assertDuration(f.db, 300000, { completedTurns: 2 });
    assert.deepEqual(f.db.prepare('SELECT * FROM ai_usage_turn_facts ORDER BY turn_key').all(), originals);
    assert.equal(activeBatch(f.db).coverage.skippedDurationRecords, 0);
    assert.deepEqual(f.warnings, []);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ai_usage_fact_rows WHERE dataset='turns' AND source_key LIKE 'turn:%'").get().n, 0);
  });
}

test('unfinished, failed, and unsupported turns retain their non-counting semantics beside valid turns', async t => {
  const f = fixture(t);
  f.goodPair();
  for (const status of ['pending', 'failed', 'aborted', 'cancelled', 'incomplete', 'unsupported']) {
    f.fact(`b-${status}`, { status, durationMs: null, responseCompletedAt: null });
  }
  const result = await f.run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assertDuration(f.db, 300000, { completedTurns: 2 });
  assert.equal(activeBatch(f.db).coverage.skippedDurationRecords, 0);
  assert.deepEqual(f.warnings, []);
});

test('an invalid duration does not isolate other sessions or tenants reusing the same provider session ID', async t => {
  const f = fixture(t, 2);
  f.goodPair();
  f.fact('b-bad', { durationMs: -1 });
  const other = [1, 10, 2, 'claude', 'another-session'];
  f.db.prepare('INSERT INTO users VALUES(2,?) ON CONFLICT(id) DO NOTHING').run('other-user');
  f.interaction(other);
  f.fact('other-session', { durationMs: 240000, requestStartedAt: time,
    responseCompletedAt: '2026-09-11T02:04:00.000Z' }, { identity: other });
  const otherTenant = [2, 20, 2, 'claude', 'shared-session'];
  f.interaction(otherTenant);
  f.fact('other-tenant', { durationMs: 600000, requestStartedAt: time,
    responseCompletedAt: '2026-09-11T02:10:00.000Z' }, { identity: otherTenant });
  const result = await f.run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.published, 2);
  assertDuration(f.db, 300000, { completedTurns: 2 });
  assertDuration(f.db, 240000, { identity: other, completedTurns: 1 });
  assertDuration(f.db, 600000, { identity: otherTenant, completedTurns: 1 });
  assert.equal(activeBatch(f.db).coverage.skippedDurationRecords, 1);
  assert.equal(activeBatch(f.db, 2).coverage.skippedDurationRecords, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_usage_session_issues').get().n, 0);
});

test('a session with only an invalid completed record retains interaction data without fabricated duration', async t => {
  const f = fixture(t);
  f.interaction();
  f.fact('only-bad', { durationMs: -1 });
  const result = await f.run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ai_usage_report_rows WHERE dataset='turns'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ai_usage_report_rows WHERE dataset='interactions'").get().n, 1);
  assert.equal(f.db.prepare('SELECT ai_active_duration_seconds FROM ai_session_summary').get().ai_active_duration_seconds, null);
  assert.equal(f.db.prepare('SELECT ai_active_duration_seconds FROM ai_dashboard_ai_detail').get().ai_active_duration_seconds, null);
  assert.equal(activeBatch(f.db).coverage.skippedDurationRecords, 1);
});

test('a valid lower-priority copy never replaces a selected invalid turn source', async t => {
  const f = fixture(t);
  f.goodPair();
  f.fact('b-bad', {}, { priority: 10, source: 'lower-priority-copy' });
  f.fact('b-bad', { durationMs: -1 }, { priority: 30, source: 'higher-priority-copy' });
  const result = await f.run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assertDuration(f.db, 300000, { completedTurns: 2 });
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ai_usage_fact_rows WHERE row_key='b-bad'").get().n, 2);
  assert.equal(activeBatch(f.db).coverage.skippedDurationRecords, 1);
});

test('skipping an overflowing record preserves both the earlier accumulated duration and later valid turns', async t => {
  const f = fixture(t);
  f.interaction();
  const longTurn = { durationMs: 8000000000000000, requestStartedAt: '-271821-04-20T00:00:00.000Z',
    responseCompletedAt: '2026-09-11T02:06:00.000Z' };
  f.fact('a-long', longTurn);
  f.fact('b-overflow', longTurn);
  f.fact('c-good', { durationMs: 180000, requestStartedAt: '2026-09-11T02:10:00.000Z',
    responseCompletedAt: '2026-09-11T02:13:00.000Z' });
  const result = await f.run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assertDuration(f.db, 8000000000180000, { completedTurns: 2 });
  assert.equal(activeBatch(f.db).coverage.skippedDurationRecords, 1);
  assert.equal(f.warnings[0].rowKey, 'b-overflow');
});

test('pause and resume after an invalid row retain its skip count and never count valid turns twice', async t => {
  const f = fixture(t);
  f.goodPair();
  f.fact('b-bad', { durationMs: -1 });
  const paused = await f.run({ shouldStop: () => {
    const batch = f.db.prepare("SELECT progress_json FROM ai_usage_batches WHERE tenant_id=1 AND status='running'").get();
    const progress = JSON.parse(batch?.progress_json || '{}');
    return progress.partition?.dataset === 'turns' && progress.partition.cursor === 'b-bad';
  } });
  assert.equal(paused.status, 'paused');
  const batch = f.db.prepare("SELECT id,progress_json FROM ai_usage_batches WHERE tenant_id=1 AND status='paused'").get();
  assert.equal(JSON.parse(batch.progress_json).durationAnomalies.partitions, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_usage_report_rows').get().n, 0);

  assert.equal((await f.run()).status, 'completed');
  assert.equal(activeBatch(f.db).id, batch.id);
  assertDuration(f.db, 300000, { completedTurns: 2 });
  assert.equal(activeBatch(f.db).coverage.skippedDurationRecords, 1);
  assert.equal(f.warnings.length, 1);
  const original = snapshot(f.db);
  assert.equal((await f.run()).published, 0);
  assert.deepEqual(snapshot(f.db), original);
});

test('a calculation upgrade rebuilds damaged published duration from unchanged facts without dirty markers', async t => {
  const f = fixture(t);
  f.goodPair();
  const previousVersion = config.calculationVersion.replace(/_duration_isolation_v13.*$/, '');
  assert.notEqual(previousVersion, config.calculationVersion);
  const initial = await f.run({ config: { ...config, calculationVersion: previousVersion } });
  assert.equal(initial.status, 'completed', JSON.stringify(initial));
  assertDuration(f.db, 300000, { completedTurns: 2 });
  const oldBatch = activeBatch(f.db).id;
  const originalFacts = sources(f.db);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_usage_dirty_partitions').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_usage_source_changes').get().n, 0);

  f.db.prepare(`UPDATE ai_usage_report_rows SET value_json=json_set(value_json,'$.durationMs',-1)
    WHERE tenant_id=1 AND dataset='turns'`).run();
  assert.equal(f.db.prepare(`SELECT json_extract(value_json,'$.durationMs') duration
    FROM ai_usage_report_rows WHERE tenant_id=1 AND dataset='turns'`).get().duration, -1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_usage_dirty_partitions').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_usage_source_changes').get().n, 0);

  const upgraded = await f.run({ now: nextNight });
  assert.equal(upgraded.status, 'completed', JSON.stringify(upgraded));
  assert.equal(upgraded.published, 1);
  assert.notEqual(activeBatch(f.db).id, oldBatch);
  assert.equal(activeBatch(f.db).calculation_version, config.calculationVersion);
  assertDuration(f.db, 300000, { completedTurns: 2 });
  assert.deepEqual(sources(f.db), originalFacts, 'rebuild from retained facts without modifying them');
  assert.equal(activeBatch(f.db).coverage.skippedDurationRecords, 0);
  assert.deepEqual(f.warnings, []);
});

test('database errors remain batch failures and preserve the previous published snapshot', async t => {
  const f = fixture(t);
  f.interaction();
  f.fact('a-good', { durationMs: 120000, requestStartedAt: time, responseCompletedAt: '2026-09-11T02:02:00.000Z' });
  await f.run();
  const before = snapshot(f.db);
  const oldBatch = activeBatch(f.db).id;
  f.fact('b-bad', { durationMs: -1 });
  f.fact('c-good', { durationMs: 180000, requestStartedAt: '2026-09-11T02:10:00.000Z',
    responseCompletedAt: '2026-09-11T02:13:00.000Z' });
  f.db.function('simulate_busy', () => {
    const error = new Error('database is locked');
    error.code = 'SQLITE_BUSY';
    throw error;
  });
  f.db.exec(`CREATE TRIGGER fail_duration_publish BEFORE INSERT ON ai_session_summary
    BEGIN SELECT simulate_busy(); END;`);
  const result = await f.run({ now: nextNight });
  assert.equal(result.status, 'partial_failure');
  assert.match(result.errors[0].message, /database is locked/);
  assert.equal(activeBatch(f.db).id, oldBatch);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(f.db.prepare("SELECT status FROM ai_usage_batches WHERE id<>?").get(oldBatch).status, 'failed');

  f.db.exec('DROP TRIGGER fail_duration_publish');
  assert.equal((await f.run({ now: nextNight })).status, 'completed');
  assertDuration(f.db, 300000, { completedTurns: 2 });
  assert.equal(activeBatch(f.db).coverage.skippedDurationRecords, 1);
});

test('lease loss after skipping a bad row aborts and leaves the previous snapshot and replacement lock intact', async t => {
  const f = fixture(t);
  f.goodPair();
  await f.run();
  const before = snapshot(f.db);
  const oldBatch = activeBatch(f.db).id;
  f.fact('b-bad', { durationMs: -1 });
  let replaced = false;
  await assert.rejects(f.run({ now: nextNight, shouldStop: () => {
    const batch = f.db.prepare("SELECT progress_json FROM ai_usage_batches WHERE tenant_id=1 AND status='running'").get();
    const progress = JSON.parse(batch?.progress_json || '{}');
    if (!replaced && progress.durationAnomalies?.partitions === 1) {
      f.db.prepare("UPDATE ai_usage_worker_lock SET lease_token='replacement-owner' WHERE id=1").run();
      replaced = true;
    }
    return false;
  } }), /AI_USAGE_LEASE_LOST/);
  assert.equal(replaced, true);
  assert.equal(activeBatch(f.db).id, oldBatch);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(f.db.prepare('SELECT lease_token FROM ai_usage_worker_lock').get().lease_token, 'replacement-owner');
});

test('a scope violation on a malformed duration row is not downgraded to a harmless duration skip', async t => {
  const f = fixture(t, 2);
  f.goodPair();
  await f.run();
  const before = snapshot(f.db);
  const oldBatch = activeBatch(f.db).id;
  f.fact('b-cross-tenant', { durationMs: -1 });
  f.db.prepare("UPDATE ai_usage_fact_rows SET workspace_id=20 WHERE row_key='b-cross-tenant'").run();
  const result = await f.run({ now: nextNight });
  assert.equal(result.status, 'partial_failure');
  assert.match(result.errors.find(error => error.tenantId === 1).message, /SCOPE_CONFLICT/);
  assert.equal(activeBatch(f.db).id, oldBatch);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(activeBatch(f.db, 2).status, 'published');
});
