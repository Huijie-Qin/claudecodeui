import { createHash } from 'node:crypto';

import { normalizeTimestamp } from './ai-usage-config.js';

export const SESSION_REPORT_VERSION = 1;
export const parseJson = value => { try { return JSON.parse(value); } catch { return null; } };

export function sessionScope(key, tenantId) {
  const values = parseJson(key);
  if (!Array.isArray(values) || values.length !== 5 || values[0] !== tenantId
    || !values.slice(0, 3).every(value => Number.isSafeInteger(value) && value > 0)
    || typeof values[3] !== 'string' || typeof values[4] !== 'string' || !values[4]
    || values[4].startsWith('pending:')) return null;
  const [tenant_id, workspace_id, user_id, provider, session_id] = values;
  return { id: createHash('sha256').update(key).digest('hex'), tenant_id, workspace_id, user_id, provider, session_id };
}

// Reads exactly one published table OR one batch's candidate for that table.
export function* sessionReportRows(db, tenantId, batchId) {
  const table = batchId ? 'ai_usage_report_staging' : 'ai_usage_report_rows';
  const query = db.prepare(`SELECT * FROM ${table} WHERE tenant_id=? ${batchId ? 'AND batch_id=?' : ''}
    AND dataset IN ('interactions','turns','skill_invocations','session_usage')
    AND (dataset,stat_date,row_key)>(?,?,?) ORDER BY dataset,stat_date,row_key LIMIT 500`);
  let cursor = ['', '', ''];
  while (true) {
    const rows = query.all(tenantId, ...(batchId ? [batchId] : []), ...cursor);
    if (!rows.length) return;
    yield* rows;
    const last = rows.at(-1);
    cursor = [last.dataset, last.stat_date, last.row_key];
  }
}

// Keep completion buckets alongside existing day-sliced durationMs. The latter
// may include a slice of a request that finishes AFTER a snapshot's cutoff.
export function mergeSessionReportFact(row, earlier) {
  const value = parseJson(row.value_json) || {};
  const completion = normalizeTimestamp(value.responseCompletedAt);
  const start = normalizeTimestamp(value.requestStartedAt);
  const durationByCompletion = { ...earlier?.durationByCompletion };
  if (row.dataset === 'turns' && value.status === 'completed' && start && completion && completion >= start
    && Number.isSafeInteger(value.durationMs) && value.durationMs >= 0) {
    const duration = (durationByCompletion[completion] || 0) + value.durationMs;
    if (!Number.isSafeInteger(duration)) throw new Error('SESSION_SUMMARY_DURATION_OVERFLOW');
    durationByCompletion[completion] = duration;
  }
  return { provider: value.provider, providerSessionId: value.providerSessionId,
    userName: value.userName, workspaceName: value.workspaceName,
    templateId: value.templateId, templateName: value.templateName,
    firstInteractionAt: row.dataset === 'interactions'
      ? [earlier?.firstInteractionAt, row.occurred_at].filter(Boolean).sort()[0] : undefined,
    lastInteractionAt: row.dataset === 'interactions'
      ? [earlier?.lastInteractionAt, row.occurred_at].filter(Boolean).sort().at(-1) : undefined,
    status: value.status, durationMs: value.status === 'completed'
      ? (earlier?.durationMs || 0) + (value.durationMs || 0) : null,
    turnCount: row.dataset === 'turns' ? (earlier?.turnCount || 0) + 1 : undefined,
    durationByCompletion: row.dataset === 'turns' ? durationByCompletion : undefined,
  };
}
