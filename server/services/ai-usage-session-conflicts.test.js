import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { AI_USAGE_SCHEMA_SQL } from '../database/ai-usage-schema.js';

import { prepareSessionConflicts, publishSessionConflictIssues, recordSessionConflict,
  sessionConflictCoverage, validateSessionConflictCandidate, isSessionSourceScopeConflict } from './ai-usage-session-conflicts.js';
import { scopeValidator } from './ai-usage-session-source.js';
import { sessionScope } from './ai-usage-session-report.js';

const identity = [1, 10, 3, 'claude', 'session-a'];
const key = JSON.stringify(identity);
const now = () => new Date('2026-09-12T18:10:00.000Z');

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(AI_USAGE_SCHEMA_SQL);
  db.exec(`CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER);
    CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT);
    INSERT INTO workspaces VALUES(10,1),(20,1),(30,2);`);
  const warnings = [];
  const store = { database: db, assertLease() {}, checkpoint() {}, transaction: fn => db.transaction(fn).immediate() };
  const batch = { id: 'first', tenant_id: 1, target_through: '2026-09-12T16:00:00.000Z', time_zone: 'Asia/Shanghai' };
  const progress = {};
  const args = { store, batch, progress, config: { batchSize: 2, timeZone: 'Asia/Shanghai' }, now,
    checkWindow() {}, checkpoint: async () => {}, logger: { warn: (...message) => warnings.push(message) } };
  function current(scope = [1, 20, 3, 'claude', 'session-a']) {
    db.prepare('INSERT INTO session_index VALUES(?,?,?,?,?)').run(...scope);
  }
  function fact(dataset, id, { sessionKey = key, date = '2026-09-11', published = false,
    staged = false, userId, value = {} } = {}) {
    const scope = JSON.parse(sessionKey);
    const values = { tenant: scope[0], dataset, id, date, user: userId ?? scope[2], workspace: scope[1], key: sessionKey,
      value: JSON.stringify({ provider: scope[3], providerSessionId: scope[4], ...value }) };
    const columns = 'tenant_id,dataset,row_key,stat_date,user_id,workspace_id,session_key,value_json';
    const params = '@tenant,@dataset,@id,@date,@user,@workspace,@key,@value';
    if (staged) db.prepare(`INSERT INTO ai_usage_report_staging(batch_id,${columns}) VALUES(@batch,${params})`)
      .run({ ...values, batch: batch.id });
    else if (published) db.prepare(`INSERT INTO ai_usage_report_rows(${columns}) VALUES(${params})`).run(values);
    else db.prepare(`INSERT INTO ai_usage_fact_rows(source_key,${columns}) VALUES(@id,${params})`).run(values);
  }
  return { db, store, batch, progress, args, current, fact, warnings };
}

test('quarantines full session identities once, keeps facts, and queues original and published partitions', async t => {
  const f = fixture(t);
  f.current();
  f.fact('interactions', 'a');
  f.fact('interactions', 'b');
  f.fact('turns', 'published-turn', { date: '2026-09-10', published: true });
  f.fact('skill_invocations', 'skill', { userId: 7, value: { callerUserId: 3 } });
  f.fact('sql_generations', 'sql');
  await prepareSessionConflicts(f.args);
  assert.deepEqual(sessionConflictCoverage(f.db, f.batch), { sessionScope: 'partial', excludedSessionCount: 1 });
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM ai_usage_fact_rows').get().count, 4);
  const issue = f.db.prepare('SELECT * FROM ai_usage_session_issues').get();
  assert.equal(issue.status, 'open');
  assert.equal(issue.first_seen_at, now().toISOString());
  assert.deepEqual(JSON.parse(issue.expected_json), { tenant_id: 1, workspace_id: 10 });
  assert.deepEqual(JSON.parse(issue.actual_json), [{ tenant_id: 1, workspace_id: 20 }]);
  assert.deepEqual(f.db.prepare('SELECT dataset,stat_date FROM ai_usage_dirty_partitions ORDER BY dataset').all(), [
    { dataset: 'interactions', stat_date: '2026-09-11' },
    { dataset: 'skill_invocations', stat_date: '2026-09-11' },
    { dataset: 'sql_generations', stat_date: '2026-09-11' },
    { dataset: 'turns', stat_date: '2026-09-10' },
  ]);
  assert.deepEqual(f.progress.sessionConflicts, { ready: true, version: 1 });
  await prepareSessionConflicts(f.args);
  assert.equal(f.warnings.length, 1);
  assert.deepEqual(f.warnings[0][1].expected, { tenant_id: 1, workspace_id: 10 });
  assert.deepEqual(f.warnings[0][1].actual, [{ tenant_id: 1, workspace_id: 20 }]);
});

test('same-batch exclusions are monotonic; the next successful publication resolves and restores historical partitions', async t => {
  const f = fixture(t);
  f.current();
  f.fact('interactions', 'a');
  await prepareSessionConflicts(f.args);
  f.db.exec('UPDATE session_index SET workspace_id=10; DELETE FROM ai_usage_dirty_partitions');
  delete f.progress.sessionConflicts;
  await prepareSessionConflicts(f.args);
  assert.equal(publishSessionConflictIssues(f.db, f.batch, now()), 0);
  assert.equal(sessionConflictCoverage(f.db, f.batch).excludedSessionCount, 1);
  const next = { ...f.batch, id: 'second' };
  f.db.exec('DELETE FROM ai_usage_dirty_partitions');
  await prepareSessionConflicts({ ...f.args, batch: next, progress: {} });
  assert.equal(f.db.prepare('SELECT status FROM ai_usage_session_issues').get().status, 'open');
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM ai_usage_dirty_partitions').get().count, 1);
  assert.deepEqual(sessionConflictCoverage(f.db, next), { sessionScope: 'complete', excludedSessionCount: 0 });
  assert.equal(publishSessionConflictIssues(f.db, next, now()), 1);
  const resolved = f.db.prepare('SELECT * FROM ai_usage_session_issues').get();
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolved_batch_id, 'second');
  assert.equal(resolved.first_seen_at, now().toISOString());
});

test('future-only sessions and other owners do not enter the current exclusion count', async t => {
  const f = fixture(t);
  f.current();
  f.fact('interactions', 'future', { date: '2026-09-13' });
  f.fact('interactions', 'other-user', { sessionKey: JSON.stringify([1, 10, 4, 'claude', 'session-a']) });
  f.fact('interactions', 'other-provider', { sessionKey: JSON.stringify([1, 10, 3, 'codex', 'session-a']) });
  f.fact('interactions', 'other-tenant', { sessionKey: JSON.stringify([2, 30, 5, 'claude', 'session-a']) });
  await prepareSessionConflicts(f.args);
  assert.equal(sessionConflictCoverage(f.db, f.batch).excludedSessionCount, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM ai_usage_session_issues').get().count, 0);
});

test('workspace and fact scope errors remain fatal even when current session metadata also conflicts', async t => {
  const f = fixture(t);
  f.current();
  f.fact('interactions', 'bad-user', { userId: 4 });
  await assert.rejects(prepareSessionConflicts(f.args), /SESSION_SUMMARY_FACT_SCOPE_CONFLICT/);
  f.db.exec('UPDATE ai_usage_fact_rows SET user_id=3; UPDATE workspaces SET tenant_id=2 WHERE id=10');
  await assert.rejects(prepareSessionConflicts(f.args), /SESSION_SUMMARY_WORKSPACE_SCOPE_CONFLICT/);
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM ai_usage_batch_session_exclusions').get().count, 0);
});

test('late SQL-only conflicts include structured scope and can be recorded inside the reset transaction', t => {
  const f = fixture(t);
  f.fact('sql_generations', 'late-sql', { staged: true });
  validateSessionConflictCandidate(f.db, f.batch);
  f.current();
  let conflict;
  assert.throws(() => validateSessionConflictCandidate(f.db, f.batch), error => {
    conflict = error;
    return isSessionSourceScopeConflict(error) && error.scope.session_key === key;
  });
  f.store.transaction(() => recordSessionConflict({ ...f.args, error: conflict }));
  assert.equal(sessionConflictCoverage(f.db, f.batch).excludedSessionCount, 1);
  assert.equal(f.db.prepare('SELECT status FROM ai_usage_session_issues').get().status, 'open');
  assert.deepEqual(f.warnings[0][1].actual, [{ tenant_id: 1, workspace_id: 20 }]);
  assert.equal(isSessionSourceScopeConflict(new Error('SESSION_SUMMARY_SOURCE_SCOPE_CONFLICT')), false);
});

test('duplicate original owners are reported while a different user with the same provider ID is valid', t => {
  const f = fixture(t);
  f.current(identity);
  f.current([1, 20, 4, 'claude', 'session-a']);
  scopeValidator(f.db)(sessionScope(key, 1));
  f.current(identity);
  assert.throws(() => scopeValidator(f.db)(sessionScope(key, 1)), error => {
    return isSessionSourceScopeConflict(error) && error.actual.length === 2;
  });
});

test('page checkpoints resume without repeating issue counts or warnings', async t => {
  const f = fixture(t);
  f.current();
  f.fact('interactions', 'first');
  f.fact('interactions', 'second', { sessionKey: JSON.stringify([1, 10, 3, 'claude', 'session-b']) });
  f.args.config.batchSize = 1;
  await assert.rejects(prepareSessionConflicts({ ...f.args, checkpoint: async () => {
    throw new Error('test pause after saved page');
  } }), /test pause/);
  assert.equal(f.progress.sessionConflicts.ready, false);
  assert.equal(f.progress.sessionConflicts.cursor, key);
  await prepareSessionConflicts(f.args);
  assert.deepEqual(f.progress.sessionConflicts, { ready: true, version: 1 });
  assert.equal(sessionConflictCoverage(f.db, f.batch).excludedSessionCount, 1);
  assert.equal(f.warnings.length, 1);
});

test('issue resolution rolls back together with a failed publication', async t => {
  const f = fixture(t);
  f.current();
  f.fact('interactions', 'first');
  await prepareSessionConflicts(f.args);
  f.db.exec('UPDATE session_index SET workspace_id=10');
  const batch = { ...f.batch, id: 'repaired' };
  await prepareSessionConflicts({ ...f.args, batch, progress: {} });
  assert.throws(() => f.store.transaction(() => {
    assert.equal(publishSessionConflictIssues(f.db, batch, now()), 1);
    throw new Error('test publication failed');
  }), /test publication failed/);
  assert.equal(f.db.prepare('SELECT status FROM ai_usage_session_issues').get().status, 'open');
  assert.equal(publishSessionConflictIssues(f.db, batch, now()), 1);
});

test('publication keeps a source-less issue open if its metadata conflicts again after preparation', async t => {
  const f = fixture(t);
  f.current();
  f.fact('interactions', 'first');
  await prepareSessionConflicts(f.args);
  f.db.exec('DELETE FROM ai_usage_fact_rows; UPDATE session_index SET workspace_id=10');
  const batch = { ...f.batch, id: 'no-source' };
  await prepareSessionConflicts({ ...f.args, batch, progress: {} });
  assert.equal(f.db.prepare('SELECT last_check_conflict FROM ai_usage_session_issues').get().last_check_conflict, 0);
  assert.equal(sessionConflictCoverage(f.db, batch).excludedSessionCount, 0);
  f.db.exec('UPDATE session_index SET workspace_id=30,tenant_id=2');
  const publicationTime = new Date('2026-09-12T18:11:00.000Z');
  f.store.transaction(() => {
    validateSessionConflictCandidate(f.db, batch);
    assert.equal(publishSessionConflictIssues(f.db, batch, publicationTime), 0);
  });
  const issue = f.db.prepare('SELECT * FROM ai_usage_session_issues').get();
  assert.equal(issue.status, 'open');
  assert.equal(issue.last_check_conflict, 1);
  assert.equal(issue.last_seen_at, publicationTime.toISOString());
  assert.deepEqual(JSON.parse(issue.actual_json), [{ tenant_id: 2, workspace_id: 30 }]);
  assert.equal(sessionConflictCoverage(f.db, batch).excludedSessionCount, 0);
});
