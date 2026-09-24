import { createHash } from 'node:crypto';

import { INTEGRATION_COLUMNS } from '../database/ai-dashboard-integration-schema.js';

const shanghai = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export function shanghaiReportTime(value) {
  if (value == null || value === '') return null;
  // Internal old-report instants must carry an explicit offset. Never guess the host TZ.
  if (typeof value === 'string' && !/(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error('AI_INTEGRATION_AMBIGUOUS_TIME');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('AI_INTEGRATION_INVALID_TIME');
  const p = Object.fromEntries(shanghai.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const name = value => typeof value === 'string' && value.trim() ? value.trim() : null;

// The only metric input is one already-computed OLD report row. Never scan raw sources here.
export function projectIntegrationRow(row, refreshedAt) {
  if (!['interactions', 'turns', 'skill_publications', 'skill_invocations', 'sql_generations', 'code_submissions'].includes(row.dataset)) return null;
  const value = JSON.parse(row.value_json);
  const out = Object.fromEntries(INTEGRATION_COLUMNS.map(column => [column, null]));
  Object.assign(out, { id: hash([row.tenant_id, row.dataset, row.stat_date, row.row_key]),
    tenant_id: row.tenant_id, stat_date: row.stat_date, occurred_at: shanghaiReportTime(row.occurred_at),
    user_id: row.user_id, user_name: name(value.userName), workspace_id: row.workspace_id,
    workspace_name: name(value.workspaceName), refreshed_at: refreshedAt });
  if (row.dataset === 'interactions' || row.dataset === 'turns') {
    if (!row.session_key) return null;
    out.ai_session_id = hash([row.tenant_id, row.session_key]);
    if (row.dataset === 'interactions') out.has_ai_interaction = 1;
    else {
      if (value.status !== 'completed' || number(value.durationMs) === null) return null;
      out.ai_active_duration_ms = value.durationMs;
    }
  } else if (row.dataset.startsWith('skill_')) {
    if (!row.subject_id) return null;
    out.skill_id = String(row.subject_id); out.skill_name = name(value.skillName);
    out.publisher_user_id = value.publisherUserId ?? (row.dataset === 'skill_publications' ? row.user_id : null);
    out.publisher_user_name = name(value.publisherUserName || value.publisherName || value.userName);
    if (row.dataset === 'skill_publications') {
      // Ordered source scan keeps the earliest confirmed publication per Skill.
      out.id = hash([row.tenant_id, 'first-publication', out.skill_id]);
      out.skill_publish_count = 1;
    } else {
      out.skill_call_count = 1;
      // Old invocation rows are owned by the publisher, not the caller.
      out.user_id = value.callerUserId ?? null;
      out.user_name = name(value.callerUserName);
    }
  } else if (row.dataset === 'sql_generations') {
    // Produced by the nightly session scanner, never by Hook records.
    out.sql_record_id = row.row_key;
    out.generated_sql_lines = number(value.generatedLines);
  } else {
    out.code_submission_id = row.row_key;
    out.repository_url = name(value.repositoryUrl); out.commit_sha = name(value.commitSha);
    out.submitted_code_lines = number(value.submittedLines);
  }
  return out;
}

export function integrationCoverage(coverage = {}) {
  return { ...coverage, integrationVersion: 1,
    generatedSql: coverage.generatedSql || 'unavailable',
    submittedCode: coverage.codeSubmissions || 'unavailable' };
}

export function integrationWriter(db, staging = false) {
  const fields = staging ? ['batch_id', ...INTEGRATION_COLUMNS] : INTEGRATION_COLUMNS;
  const write = db.prepare(`INSERT INTO ai_dashboard_integration_${staging ? 'staging' : 'detail'} (${fields.join(',')})
    VALUES (${fields.map(c => `@${c}`).join(',')}) ON CONFLICT DO NOTHING`);
  // Names are labels only; no business facts are read from these identity tables.
  const user = db.prepare('SELECT username FROM users WHERE id=?');
  const workspace = db.prepare('SELECT display_name FROM workspaces WHERE id=? AND tenant_id=?');
  return (row, refreshedAt, batchId) => {
    const out = projectIntegrationRow(row, refreshedAt);
    if (!out) return;
    if (out.user_id != null) out.user_name = name(user.get(out.user_id)?.username) || out.user_name;
    if (out.publisher_user_id != null) out.publisher_user_name = name(user.get(out.publisher_user_id)?.username) || out.publisher_user_name;
    if (out.workspace_id != null) out.workspace_name = name(workspace.get(out.workspace_id, out.tenant_id)?.display_name) || out.workspace_name;
    write.run(staging ? { ...out, batch_id: batchId } : out);
  };
}

// One-time/current-snapshot backfill, within the caller's transaction. No source rescan.
export function backfillIntegration(db) {
  const changedTenants = [];
  const batches = db.prepare(`SELECT b.* FROM ai_usage_tenant_state s JOIN ai_usage_batches b
    ON b.id=s.active_batch_id AND b.tenant_id=s.tenant_id WHERE b.status='published'`).all();
  const write = integrationWriter(db);
  for (const batch of batches) {
    const coverage = JSON.parse(batch.coverage_json || '{}');
    if (coverage.integrationVersion === 1 || batch.time_zone !== 'Asia/Shanghai') continue;
    db.prepare('DELETE FROM ai_dashboard_integration_detail WHERE tenant_id=?').run(batch.tenant_id);
    for (const row of db.prepare(`SELECT r.* FROM ai_usage_report_rows r WHERE tenant_id=?
      AND NOT EXISTS (SELECT 1 FROM ai_usage_suppressed_rows s WHERE s.tenant_id=r.tenant_id AND s.dataset=r.dataset AND s.row_key=r.row_key)
      ORDER BY dataset,stat_date,row_key`).all(batch.tenant_id)) write(row, shanghaiReportTime(batch.completed_at));
    db.prepare('UPDATE ai_usage_batches SET coverage_json=? WHERE id=?').run(JSON.stringify(integrationCoverage(coverage)), batch.id);
    changedTenants.push(batch.tenant_id);
  }
  return changedTenants;
}

export async function buildIntegrationCandidate({ store, batch, progress, config, checkpoint, checkWindow }) {
  const db = store.database;
  if (batch.time_zone !== 'Asia/Shanghai') throw new Error('AI_INTEGRATION_REQUIRES_SHANGHAI_REBUILD');
  if (!progress.integration) store.transaction(() => {
    store.assertLease(batch);
    db.prepare('DELETE FROM ai_dashboard_integration_staging WHERE batch_id=?').run(batch.id);
    progress.integration = { cursor: ['', '', ''] };
    store.checkpoint(batch, progress, config);
  });
  const write = integrationWriter(db, true);
  for (;;) {
    checkWindow();
    const rows = db.prepare(`SELECT r.* FROM ai_usage_report_staging r WHERE batch_id=? AND tenant_id=?
      AND (dataset,stat_date,row_key)>(?,?,?) ORDER BY dataset,stat_date,row_key LIMIT ?`)
      .all(batch.id, batch.tenant_id, ...progress.integration.cursor, config.batchSize);
    if (!rows.length) return;
    store.transaction(() => {
      store.assertLease(batch);
      for (const row of rows) {
        if (!db.prepare('SELECT 1 FROM ai_usage_suppressed_rows WHERE tenant_id=? AND dataset=? AND row_key=?')
          .get(row.tenant_id, row.dataset, row.row_key)) write(row, '1970-01-01 08:00:00', batch.id);
      }
      const last = rows.at(-1);
      progress.integration.cursor = [last.dataset, last.stat_date, last.row_key];
      store.checkpoint(batch, progress, config);
    });
    await checkpoint();
  }
}
