import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';
import { SPLIT_SCHEMA_VERSION } from '../database/ai-dashboard-split-schema.js';

import { fixture } from './ai-usage-test-fixture.js';
import { createAiUsageStore } from './ai-usage-db.js';
import { createAiUsageQueryService } from './ai-usage-query.js';
import { integrationWriter } from './ai-dashboard-integration.js';
import { splitWriter } from './ai-dashboard-split.js';


const clock = () => new Date('2026-09-13T18:10:00.000Z');
const config = { leaseMs: 60000, timeZone: 'Asia/Shanghai', calculationVersion: 'test' };
function candidate(db) {
  const store = createAiUsageStore(db, { clock });
  const batch = store.claim(10, { scheduledFor: '2026-09-13T18:00:00.000Z', targetThrough: '2026-09-13T16:00:00.000Z' }, config);
  const progress = { stage: 'partitions' };
  store.initializeStaging(batch, progress, config);
  const ready = () => {
    const write = integrationWriter(db, true);
    for (const row of db.prepare('SELECT * FROM ai_usage_report_staging WHERE batch_id=? ORDER BY dataset,stat_date,row_key').all(batch.id)) write(row, '2026-09-14 02:10:00', batch.id);
    progress.integration = { ready: true };
    const split = splitWriter(db, true);
    for (const row of db.prepare('SELECT * FROM ai_dashboard_integration_staging WHERE batch_id=?').all(batch.id)) split(row, batch.id);
    progress.split = { ready: true, version: SPLIT_SCHEMA_VERSION };
    progress.stage = 'publish'; store.checkpoint(batch, progress, config);
  };
  return { store, batch, progress, ready };
}

test('staging is invisible until ready; interrupted promotion rolls back all formal rows and metadata', (t) => {
  const f = fixture(t);
  f.batch(); f.row({ id: 'first', dataset: 'interactions' });
  f.batch('other-tenant', 20); f.row({ id: 'other', dataset: 'interactions', batchId: 'other-tenant', tenantId: 20 });
  const before = f.db.prepare('SELECT * FROM ai_usage_report_rows ORDER BY tenant_id').all();
  const { store, batch, ready } = candidate(f.db);
  f.row({ id: 'second', dataset: 'interactions', sessionKey: 'session-b', batchId: batch.id });
  assert.equal(f.queryService.overview(f.access).sessionCount, 1);
  assert.throws(() => store.publish(batch, {}), /AI_USAGE_REPORT_NOT_READY/);
  ready();
  f.db.exec(`CREATE TRIGGER fail_publish BEFORE INSERT ON ai_usage_report_rows
    WHEN NEW.tenant_id=10 AND NEW.row_key='second' BEGIN SELECT RAISE(ABORT,'test write failure'); END;`);
  assert.throws(() => store.publish(batch, {}), /test write failure/);
  assert.deepEqual(f.db.prepare('SELECT * FROM ai_usage_report_rows ORDER BY tenant_id').all(), before);
  assert.equal(f.queryService.status(f.access).batchId, 'batch-1');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_usage_report_staging WHERE batch_id=?').get(batch.id).n, 2);
  f.db.exec('DROP TRIGGER fail_publish');
  store.publish(batch, {});
  assert.equal(f.queryService.overview(f.access).sessionCount, 2);
  assert.equal(f.queryService.status(f.access).batchId, batch.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_usage_report_staging').get().n, 0);
  assert.deepEqual(f.db.prepare('SELECT * FROM ai_usage_report_rows WHERE tenant_id=20').all(), before.filter((row) => row.tenant_id === 20));
  assert.throws(() => f.queryService.overview(f.access, { batchId: 'batch-1' }), { code: 'reportUpdated' });
  assert.equal(f.db.prepare('PRAGMA table_info(ai_usage_report_rows)').all().some((column) => column.name === 'partition_id'), false);
});

test('first batch can publish empty results, but never advertises incomplete staging', (t) => {
  const f = fixture(t);
  const { store, batch, ready } = candidate(f.db);
  assert.equal(f.queryService.status(f.access).batchId, null);
  assert.equal(f.queryService.overview(f.access).sessionCount, null);
  ready(); store.publish(batch, {});
  assert.equal(f.queryService.overview(f.access).sessionCount, 0);
  assert.equal(f.queryService.status(f.access).batchId, batch.id);
});

test('current report keys isolate dates, datasets and tenants without a version partition', (t) => {
  const f = fixture(t); f.batch();
  f.row({ id: 'same', dataset: 'interactions' });
  f.row({ id: 'same', dataset: 'interactions', date: '2026-09-12' });
  f.row({ id: 'same', dataset: 'turns' });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_usage_report_rows').get().n, 3);
  assert.throws(() => f.row({ id: 'same', dataset: 'turns' }), /UNIQUE/);
});

function legacy(f) {
  f.batch('old'); f.batch('batch-1'); f.batch('unfinished', 10, 'paused');
  f.db.exec(`DROP TABLE ai_usage_report_rows;
    CREATE TABLE ai_usage_report_rows(partition_id TEXT NOT NULL,tenant_id INTEGER NOT NULL,dataset TEXT NOT NULL,
      row_key TEXT NOT NULL,stat_date TEXT NOT NULL,user_id INTEGER,workspace_id INTEGER,subject_id TEXT,
      session_key TEXT,occurred_at TEXT,value_json TEXT NOT NULL,PRIMARY KEY(partition_id,row_key));
    CREATE INDEX idx_ai_usage_report_filter ON ai_usage_report_rows(partition_id,user_id,workspace_id,subject_id);
    CREATE TABLE ai_usage_batch_partitions(batch_id TEXT,dataset TEXT,stat_date TEXT,partition_id TEXT,
      PRIMARY KEY(batch_id,dataset,stat_date));
    INSERT INTO ai_usage_batch_partitions VALUES('old','interactions','2026-09-11','p-old'),
      ('batch-1','interactions','2026-09-11','p-current'),('unfinished','interactions','2026-09-11','p-work');
    INSERT INTO ai_usage_report_rows VALUES
      ('p-old',10,'interactions','one','2026-09-11',3,7,NULL,'old',NULL,'{}'),
      ('p-current',10,'interactions','one','2026-09-11',3,7,NULL,'current',NULL,'{}'),
      ('p-work',10,'interactions','one','2026-09-11',3,7,NULL,'unfinished',NULL,'{}');
    UPDATE ai_usage_batches SET progress_json='{"stage":"activity","partition":{"cursor":"already-consumed"}}' WHERE id='unfinished';`);
  f.db.exec("UPDATE ai_usage_batches SET coverage_json=json_remove(coverage_json,'$.integrationVersion')");
}

test('legacy migration keeps only the active result and safely restarts unfinished work; idempotent', (t) => {
  const f = fixture(t); legacy(f);
  migrateAiUsageSchema(f.db);
  assert.deepEqual(f.db.prepare('SELECT session_key FROM ai_usage_report_rows').all(), [{ session_key: 'current' }]);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_usage_batch_partitions'").get(), undefined);
  assert.equal(f.db.prepare("SELECT progress_json FROM ai_usage_batches WHERE id='unfinished'").get().progress_json, '{}');
  assert.deepEqual(f.db.prepare('SELECT tenant_id,dataset,stat_date FROM ai_usage_dirty_partitions').all(), [
    { tenant_id: 10, dataset: 'interactions', stat_date: '2026-09-11' },
  ]);
  migrateAiUsageSchema(f.db);
  assert.equal(f.queryService.overview(f.access).sessionCount, 1);
});

test('legacy migration refuses a live worker and duplicate logical keys without deleting the old table', (t) => {
  const f = fixture(t); legacy(f);
  f.db.exec("INSERT INTO ai_usage_worker_lock VALUES(1,'busy','2999-01-01T00:00:00.000Z')");
  assert.throws(() => migrateAiUsageSchema(f.db), /AI_USAGE_MIGRATION_WORKER_BUSY/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_usage_report_rows').get().n, 3);
  f.db.exec(`DELETE FROM ai_usage_worker_lock;
    ALTER TABLE ai_usage_batch_partitions RENAME TO old_refs;
    CREATE TABLE ai_usage_batch_partitions AS SELECT * FROM old_refs;
    INSERT INTO ai_usage_batch_partitions SELECT * FROM old_refs WHERE batch_id='batch-1';`);
  assert.throws(() => migrateAiUsageSchema(f.db), /UNIQUE/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_usage_report_rows').get().n, 3);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_usage_report_rows_current'").get(), undefined);
});

test('a multi-statement report read stays on one snapshot while another connection publishes', async (t) => {
  const f = fixture(t); f.batch(); f.row({ id: 'first', dataset: 'interactions', value: { templateId: 'template-a' } });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-atomic-read-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'report.db');
  await f.db.backup(file);
  const reader = new Database(file), writer = new Database(file);
  reader.pragma('journal_mode = WAL'); writer.pragma('journal_mode = WAL');
  t.after(() => { reader.close(); writer.close(); });
  const { store, batch, ready } = candidate(writer);
  writer.prepare("UPDATE ai_usage_report_staging SET session_key='new-session' WHERE batch_id=?").run(batch.id);
  ready();
  const prepare = reader.prepare.bind(reader);
  let published = false;
  reader.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql.includes('SELECT COUNT(*) AS n FROM')) return {
      get(...args) {
        const result = statement.get(...args);
        if (!published) { store.publish(batch, {}); published = true; }
        return result;
      },
    };
    return statement;
  };
  const query = createAiUsageQueryService({ db: reader });
  const result = query.templateSessions(f.access, 'template-a', {});
  assert.equal(published, true);
  assert.equal(result.batchId, 'batch-1');
  assert.equal(result.total, 1);
  assert.equal(result.items[0].sessionKey, 'session-a');
  assert.equal(query.status(f.access).batchId, batch.id);
  assert.throws(() => query.overview(f.access, { batchId: 'batch-1' }), { code: 'reportUpdated' });
});
