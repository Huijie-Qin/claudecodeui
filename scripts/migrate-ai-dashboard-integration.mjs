// Controlled, snapshot-only migration. Never imports the application, .env,
// scheduler, or model runtime. Default is read-only; --apply requires a backup.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateAiUsageSchema } from '../server/database/ai-usage-schema.js';

const databasePath = process.argv[2];
if (!databasePath || !path.isAbsolute(databasePath)) throw new Error('Usage: node scripts/migrate-ai-dashboard-integration.mjs /absolute/database.sqlite [--apply]');
const apply = process.argv[3] === '--apply';
if (process.argv.length > 3 && !apply) throw new Error('Unknown argument');
const db = new Database(databasePath, { readonly: !apply, fileMustExist: true, timeout: 1000 });
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const oldRows = () => db.prepare('SELECT * FROM ai_usage_report_rows ORDER BY tenant_id,dataset,stat_date,row_key').all();
const active = () => db.prepare('SELECT tenant_id,active_batch_id FROM ai_usage_tenant_state ORDER BY tenant_id').all();
const integrationRows = () => {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_dashboard_integration_detail'").get()) return null;
  // Normalize the previous public name for comparison; renaming must not change facts.
  return db.prepare('SELECT * FROM ai_dashboard_integration_detail').all().map(row => {
    const { id, detail_id, ...fields } = row; return { id: id ?? detail_id, ...fields };
  }).sort((a, b) => a.tenant_id - b.tenant_id || a.id.localeCompare(b.id));
};
function assertIdle() {
  const now = new Date().toISOString();
  assert.equal(Boolean(db.prepare('SELECT 1 FROM ai_usage_worker_lock WHERE lease_until>?').get(now)), false, 'Statistics worker is active');
  assert.equal(Boolean(db.prepare("SELECT 1 FROM ai_usage_batches WHERE status='running' AND lease_until>?").get(now)), false, 'Statistics batch is active');
}
function report() {
  const hasNew = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_dashboard_integration_detail'").get();
  return { oldRows: db.prepare('SELECT COUNT(*) AS n FROM ai_usage_report_rows').get().n,
    codeHubSourceRows: db.prepare('SELECT COUNT(*) AS n FROM ai_mr_submissions').get().n,
    integration: hasNew ? db.prepare(`SELECT tenant_id,COUNT(*) AS rows,
      COUNT(DISTINCT CASE WHEN has_ai_interaction=1 THEN ai_session_id END) AS sessions,
      SUM(ai_active_duration_ms) AS durationMs,SUM(generated_sql_lines) AS sqlLines,
      SUM(submitted_code_lines) AS submittedLines FROM ai_dashboard_integration_detail GROUP BY tenant_id`).all() : null };
}
try {
  assertIdle();
  if (!apply) console.log(JSON.stringify({ mode: 'read-only', ...report() }));
  else {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ccui-integration-backup-'));
    await chmod(directory, 0o700);
    const backup = path.join(directory, 'before.sqlite');
    await db.backup(backup); await chmod(backup, 0o600);
    db.transaction(() => {
      assertIdle();
      const before = digest(oldRows()); const batches = active();
      const originalIntegration = integrationRows();
      const renamed = db.prepare('PRAGMA table_info(ai_dashboard_integration_detail)').all().some(column => column.name === 'detail_id');
      migrateAiUsageSchema(db);
      assert.equal(digest(oldRows()), before, 'Published old report must stay unchanged');
      assert.deepEqual(active(), batches, 'Migration must not publish a different batch');
      if (renamed) assert.deepEqual(integrationRows(), originalIntegration, 'ID rename must preserve all integration values');
    }).immediate();
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    console.log(JSON.stringify({ mode: 'applied', backup, ...report() }));
  }
} finally { db.close(); }
