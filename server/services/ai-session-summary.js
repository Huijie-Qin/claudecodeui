import { SESSION_SUMMARY_COLUMNS, SESSION_SUMMARY_VERSION } from '../database/ai-session-summary-schema.js';

import { normalizeTimestamp } from './ai-usage-config.js';
import { shanghaiReportTime } from './ai-dashboard-integration.js';
import { SESSION_REPORT_VERSION, parseJson, sessionScope, sessionReportRows } from './ai-usage-session-report.js';

/** Pure projection: all business values come from the original report only. */
export async function collectSessionSummaries({ database: db, tenantId, through, batchId, checkWindow = () => {} }) {
  through = normalizeTimestamp(through);
  if (!through) throw new Error('SESSION_SUMMARY_CUTOFF_REQUIRED');
  const sessions = new Map();
  for (const row of sessionReportRows(db, tenantId, batchId)) {
    checkWindow();
    const time = normalizeTimestamp(row.occurred_at);
    if (!time || time >= through) continue;
    const scope = sessionScope(row.session_key, tenantId);
    if (!scope) continue;
    const value = parseJson(row.value_json);
    if (!value) throw new Error('SESSION_REPORT_INVALID_VALUE');
    if (row.workspace_id !== scope.workspace_id
      || (row.dataset !== 'skill_invocations' && row.user_id !== scope.user_id)
      || (row.dataset === 'skill_invocations' && value.callerUserId != null && value.callerUserId !== scope.user_id)
      || (value.provider != null && value.provider !== scope.provider)
      || (value.providerSessionId != null && value.providerSessionId !== scope.session_id)) {
      throw new Error('SESSION_SUMMARY_FACT_SCOPE_CONFLICT');
    }
    let session = sessions.get(row.session_key);
    if (!session) {
      session = { ...scope, skills: new Set(), start: null, end: null, usage: null, milliseconds: null };
      sessions.set(row.session_key, session);
    }
    if (row.dataset === 'interactions') {
      const first = normalizeTimestamp(value.firstInteractionAt) || time;
      if (!session.start || first < session.start) session.start = first;
    } else if (row.dataset === 'session_usage') {
      if (session.usage) throw new Error('SESSION_REPORT_DUPLICATE_USAGE');
      if (value.version !== SESSION_REPORT_VERSION || normalizeTimestamp(value.through) !== through) {
        throw new Error('SESSION_REPORT_USAGE_STALE');
      }
      if (value.totalTokens !== null && (!Number.isSafeInteger(value.totalTokens) || value.totalTokens < 0)) {
        throw new Error('SESSION_REPORT_INVALID_TOKENS');
      }
      session.usage = value;
    } else if (row.dataset === 'turns' && value.status === 'completed') {
      if (!value.durationByCompletion || typeof value.durationByCompletion !== 'object' || Array.isArray(value.durationByCompletion)) {
        throw new Error('SESSION_REPORT_UPGRADE_REQUIRED');
      }
      for (const [rawEnd, milliseconds] of Object.entries(value.durationByCompletion)) {
        const end = normalizeTimestamp(rawEnd);
        if (!end || !Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new Error('SESSION_REPORT_INVALID_DURATION');
        if (end >= through) continue;
        session.milliseconds = (session.milliseconds ?? 0) + milliseconds;
        if (!Number.isSafeInteger(session.milliseconds)) throw new Error('SESSION_SUMMARY_DURATION_OVERFLOW');
        if (!session.end || end > session.end) session.end = end;
      }
    } else if (row.dataset === 'skill_invocations' && typeof value.skillName === 'string' && value.skillName.trim()) {
      session.skills.add(value.skillName.trim());
    }
  }
  const rows = [];
  for (const session of sessions.values()) {
    checkWindow();
    if (!session.start) continue;
    if (!session.usage) throw new Error('SESSION_REPORT_USAGE_MISSING');
    if (session.usage.deleted) continue;
    const responseEnd = normalizeTimestamp(session.usage.responseCompletedAt);
    const end = [session.end, responseEnd].filter(value => value && value >= session.start && value < through).sort().at(-1) || null;
    const output = {
      ...session, user_name: session.usage.userName ?? null,
      total_tokens: session.usage.totalTokens, skill_list: JSON.stringify([...session.skills].sort()),
      start_time: shanghaiReportTime(session.start), end_time: shanghaiReportTime(end),
      ai_active_duration_seconds: session.milliseconds === null ? null : session.milliseconds / 1000,
    };
    rows.push(Object.fromEntries(SESSION_SUMMARY_COLUMNS.map(column => [column, output[column]])));
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export function replaceSessionSummaries(db, tenantId, rows) {
  db.transaction(() => {
    for (const row of rows) if (row.tenant_id !== tenantId) throw new Error('SESSION_SUMMARY_TENANT_MISMATCH');
    db.prepare('DELETE FROM ai_session_summary WHERE tenant_id=?').run(tenantId);
    const write = db.prepare(`INSERT INTO ai_session_summary (${SESSION_SUMMARY_COLUMNS})
      VALUES (${SESSION_SUMMARY_COLUMNS.map(c => `@${c}`)})`);
    for (const row of rows) write.run(row);
  }).immediate();
}

export async function buildSessionSummaryCandidate({ store, batch, progress, checkpoint, checkWindow }) {
  const rows = await collectSessionSummaries({ database: store.database, tenantId: batch.tenant_id,
    through: batch.target_through, batchId: batch.id, checkWindow });
  checkWindow();
  store.transaction(() => {
    store.assertLease(batch);
    store.database.prepare('DELETE FROM ai_session_summary_staging WHERE batch_id=?').run(batch.id);
    const write = store.database.prepare(`INSERT INTO ai_session_summary_staging (batch_id,${SESSION_SUMMARY_COLUMNS})
      VALUES (@batch_id,${SESSION_SUMMARY_COLUMNS.map(c => `@${c}`)})`);
    for (const row of rows) write.run({ batch_id: batch.id, ...row });
  });
  progress.sessionSummary = { ready: true, version: SESSION_SUMMARY_VERSION };
  await checkpoint();
}

export function publishSessionSummaryCandidate(db, batch) {
  // The caller publishes this and the original report in the same transaction.
  db.prepare('DELETE FROM ai_session_summary WHERE tenant_id=?').run(batch.tenant_id);
  db.prepare(`INSERT INTO ai_session_summary (${SESSION_SUMMARY_COLUMNS})
    SELECT ${SESSION_SUMMARY_COLUMNS} FROM ai_session_summary_staging WHERE batch_id=? AND tenant_id=?`)
    .run(batch.id, batch.tenant_id);
  db.prepare('DELETE FROM ai_session_summary_staging WHERE batch_id=?').run(batch.id);
}
