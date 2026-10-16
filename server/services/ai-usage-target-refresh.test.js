import assert from 'node:assert/strict';
import test from 'node:test';

import { SPLIT_SCHEMA_VERSION } from '../database/ai-dashboard-split-schema.js';

import { createAiUsageStore } from './ai-usage-db.js';
import { fixture } from './ai-usage-test-fixture.js';

const fullConfig = { leaseMs: 60_000, timeZone: 'Asia/Shanghai', calculationVersion: 'test', incrementalEnabled: false };
const oldSchedule = { scheduledFor: '2026-09-13T18:00:00.000Z', targetThrough: '2026-09-12T16:00:00.000Z' };
const currentSchedule = { scheduledFor: '2026-09-17T18:00:00.000Z', targetThrough: '2026-09-16T16:00:00.000Z' };
const currentTime = new Date('2026-09-17T18:10:00.000Z');

function pendingFull(t) {
  const f = fixture(t);
  f.batch(); f.row({ id: 'published-only', dataset: 'sql_generations', value: { generatedLines: 3 } });
  const store = createAiUsageStore(f.db, { clock: () => currentTime });
  const batch = store.claim(10, oldSchedule, fullConfig);
  batch.source_read_at = oldSchedule.scheduledFor;
  f.db.prepare('UPDATE ai_usage_batches SET source_read_at=? WHERE id=?').run(batch.source_read_at, batch.id);
  const progress = { dataRevision: 7 };
  store.initializeFullRebuild(batch, progress, fullConfig);
  store.put(10, 'verified-file', [{ dataset: 'sql_generations', row_key: 'parsed', stat_date: '2026-09-15', value: { generatedLines: 2 } }]);
  f.db.exec(`INSERT INTO ai_usage_source_states(tenant_id,source_key,offset,size,identity,state_json)
      VALUES(10,'verified-file',123,123,'identity','{"contentFingerprint":"verified"}');
    INSERT INTO ai_usage_source_changes(tenant_id,source_type,source_key) VALUES(10,'message','pending-change');
    INSERT INTO ai_usage_skill_groups VALUES(10,'session-a','retained-group');
    INSERT INTO ai_usage_dirty_skill_sessions(tenant_id,session_key) VALUES(10,'session-a');
    UPDATE ai_usage_tenant_state SET bootstrapped=1,bootstrap_json='{"index":9}' WHERE tenant_id=10;
    DELETE FROM ai_usage_dirty_partitions WHERE tenant_id=10;`);
  f.db.prepare('INSERT INTO ai_usage_batch_files VALUES(?,?,1)').run(batch.id, 'verified-file');
  f.db.prepare("INSERT INTO ai_usage_skill_work_items VALUES(?,'session-a','work','call','item','source')").run(batch.id);
  f.db.prepare("INSERT INTO ai_usage_batch_session_exclusions VALUES(?,10,'session-a','scope-conflict','2026-09-13')").run(batch.id);
  f.row({ id: 'unpublished', dataset: 'sql_generations', value: { generatedLines: 99 }, batchId: batch.id });
  Object.assign(progress, { stage: 'publish', stagingInitialized: true, fileCursor: ['old-file'], sourceCursor: ['message', 'old'],
    partition: { cursor: 'old' }, activity: { ready: true }, integration: { ready: true },
    split: { ready: true, version: SPLIT_SCHEMA_VERSION }, sessionSummary: { ready: true }, sessionConflicts: { ready: true } });
  store.checkpoint(batch, progress, fullConfig);
  return { ...f, store, batch, progress };
}

const tableRows = (db, tables) => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const preservedTables = ['ai_usage_fact_rows', 'ai_usage_source_states', 'ai_usage_source_changes',
  'ai_usage_skill_groups', 'ai_usage_dirty_skill_sessions', 'ai_usage_report_rows',
  'ai_dashboard_integration_detail', 'ai_dashboard_ai_detail', 'ai_dashboard_sql_generation_detail'];
const candidateTables = ['ai_usage_report_staging', 'ai_usage_batch_files', 'ai_usage_skill_work_items', 'ai_usage_batch_session_exclusions'];

test('advancing a prepared full rebuild retains parsed sources and active results while rediscovering and requeueing the complete candidate', t => {
  const f = pendingFull(t);
  const retained = tableRows(f.db, preservedTables);
  const oldActive = f.queryService.status(f.access).batchId;
  assert.equal(f.store.advanceFullRebuildTarget(f.batch, f.progress, currentSchedule, fullConfig), true);
  assert.deepEqual(tableRows(f.db, preservedTables), retained);
  assert.equal(f.queryService.status(f.access).batchId, oldActive, 'advancing the target does not publish a partial candidate');
  for (const table of candidateTables) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE batch_id=?`).get(f.batch.id).n, 0, table);
  assert.deepEqual(f.progress, { dataRevision: 7, fullRebuildInitialized: true,
    originalTargetThrough: oldSchedule.targetThrough, targetRefreshCount: 1, stage: 'bootstrap' });
  const saved = f.db.prepare('SELECT * FROM ai_usage_batches WHERE id=?').get(f.batch.id);
  assert.equal(saved.scheduled_for, oldSchedule.scheduledFor);
  assert.equal(saved.target_through, currentSchedule.targetThrough);
  assert.equal(saved.source_read_at, currentTime.toISOString());
  assert.equal(f.batch.source_read_at, saved.source_read_at);
  assert.deepEqual(JSON.parse(saved.progress_json), f.progress);
  assert.deepEqual(f.db.prepare('SELECT bootstrapped,bootstrap_json FROM ai_usage_tenant_state WHERE tenant_id=10').get(),
    { bootstrapped: 0, bootstrap_json: '{}' });
  assert.deepEqual(f.db.prepare('SELECT stat_date FROM ai_usage_dirty_partitions WHERE tenant_id=10 ORDER BY stat_date').all(),
    [{ stat_date: '2026-09-11' }, { stat_date: '2026-09-15' }], 'both old published days and already parsed later days are rebuilt');
  f.store.initializeFullRebuild(f.batch, f.progress, fullConfig);
  assert.deepEqual(tableRows(f.db, preservedTables), retained, 'resuming the refreshed pass must not invalidate full caches again');
  assert.equal(f.store.advanceFullRebuildTarget(f.batch, f.progress, currentSchedule, fullConfig), false);
  const later = { ...currentSchedule, targetThrough: '2026-09-17T16:00:00.000Z' };
  const afterRefresh = tableRows(f.db, [...preservedTables, 'ai_usage_batches', 'ai_usage_tenant_state']);
  assert.equal(f.store.advanceFullRebuildTarget(f.batch, f.progress, later, fullConfig), false,
    'a slow catch-up pass spanning another window keeps its fixed target instead of starting over forever');
  assert.equal(f.progress.originalTargetThrough, oldSchedule.targetThrough);
  assert.equal(f.progress.targetRefreshCount, 1);
  assert.equal(f.batch.target_through, currentSchedule.targetThrough);
  assert.deepEqual(tableRows(f.db, [...preservedTables, 'ai_usage_batches', 'ai_usage_tenant_state']), afterRefresh);
});

test('a failed catch-up transaction leaves target, source cursors, candidates and caller checkpoint unchanged', t => {
  const f = pendingFull(t);
  const tables = [...preservedTables, ...candidateTables, 'ai_usage_dirty_partitions', 'ai_usage_tenant_state', 'ai_usage_batches'];
  const before = tableRows(f.db, tables);
  const progress = structuredClone(f.progress), batch = structuredClone(f.batch);
  f.db.exec(`CREATE TRIGGER reject_refresh_checkpoint BEFORE UPDATE OF progress_json ON ai_usage_batches
    BEGIN SELECT RAISE(ABORT,'refresh-checkpoint-failed'); END`);
  assert.throws(() => f.store.advanceFullRebuildTarget(f.batch, f.progress, currentSchedule, fullConfig), /refresh-checkpoint-failed/);
  assert.deepEqual(tableRows(f.db, tables), before);
  assert.deepEqual(f.progress, progress);
  assert.deepEqual(f.batch, batch);
});

test('catch-up rejects a lost lease and does not change incremental or non-increasing targets', t => {
  const f = pendingFull(t);
  const before = tableRows(f.db, [...preservedTables, ...candidateTables, 'ai_usage_batches']);
  assert.equal(f.store.advanceFullRebuildTarget(f.batch, f.progress, oldSchedule, fullConfig), false);
  assert.equal(f.store.advanceFullRebuildTarget({ ...f.batch, coverage_json: '{"incrementalEnabled":true}' }, f.progress, currentSchedule, fullConfig), false);
  assert.deepEqual(tableRows(f.db, [...preservedTables, ...candidateTables, 'ai_usage_batches']), before);
  f.db.prepare("UPDATE ai_usage_batches SET lease_token='replacement-owner' WHERE id=?").run(f.batch.id);
  const lost = tableRows(f.db, [...preservedTables, ...candidateTables, 'ai_usage_batches']);
  assert.throws(() => f.store.advanceFullRebuildTarget(f.batch, f.progress, currentSchedule, fullConfig), /AI_USAGE_LEASE_LOST/);
  assert.deepEqual(tableRows(f.db, [...preservedTables, ...candidateTables, 'ai_usage_batches']), lost);
});

test('publication of a caught-up full batch records the completed window and prevents a second full rebuild in that window', t => {
  const f = pendingFull(t);
  f.store.advanceFullRebuildTarget(f.batch, f.progress, currentSchedule, fullConfig);
  f.store.initializeStaging(f.batch, f.progress, fullConfig);
  Object.assign(f.progress, { stage: 'publish', integration: { ready: true }, split: { ready: true, version: SPLIT_SCHEMA_VERSION } });
  f.store.checkpoint(f.batch, f.progress, fullConfig);
  f.store.publish(f.batch, { completedWindowScheduledFor: currentSchedule.scheduledFor });
  const published = f.db.prepare('SELECT * FROM ai_usage_batches WHERE id=?').get(f.batch.id);
  assert.equal(published.status, 'published');
  assert.equal(JSON.parse(published.coverage_json).completedWindowScheduledFor, currentSchedule.scheduledFor);
  assert.equal(f.store.claim(10, currentSchedule, fullConfig), null);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_usage_batches WHERE tenant_id=10').get().n, 2);
});

test('a completion marker cannot hide an older cutoff or suppress a later window', t => {
  const f = fixture(t);
  f.batch('old-published', 10, 'published', { incrementalEnabled: false, completedWindowScheduledFor: currentSchedule.scheduledFor });
  const store = createAiUsageStore(f.db, { clock: () => currentTime });
  const next = store.claim(10, currentSchedule, fullConfig);
  assert.ok(next, 'the completion marker is insufficient when the published target still lags');
  assert.equal(next.target_through, currentSchedule.targetThrough);
  store.finish(next, 'published');
  const later = { scheduledFor: '2026-09-18T18:00:00.000Z', targetThrough: '2026-09-17T16:00:00.000Z' };
  assert.ok(store.claim(10, later, fullConfig), 'a completed window never suppresses a genuinely new night');
});
