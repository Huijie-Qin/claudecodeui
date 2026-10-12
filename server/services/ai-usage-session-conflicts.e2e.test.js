import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';

import { readAiUsageConfig } from './ai-usage-config.js';
import { createAiUsageStore } from './ai-usage-db.js';
import { runAiUsageWindow } from './ai-usage-batches.js';

const config = readAiUsageConfig({ AI_USAGE_ENABLED: 'true' });
const night = () => new Date('2026-09-11T18:10:00.000Z');
const nextNight = () => new Date('2026-09-12T18:10:00.000Z');
const time = '2026-09-11T02:00:00.000Z';
const good = [1, 10, 1, 'claude', 'good-session'];
const conflict = [1, 10, 2, 'claude', 'conflicting-session'];
const quietLogger = { info() {}, warn() {}, error() {} };

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER,display_name TEXT,status TEXT);
    CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,
      provider TEXT,provider_session_id TEXT,status TEXT);
    INSERT INTO tenants VALUES(1,'active'),(2,'active');
    INSERT INTO users VALUES(1,'alice'),(2,'bob'),(3,'carol'),(4,'dave');
    INSERT INTO workspaces VALUES(10,1,'Primary','active'),(11,1,'Another workspace','active'),
      (20,2,'Other tenant','active');`);
  migrateAiUsageSchema(db);
  const store = createAiUsageStore(db, { clock: night });

  function session(scope, durationMs = 120000) {
    const [tenantId, workspaceId, userId, provider, sessionId] = scope;
    const key = JSON.stringify(scope);
    const base = { stat_date: '2026-09-11', user_id: userId, workspace_id: workspaceId,
      session_key: key, occurred_at: time };
    const value = { provider, providerSessionId: sessionId, userName: `user-${userId}`, workspaceName: 'Primary' };
    // Seed captured source facts, then run the complete production batch pipeline.
    // No user database, session files, network calls, or mocked stores are used.
    store.put(tenantId, `fixture:${key}`, [
      { ...base, dataset: 'interactions', row_key: `interaction:${key}`, value },
      { ...base, dataset: 'turns', row_key: `turn:${key}`, value: { ...value,
        turnKey: `turn:${key}`, status: 'completed', durationMs, requestStartedAt: time,
        responseCompletedAt: new Date(Date.parse(time) + durationMs).toISOString() } },
      { ...base, dataset: 'skill_invocations', row_key: `skill:${key}`, subject_id: `skill-${userId}`,
        value: { ...value, skillId: `skill-${userId}`, skillName: `skill-${userId}`,
          callerUserId: userId, callerUserName: `user-${userId}`, publisherUserId: userId } },
      { ...base, dataset: 'sql_generations', row_key: `sql:${key}`,
        value: { ...value, generatedLines: 3 } },
    ]);
    db.prepare('INSERT INTO session_index VALUES(?,?,?,?,?,?)').run(...scope, 'active');
    return key;
  }

  function independentFacts(scope) {
    const [tenantId, workspaceId, userId] = scope;
    const base = { stat_date: '2026-09-11', user_id: userId, workspace_id: workspaceId,
      session_key: JSON.stringify(scope), occurred_at: time };
    store.put(tenantId, 'fixture:independent-business-records', [
      { ...base, dataset: 'hook_records', row_key: 'business-hook', subject_id: 'hook-1',
        value: { hookId: 'hook-1', hookName: 'Business record', recordType: 'custom',
          postActionId: 'save', hookVersion: 1, recordSource: 'hook', fields: [] } },
      { ...base, dataset: 'skill_publications', row_key: 'independent-skill', subject_id: 'published-skill',
        value: { skillId: 'published-skill', skillName: 'Published skill', publisherUserId: userId } },
      { ...base, dataset: 'code_submissions', row_key: 'independent-commit', subject_id: 'independent-commit',
        value: { repositoryUrl: 'https://example.invalid/repo', commitSha: 'abc123', submittedLines: 7 } },
    ]);
  }

  function move(scope, workspaceId = 11) {
    db.prepare(`UPDATE session_index SET workspace_id=? WHERE tenant_id=? AND workspace_id=?
      AND user_id=? AND provider=? AND provider_session_id=?`).run(workspaceId, ...scope);
  }

  const run = (options = {}) => runAiUsageWindow({ database: db, config, now: night,
    logger: quietLogger, ...options });
  return { db, session, independentFacts, move, run };
}

function rows(db, dataset, tenantId = 1) {
  return db.prepare('SELECT * FROM ai_usage_report_rows WHERE tenant_id=? AND dataset=? ORDER BY stat_date,row_key')
    .all(tenantId, dataset).map(row => ({ ...row, value: JSON.parse(row.value_json) }));
}

function currentBatch(db, tenantId = 1) {
  const batch = db.prepare(`SELECT b.* FROM ai_usage_batches b JOIN ai_usage_tenant_state s
    ON s.active_batch_id=b.id AND s.tenant_id=b.tenant_id WHERE b.tenant_id=?`).get(tenantId);
  return batch && { ...batch, coverage: JSON.parse(batch.coverage_json) };
}

function sourceFacts(db) {
  return db.prepare('SELECT * FROM ai_usage_fact_rows ORDER BY tenant_id,source_key,dataset,row_key').all();
}

function runningProgress(db) {
  const batch = db.prepare("SELECT progress_json FROM ai_usage_batches WHERE tenant_id=1 AND status='running'").get();
  return batch && JSON.parse(batch.progress_json);
}

function assertSessionProjection(db, expectedScopes) {
  const keys = expectedScopes.map(scope => JSON.stringify(scope)).sort();
  for (const dataset of ['interactions', 'turns', 'skill_invocations', 'sql_generations', 'session_usage']) {
    assert.deepEqual(rows(db, dataset).map(row => row.session_key).sort(), keys, dataset);
  }
  const expectedUsers = [...new Set(expectedScopes.map(scope => scope[2]))].sort();
  for (const dataset of ['daily_active_users', 'active_users']) {
    assert.deepEqual([...new Set(rows(db, dataset).map(row => row.user_id))].sort(), expectedUsers, dataset);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_dashboard_ai_detail WHERE tenant_id=1').get().n, keys.length);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_dashboard_skill_invocation_detail WHERE tenant_id=1').get().n, keys.length);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_dashboard_sql_generation_detail WHERE tenant_id=1').get().n, keys.length);
  assert.deepEqual(db.prepare(`SELECT tenant_id,workspace_id,user_id,provider,session_id
    FROM ai_session_summary WHERE tenant_id=1 ORDER BY user_id,provider,session_id`).all()
    .map(row => [row.tenant_id, row.workspace_id, row.user_id, row.provider, row.session_id]).sort(),
  [...expectedScopes].sort());
}

test('one conflicting session is excluded consistently while independent business records still publish', async t => {
  const { db, session, independentFacts, move, run } = fixture(t);
  session(good);
  const badKey = session(conflict, 600000);
  independentFacts(conflict);
  move(conflict);
  const originalFacts = sourceFacts(db);
  const warnings = [];
  const result = await run({ logger: { ...quietLogger, warn: (...args) => warnings.push(args) } });

  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.published, 2);
  const batch = currentBatch(db);
  assert.equal(batch.status, 'published');
  assert.equal(batch.error, null);
  assert.equal(batch.coverage.sessionScope, 'partial');
  assert.equal(batch.coverage.excludedSessionCount, 1);
  assertSessionProjection(db, [good]);
  assert.equal(rows(db, 'turns')[0].value.durationMs, 120000);
  assert.equal(db.prepare('SELECT ai_active_duration_seconds FROM ai_session_summary WHERE tenant_id=1').get().ai_active_duration_seconds, 120);
  assert.equal(db.prepare('SELECT SUM(ai_active_duration_ms) total FROM ai_dashboard_integration_detail WHERE tenant_id=1').get().total, 120000);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_dashboard_integration_detail WHERE tenant_id=1').get().n, 6);
  assert.equal(rows(db, 'hook_records')[0].row_key, 'business-hook');
  assert.equal(rows(db, 'hook_daily')[0].value.recordCount, 1);
  assert.equal(rows(db, 'skill_publications')[0].row_key, 'independent-skill');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_dashboard_skill_publication_detail WHERE tenant_id=1').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_dashboard_code_submission_detail WHERE tenant_id=1').get().n, 1);
  assert.deepEqual(sourceFacts(db), originalFacts);
  const issue = db.prepare('SELECT * FROM ai_usage_session_issues WHERE tenant_id=1').get();
  assert.equal(issue.session_key, badKey);
  assert.equal(issue.reason, 'SESSION_SUMMARY_SOURCE_SCOPE_CONFLICT');
  assert.equal(issue.status, 'open');
  assert.deepEqual(JSON.parse(issue.expected_json), { tenant_id: 1, workspace_id: 10 });
  assert.deepEqual(JSON.parse(issue.actual_json), [{ tenant_id: 1, workspace_id: 11 }]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_batch_session_exclusions WHERE batch_id=?').get(batch.id).n, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /\[AI usage\]/);
  assert.equal(warnings[0][1].reason, 'SESSION_SUMMARY_SOURCE_SCOPE_CONFLICT');
  assert.equal(warnings[0][1].sessionKey, badKey);
});

test('reused provider IDs in other tenants, providers, and users are not excluded together', async t => {
  const { db, session, move, run } = fixture(t);
  const sameId = 'reused-provider-session-id';
  const bad = [1, 10, 1, 'claude', sameId];
  const otherUser = [1, 10, 2, 'claude', sameId];
  const otherProvider = [1, 10, 1, 'codex', sameId];
  const otherTenant = [2, 20, 3, 'claude', sameId];
  for (const scope of [bad, otherUser, otherProvider, otherTenant]) session(scope);
  move(bad);
  const result = await run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assertSessionProjection(db, [otherUser, otherProvider]);
  assert.deepEqual(rows(db, 'interactions', 2).map(row => row.session_key), [JSON.stringify(otherTenant)]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_session_summary WHERE tenant_id=2').get().n, 1);
  assert.equal(currentBatch(db).coverage.excludedSessionCount, 1);
  assert.equal(currentBatch(db, 2).coverage.excludedSessionCount, 0);
  assert.equal(currentBatch(db, 2).coverage.sessionScope, 'complete');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_session_issues').get().n, 1);
});

test('repairing only ownership metadata restores historical metrics in the next window and resolves the issue', async t => {
  const { db, session, move, run } = fixture(t);
  session(good);
  const badKey = session(conflict, 600000);
  move(conflict);
  await run();
  const oldBatch = currentBatch(db);
  const originalFacts = sourceFacts(db);
  const issueBefore = db.prepare('SELECT * FROM ai_usage_session_issues WHERE session_key=?').get(badKey);
  db.prepare('UPDATE session_index SET workspace_id=10 WHERE user_id=2').run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_source_changes').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_dirty_partitions').get().n, 0);

  const result = await run({ now: nextNight });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const batch = currentBatch(db);
  assert.notEqual(batch.id, oldBatch.id);
  assert.equal(batch.coverage.excludedSessionCount, 0);
  assert.equal(batch.coverage.sessionScope, 'complete');
  assertSessionProjection(db, [good, conflict]);
  assert.equal(rows(db, 'turns').reduce((sum, row) => sum + row.value.durationMs, 0), 720000);
  assert.ok(rows(db, 'interactions').every(row => row.stat_date === '2026-09-11'));
  assert.deepEqual(sourceFacts(db), originalFacts);
  const issue = db.prepare('SELECT * FROM ai_usage_session_issues WHERE session_key=?').get(badKey);
  assert.equal(issue.status, 'resolved');
  assert.equal(issue.first_seen_at, issueBefore.first_seen_at);
  assert.equal(issue.resolved_batch_id, batch.id);
  assert.ok(issue.resolved_at);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_session_issues').get().n, 1);
});

test('pausing and resuming a partial candidate keeps one issue and one exclusion per batch', async t => {
  const { db, session, move, run } = fixture(t);
  session(good);
  session(conflict);
  move(conflict);
  const paused = await run({ config: { ...config, batchSize: 1 }, shouldStop: () => {
    const progress = runningProgress(db);
    return Boolean(progress?.partition?.cursor && db.prepare('SELECT COUNT(*) n FROM ai_usage_batch_session_exclusions').get().n);
  } });
  assert.equal(paused.status, 'paused');
  const batch = db.prepare("SELECT * FROM ai_usage_batches WHERE tenant_id=1 AND status='paused'").get();
  assert.ok(batch);
  assert.equal(currentBatch(db), undefined);
  const firstSeen = db.prepare('SELECT first_seen_at FROM ai_usage_session_issues').get().first_seen_at;

  assert.equal((await run({ config: { ...config, batchSize: 1 } })).status, 'completed');
  assert.equal(currentBatch(db).id, batch.id);
  assert.equal(currentBatch(db).coverage.excludedSessionCount, 1);
  assertSessionProjection(db, [good]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_session_issues').get().n, 1);
  assert.equal(db.prepare('SELECT first_seen_at FROM ai_usage_session_issues').get().first_seen_at, firstSeen);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_batch_session_exclusions WHERE batch_id=?').get(batch.id).n, 1);
  assert.equal((await run()).published, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_session_issues').get().n, 1);
  assert.equal(currentBatch(db).coverage.excludedSessionCount, 1);
});

test('ownership changing after the summary is prepared rebuilds every projection before publication', async t => {
  const { db, session, move, run } = fixture(t);
  session(good);
  session(conflict, 600000);
  let injected = false;
  const result = await run({ shouldStop: () => {
    const progress = runningProgress(db);
    if (!injected && progress?.stage === 'publish' && progress.sessionSummary?.ready) {
      move(conflict);
      injected = true;
    }
    return false;
  } });
  assert.equal(injected, true);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assertSessionProjection(db, [good]);
  assert.equal(currentBatch(db).coverage.excludedSessionCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_session_issues').get().n, 1);
});

test('SQL-only sessions receive the same ownership isolation without needing an interaction row', async t => {
  const { db, session, move, run } = fixture(t);
  session(good);
  const badKey = session(conflict);
  db.prepare("DELETE FROM ai_usage_fact_rows WHERE session_key=? AND dataset<>'sql_generations'").run(badKey);
  move(conflict);
  const result = await run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assertSessionProjection(db, [good]);
  assert.equal(currentBatch(db).coverage.excludedSessionCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_fact_rows WHERE session_key=?').get(badKey).n, 1);
});

test('real publication failures retain the published snapshot and do not resolve a repair prematurely', async t => {
  const { db, session, move, run } = fixture(t);
  session(good);
  session(conflict);
  move(conflict);
  await run();
  const oldBatch = currentBatch(db);
  const oldReport = db.prepare('SELECT * FROM ai_usage_report_rows WHERE tenant_id=1 ORDER BY dataset,stat_date,row_key').all();
  const oldSummary = db.prepare('SELECT * FROM ai_session_summary WHERE tenant_id=1').all();
  db.exec(`UPDATE session_index SET workspace_id=10 WHERE user_id=2;
    CREATE TRIGGER fail_conflict_repair_publish BEFORE INSERT ON ai_session_summary WHEN NEW.tenant_id=1
      BEGIN SELECT RAISE(ABORT,'simulated publication failure'); END;`);
  const result = await run({ now: nextNight });
  assert.equal(result.status, 'partial_failure');
  assert.ok(result.errors.some(error => /simulated publication failure/.test(error.message)));
  assert.equal(currentBatch(db).id, oldBatch.id);
  assert.deepEqual(db.prepare('SELECT * FROM ai_usage_report_rows WHERE tenant_id=1 ORDER BY dataset,stat_date,row_key').all(), oldReport);
  assert.deepEqual(db.prepare('SELECT * FROM ai_session_summary WHERE tenant_id=1').all(), oldSummary);
  assert.equal(db.prepare('SELECT status FROM ai_usage_session_issues WHERE tenant_id=1').get().status, 'open');
  assert.equal(db.prepare("SELECT status FROM ai_usage_batches WHERE tenant_id=1 AND id<>?").get(oldBatch.id).status, 'failed');

  db.exec('DROP TRIGGER fail_conflict_repair_publish');
  assert.equal((await run({ now: nextNight })).status, 'completed');
  assertSessionProjection(db, [good, conflict]);
  assert.equal(db.prepare('SELECT status FROM ai_usage_session_issues WHERE tenant_id=1').get().status, 'resolved');
});

test('an old calculation version paused at publication rebuilds its candidate using session exclusions', async t => {
  const { db, session, move, run } = fixture(t);
  session(good);
  session(conflict);
  const oldConfig = { ...config, calculationVersion: 'pre-session-conflict-isolation' };
  const paused = await run({ config: oldConfig, shouldStop: () => {
    const progress = runningProgress(db);
    return Boolean(progress?.stage === 'publish' && progress.sessionSummary?.ready);
  } });
  assert.equal(paused.status, 'paused');
  const oldBatch = db.prepare("SELECT id FROM ai_usage_batches WHERE tenant_id=1 AND status='paused'").get();
  move(conflict);
  const result = await run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(currentBatch(db).id, oldBatch.id);
  assert.equal(currentBatch(db).calculation_version, config.calculationVersion);
  assert.equal(currentBatch(db).coverage.excludedSessionCount, 1);
  assertSessionProjection(db, [good]);
});
