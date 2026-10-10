// Read-only by default. Rebuild in private memory, then apply ONLY report
// enrichment and its session projection, with a private backup and atomic swap.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readAiUsageConfig, localInstant, localParts } from '../server/services/ai-usage-config.js';
import { createAiUsageStore } from '../server/services/ai-usage-db.js';
import { runAiUsageWindow } from '../server/services/ai-usage-batches.js';
import { collectSessionSummaries, replaceSessionSummaries } from '../server/services/ai-session-summary.js';
import { replaceReportSessionUsage } from '../server/services/ai-usage-session-source.js';

const [databasePath, option] = process.argv.slice(2);
const apply = option === '--apply';
if (!databasePath || !path.isAbsolute(databasePath) || (option && !apply) || process.argv.length > 4) {
  throw new Error('Usage: node scripts/migrate-ai-session-report-source.mjs /absolute/auth.db [--apply]');
}
const live = new Database(databasePath, { readonly: !apply, fileMustExist: true, timeout: 1000 });
let copy;
let backup;
const rowKey = row => JSON.stringify([row.tenant_id, row.dataset, row.stat_date, row.row_key]);
const readReport = db => db.prepare('SELECT * FROM ai_usage_report_rows ORDER BY tenant_id,dataset,stat_date,row_key').all();
function assertIdle() {
  const now = new Date().toISOString();
  assert.ok(!live.prepare('SELECT 1 FROM ai_usage_worker_lock WHERE lease_until>?').get(now), 'Statistics worker is active');
  assert.ok(!live.prepare("SELECT 1 FROM ai_usage_batches WHERE status='running' AND lease_until>?").get(now), 'Statistics batch is active');
}
function otherTablesFingerprint() {
  const digest = createHash('sha256');
  for (const table of ['ai_dashboard_integration_detail', 'ai_dashboard_ai_detail', 'ai_dashboard_skill_publication_detail',
    'ai_dashboard_skill_invocation_detail', 'ai_dashboard_sql_generation_detail', 'ai_dashboard_code_submission_detail',
    'ai_usage_tenant_state', 'ai_usage_batches']) {
    digest.update(table);
    const order = table === 'ai_usage_tenant_state' ? 'tenant_id' : table === 'ai_usage_batches' ? 'id' : 'tenant_id,id';
    const query = live.prepare(`SELECT * FROM ${table} ORDER BY ${order} LIMIT 500 OFFSET ?`);
    for (let offset = 0; ; offset += 500) {
      const rows = query.all(offset);
      if (!rows.length) break;
      for (const row of rows) digest.update(JSON.stringify(row));
    }
  }
  return digest.digest('hex');
}
try {
  assertIdle();
  const revision = live.pragma('data_version', { simple: true });
  const beforeReport = readReport(live);
  const beforeOther = otherTablesFingerprint();
  const batches = live.prepare(`SELECT b.tenant_id,b.target_through FROM ai_usage_tenant_state s
    JOIN ai_usage_batches b ON b.id=s.active_batch_id WHERE b.status='published' ORDER BY b.tenant_id`).all();
  assert.ok(batches.length, 'No published report to upgrade');
  // Never run the real scheduler or modify live source/index state.
  copy = new Database(live.serialize());
  assert.equal(copy.prepare("SELECT COUNT(*) n FROM ai_usage_batches WHERE status IN ('running','paused','failed')").get().n, 0,
    'Finish or explicitly resolve outstanding batches before this one-off migration');
  const config = readAiUsageConfig({ AI_USAGE_ENABLED: 'true' });
  const date = localParts(batches[0].target_through, config.timeZone).date;
  const now = () => new Date(Date.parse(localInstant(date, config.runAt, config.timeZone)) + 600000);
  const store = createAiUsageStore(copy, { clock: now });
  for (const batch of batches) {
    store.finish(store.claim(batch.tenant_id, { scheduledFor: 'private-session-report-upgrade', targetThrough: batch.target_through }, config, now()), 'paused');
  }
  const result = await runAiUsageWindow({ database: copy, config, now });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const candidate = readReport(copy);
  const oldRows = new Map(beforeReport.filter(row => row.dataset !== 'session_usage').map(row => [rowKey(row), row]));
  const completions = [];
  for (const row of candidate.filter(row => row.dataset !== 'session_usage')) {
    const original = oldRows.get(rowKey(row));
    assert.ok(original, 'New business rows require a normal nightly batch, not this enrichment migration');
    const prior = JSON.parse(original.value_json), next = JSON.parse(row.value_json);
    if (row.dataset === 'turns') {
      completions.push({ ...original, value_json: JSON.stringify({ ...prior, durationByCompletion: next.durationByCompletion }) });
      delete prior.durationByCompletion; delete next.durationByCompletion;
    }
    assert.deepEqual({ ...row, value_json: next }, { ...original, value_json: prior },
      'Source metrics changed; use a normal nightly batch instead of changing the published snapshot');
    oldRows.delete(rowKey(row));
  }
  assert.equal(oldRows.size, 0, 'Business rows were removed; normal nightly batch required');
  const summaries = [];
  for (const batch of batches) {
    const rows = await collectSessionSummaries({ database: copy, tenantId: batch.tenant_id, through: batch.target_through });
    assert.deepEqual(rows, copy.prepare('SELECT * FROM ai_session_summary WHERE tenant_id=? ORDER BY id').all(batch.tenant_id));
    summaries.push({ ...batch, rows });
  }
  assert.equal(live.pragma('data_version', { simple: true }), revision, 'Live database changed; retry when idle');
  if (apply) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ccui-session-report-backup-'));
    await chmod(directory, 0o700);
    backup = path.join(directory, 'before.sqlite');
    await live.backup(backup); await chmod(backup, 0o600);
    live.transaction(() => {
      assertIdle();
      assert.equal(live.pragma('data_version', { simple: true }), revision, 'Live database changed before publication');
      assert.deepEqual(readReport(live), beforeReport);
      const update = live.prepare(`UPDATE ai_usage_report_rows SET value_json=@value_json
        WHERE tenant_id=@tenant_id AND dataset=@dataset AND stat_date=@stat_date AND row_key=@row_key`);
      for (const row of completions) assert.equal(update.run(row).changes, 1);
      for (const batch of summaries) {
        replaceReportSessionUsage(live, batch.tenant_id, candidate.filter(row => row.tenant_id === batch.tenant_id && row.dataset === 'session_usage'));
        replaceSessionSummaries(live, batch.tenant_id, batch.rows);
      }
      assert.equal(otherTablesFingerprint(), beforeOther, 'Other dashboard tables and batch state must stay unchanged');
    }).immediate();
    for (const batch of summaries) assert.deepEqual(await collectSessionSummaries({ database: live,
      tenantId: batch.tenant_id, through: batch.target_through }), batch.rows);
    assert.equal(live.pragma('integrity_check', { simple: true }), 'ok');
  }
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'read-only', backup,
    originalBusinessRows: beforeReport.filter(row => row.dataset !== 'session_usage').length,
    enrichedTurnRows: completions.length, sessionUsageRows: candidate.filter(row => row.dataset === 'session_usage').length,
    sessions: summaries.reduce((sum, batch) => sum + batch.rows.length, 0),
    otherDashboardTablesUnchanged: otherTablesFingerprint() === beforeOther }, null, 2));
} catch (error) {
  if (backup) console.error(JSON.stringify({ backup, error: error.message }));
  throw error;
} finally { copy?.close(); live.close(); }
