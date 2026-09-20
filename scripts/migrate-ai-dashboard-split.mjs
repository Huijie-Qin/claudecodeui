// Preserve old report + wide facts. No application/.env imports or scheduler.
// Default: read-only. --apply: private backup + atomic v1/v2/v3 -> v4 five-table migration (AI seconds).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { RETIRED_SPLIT_DETAILS, SPLIT_DETAILS, SPLIT_SCHEMA_VERSION } from '../server/database/ai-dashboard-split-schema.js';
import { migrateSplitDetails, collectSplitRows } from '../server/services/ai-dashboard-split.js';

const databasePath = process.argv[2];
const apply = process.argv[3] === '--apply';
if (!databasePath || !path.isAbsolute(databasePath) || process.argv.length > 4 || (process.argv.length > 3 && !apply)) {
  throw new Error('Usage: node scripts/migrate-ai-dashboard-split.mjs /absolute/auth.db [--apply]');
}
const db = new Database(databasePath, { readonly: !apply, fileMustExist: true, timeout: 1000 });
const exists = table => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
function assertIdle() {
  const now = new Date().toISOString();
  assert.ok(!db.prepare('SELECT 1 FROM ai_usage_worker_lock WHERE lease_until>?').get(now), 'Statistics Worker is active');
  assert.ok(!db.prepare("SELECT 1 FROM ai_usage_batches WHERE status='running' AND lease_until>?").get(now), 'Statistics batch is active');
}
function* scan(table, order, tenantId = null) {
  const keys = order.split(',');
  const filter = tenantId == null ? '' : 'tenant_id=?';
  const params = tenantId == null ? [] : [tenantId];
  const first = db.prepare(`SELECT * FROM ${table} ${filter ? `WHERE ${filter}` : ''} ORDER BY ${order} LIMIT 500`);
  const next = db.prepare(`SELECT * FROM ${table} WHERE ${filter ? `${filter} AND ` : ''}(${order})>(${keys.map(() => '?').join(',')}) ORDER BY ${order} LIMIT 500`);
  for (let page = first.all(...params); page.length; page = next.all(...params, ...keys.map(key => page.at(-1)[key]))) yield* page;
}
function fingerprint() {
  const hash = createHash('sha256');
  // Read only the existing report facts and their metadata, never auth/user payloads.
  for (const [table, order] of [['ai_usage_report_rows', 'tenant_id,dataset,stat_date,row_key'],
    ['ai_dashboard_integration_detail', 'tenant_id,id'], ['ai_usage_batches', 'id'], ['ai_usage_tenant_state', 'tenant_id'],
    ['ai_usage_report_staging', 'batch_id,dataset,stat_date,row_key'], ['ai_dashboard_integration_staging', 'batch_id,tenant_id,id']]) {
    hash.update(table);
    for (const row of scan(table, order)) hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}
function report() {
  return {
    oldRows: db.prepare('SELECT COUNT(*) AS n FROM ai_usage_report_rows').get().n,
    integrationRows: db.prepare('SELECT COUNT(*) AS n FROM ai_dashboard_integration_detail').get().n,
    aiDurationColumn: exists('ai_dashboard_ai_detail') ? db.prepare('PRAGMA table_info(ai_dashboard_ai_detail)').all()
      .find(column => column.name.startsWith('ai_active_duration_'))?.name : null,
    split: SPLIT_DETAILS.map(definition => ({ table: definition.table,
      rows: exists(definition.table) ? db.prepare(`SELECT COUNT(*) AS n FROM ${definition.table}`).get().n : null })),
    legacyTables: RETIRED_SPLIT_DETAILS.flatMap(definition => [definition.table, definition.staging]).filter(exists),
    state: exists('ai_dashboard_split_state') ? db.prepare('SELECT * FROM ai_dashboard_split_state ORDER BY tenant_id').all() : [],
  };
}
function verify() {
  const lookups = new Map(SPLIT_DETAILS.map(definition => [definition.key,
    db.prepare(`SELECT * FROM ${definition.table} WHERE tenant_id=? AND id=?`)]));
  for (const state of db.prepare('SELECT * FROM ai_dashboard_split_state').all()) {
    assert.equal(state.schema_version, SPLIT_SCHEMA_VERSION);
    assert.equal(state.batch_id, db.prepare('SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=?').get(state.tenant_id)?.active_batch_id);
    const expected = collectSplitRows(scan('ai_dashboard_integration_detail', 'tenant_id,id', state.tenant_id));
    for (const definition of SPLIT_DETAILS) {
      for (const values of expected.get(definition.key).values()) {
        assert.deepEqual(lookups.get(definition.key).get(values.tenant_id, values.id), values, definition.key);
      }
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${definition.table} WHERE tenant_id=?`).get(state.tenant_id).n, expected.get(definition.key).size);
    }
  }
}
let backup;
let retiredTables = [];
try {
  assert.ok(db.prepare('PRAGMA table_info(ai_dashboard_integration_detail)').all().some(column => column.name === 'id'), 'Existing integration table with id is required');
  if (!apply) console.log(JSON.stringify(db.transaction(() => ({ mode: 'read-only', ...report() }))()));
  else {
    assertIdle();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ccui-split-backup-'));
    await chmod(directory, 0o700); backup = path.join(directory, 'before.sqlite');
    await db.backup(backup); await chmod(backup, 0o600);
    db.transaction(() => {
      assertIdle(); const before = fingerprint();
      retiredTables = migrateSplitDetails(db); verify();
      assert.equal(fingerprint(), before, 'Old report, integration facts and batch metadata must remain unchanged');
    }).immediate();
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    console.log(JSON.stringify({ mode: 'applied', backup, retiredTables, ...report() }));
  }
} catch (error) {
  if (backup) console.error(JSON.stringify({ backup, error: error.message }));
  throw error;
} finally { db.close(); }
