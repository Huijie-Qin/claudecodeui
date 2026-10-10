// Default read-only; --apply backs up and changes ONLY the new session tables.
// No app bootstrap, scheduler changes, network requests or preview restarts.
// Reads ai_usage_report_rows only. Old reports must first be enriched by the
// nightly pipeline or migrate-ai-session-report-source.mjs; never bypass them.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateAiSessionSummarySchema } from '../server/database/ai-session-summary-schema.js';
import { collectSessionSummaries, replaceSessionSummaries } from '../server/services/ai-session-summary.js';

const [databasePath, option] = process.argv.slice(2);
const apply = option === '--apply';
if (!databasePath || !path.isAbsolute(databasePath) || (option && !apply) || process.argv.length > 4) {
  throw new Error('Usage: node scripts/refresh-ai-session-summary.mjs /absolute/auth.db [--apply]');
}
const db = new Database(databasePath, { readonly: !apply, fileMustExist: true, timeout: 1000 });
function assertIdle() {
  const now = new Date().toISOString();
  assert.ok(!db.prepare('SELECT 1 FROM ai_usage_worker_lock WHERE lease_until>?').get(now), 'Statistics worker is active');
  assert.ok(!db.prepare("SELECT 1 FROM ai_usage_batches WHERE status='running' AND lease_until>?").get(now), 'Statistics batch is active');
}
function fingerprint() {
  const digest = createHash('sha256');
  for (const table of ['ai_usage_report_rows', 'ai_dashboard_integration_detail', 'ai_dashboard_ai_detail',
    'ai_dashboard_skill_publication_detail', 'ai_dashboard_skill_invocation_detail',
    'ai_dashboard_sql_generation_detail', 'ai_dashboard_code_submission_detail']) {
    digest.update(table);
    // These are published statistics only, never authentication/message payloads.
    const order = table === 'ai_usage_report_rows' ? 'tenant_id,dataset,stat_date,row_key' : 'tenant_id,id';
    const query = db.prepare(`SELECT * FROM ${table} ORDER BY ${order} LIMIT 500 OFFSET ?`);
    for (let offset = 0; ; offset += 500) {
      const page = query.all(offset);
      if (!page.length) break;
      for (const row of page) digest.update(JSON.stringify(row));
    }
  }
  return digest.digest('hex');
}
let backup;
try {
  assertIdle();
  const revision = db.pragma('data_version', { simple: true });
  const before = fingerprint();
  const batches = db.prepare(`SELECT b.tenant_id,b.target_through FROM ai_usage_tenant_state s
    JOIN ai_usage_batches b ON b.id=s.active_batch_id WHERE b.status='published' ORDER BY b.tenant_id`).all();
  const candidates = [];
  for (const batch of batches) {
    candidates.push({ ...batch, rows: await collectSessionSummaries({ database: db,
      tenantId: batch.tenant_id, through: batch.target_through }) });
  }
  assert.equal(db.pragma('data_version', { simple: true }), revision, 'Sources changed during collection; retry when idle');
  if (apply) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ccui-session-backup-'));
    await chmod(directory, 0o700); backup = path.join(directory, 'before.sqlite');
    await db.backup(backup); await chmod(backup, 0o600);
    db.transaction(() => {
      assertIdle();
      assert.equal(db.pragma('data_version', { simple: true }), revision, 'Sources changed before publication; retry');
      migrateAiSessionSummarySchema(db);
      for (const candidate of candidates) replaceSessionSummaries(db, candidate.tenant_id, candidate.rows);
      assert.equal(fingerprint(), before, 'Existing dashboard tables must remain unchanged');
    }).immediate();
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  }
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'read-only', backup,
    tenants: candidates.map(candidate => ({ tenantId: candidate.tenant_id, through: candidate.target_through,
      sessions: candidate.rows.length, knownTokens: candidate.rows.filter(row => row.total_tokens !== null).length,
      knownDuration: candidate.rows.filter(row => row.ai_active_duration_seconds !== null).length,
      withSkills: candidate.rows.filter(row => row.skill_list !== '[]').length,
      samples: candidate.rows.filter(row => row.total_tokens !== null).slice(0, 3) })),
    existingDashboardUnchanged: fingerprint() === before }, null, 2));
} catch (error) {
  if (backup) console.error(JSON.stringify({ backup, error: error.message }));
  throw error;
} finally { db.close(); }
