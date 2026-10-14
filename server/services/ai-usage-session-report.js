import { createHash } from 'node:crypto';

import { normalizeTimestamp } from './ai-usage-config.js';
import { addDuration, parseDurationFact } from './ai-usage-duration.js';

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
  const value = row.dataset === 'turns' ? parseDurationFact(row) : parseJson(row.value_json) || {};
  const completion = normalizeTimestamp(value.responseCompletedAt);
  const start = normalizeTimestamp(value.requestStartedAt);
  const durationByCompletion = { ...earlier?.durationByCompletion };
  let durationMs = null;
  if (row.dataset === 'turns' && value.status === 'completed' && start && completion) {
    // Validate both candidate sums before changing either. A rejected input
    // leaves the previous report row and every valid contribution intact.
    durationMs = addDuration(earlier?.durationMs ?? 0, value.durationMs);
    durationByCompletion[completion] = addDuration(durationByCompletion[completion] ?? 0, value.durationMs);
  }
  return { provider: value.provider, providerSessionId: value.providerSessionId,
    userName: value.userName, workspaceName: value.workspaceName,
    templateId: value.templateId, templateName: value.templateName,
    firstInteractionAt: row.dataset === 'interactions'
      ? [earlier?.firstInteractionAt, row.occurred_at].filter(Boolean).sort()[0] : undefined,
    lastInteractionAt: row.dataset === 'interactions'
      ? [earlier?.lastInteractionAt, row.occurred_at].filter(Boolean).sort().at(-1) : undefined,
    status: value.status, durationMs,
    turnCount: row.dataset === 'turns' ? (earlier?.turnCount || 0) + 1 : undefined,
    durationByCompletion: row.dataset === 'turns' ? durationByCompletion : undefined,
  };
}
