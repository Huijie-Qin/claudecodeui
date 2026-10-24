import { SESSION_SUMMARY_COLUMNS, SESSION_SUMMARY_VERSION } from '../database/ai-session-summary-schema.js';

import { aiUsageError } from './ai-usage-access.js';
import { reportOrder } from './ai-usage-analysis.js';

const sortFields = Object.fromEntries(['userName', 'workspaceName', 'sessionId', 'totalTokens', 'startTime', 'endTime', 'activeDurationSeconds']
  .map(key => [key, key]));
const parseJson = value => { try { return JSON.parse(value); } catch { return null; } };

function skillNames(value) {
  const names = parseJson(value);
  return Array.isArray(names) ? [...new Set(names.filter(name => typeof name === 'string').map(name => name.trim()).filter(Boolean))].sort() : [];
}

function assertReady(db, batches) {
  const columns = new Set(db.prepare('PRAGMA table_info(ai_session_summary)').all().map(column => column.name));
  if (!SESSION_SUMMARY_COLUMNS.every(column => columns.has(column))
    || batches.some(batch => !(parseJson(batch.coverage_json)?.sessionSummaryVersion >= SESSION_SUMMARY_VERSION))) {
    throw aiUsageError(409, 'sessionDetailsNotReady', 'Session details have not been published for every selected tenant; refresh the report');
  }
}

// One row is an entire published session. Date filters select its start date;
// tokens and completed-turn duration are never sliced or recalculated here.
export function createSessionDetails({ db, context }) {
  return function sessionDetails(access, filters = {}) {
    if (filters.provider || filters.groupBy) throw aiUsageError(400, 'invalidFilter', 'Session details do not support grouping or provider filters');
    const ctx = context(access, filters);
    const order = reportOrder(filters, sortFields, 'startTime', 'tenantId, id');
    const meta = { ...ctx.meta, sessionDetailVersion: 1, dateBasis: 'session_start' };
    if (!ctx.meta.batchId) return { ...meta, items: [], total: 0, page: ctx.page, pageSize: ctx.pageSize };
    assertReady(db, ctx.publishedBatches);
    const indexColumns = new Set(db.prepare('PRAGMA table_info(session_index)').all().map(column => column.name));
    const deletedSession = ['tenant_id', 'workspace_id', 'user_id', 'provider', 'provider_session_id', 'status']
      .every(column => indexColumns.has(column))
      ? `AND NOT EXISTS(SELECT 1 FROM session_index si WHERE si.tenant_id=s.tenant_id AND si.workspace_id=s.workspace_id
          AND si.user_id=s.user_id AND si.provider=s.provider AND si.provider_session_id=s.session_id AND si.status='deleted')` : '';

    // Filter identities before looking up labels. COALESCE avoids scanning the
    // published report at all when a workspace still has its current name.
    const cte = `WITH eligible_sessions AS MATERIALIZED (
      SELECT s.* FROM ai_session_summary s WHERE ${ctx.tenantWhere('s')}
        AND s.start_time >= (@from || ' 00:00:00') AND s.start_time < (date(@to,'+1 day') || ' 00:00:00')
        AND (@self IS NULL OR s.user_id=@self)
        AND (@userId IS NULL OR s.user_id=@userId)
        AND (@workspaceId IS NULL OR s.workspace_id=@workspaceId)
        AND EXISTS(SELECT 1 FROM users u WHERE u.id=s.user_id)
        ${deletedSession}
        AND NOT EXISTS(SELECT 1 FROM ai_usage_suppressed_rows suppressed
          WHERE suppressed.tenant_id=s.tenant_id AND (
            (suppressed.dataset='session_usage' AND suppressed.row_key=s.id) OR
            EXISTS(SELECT 1 FROM ai_usage_report_rows r WHERE r.tenant_id=s.tenant_id
              AND r.dataset=suppressed.dataset AND r.row_key=suppressed.row_key
              AND r.dataset IN ('interactions','turns','skill_invocations','session_usage')
              AND r.session_key=json_array(s.tenant_id,s.workspace_id,s.user_id,s.provider,s.session_id))))
    ), workspace_labels AS MATERIALIZED (
      SELECT identities.tenant_id,identities.workspace_id,
        COALESCE((SELECT NULLIF(TRIM(w.display_name),'') FROM workspaces w
          WHERE w.id=identities.workspace_id AND w.tenant_id=identities.tenant_id),
          (SELECT MAX(CASE WHEN json_valid(r.value_json) THEN
            CASE WHEN json_type(r.value_json,'$.workspaceName')='text'
              THEN NULLIF(TRIM(json_extract(r.value_json,'$.workspaceName')),'') END END)
           FROM ai_usage_report_rows r WHERE r.tenant_id=identities.tenant_id AND r.workspace_id=identities.workspace_id
             AND r.dataset IN ('interactions','turns')
             AND (@self IS NULL OR r.user_id=@self)
             AND (@userId IS NULL OR r.user_id=@userId)
             AND EXISTS(SELECT 1 FROM users u WHERE u.id=r.user_id)
             AND NOT EXISTS(SELECT 1 FROM ai_usage_suppressed_rows suppressed WHERE suppressed.tenant_id=r.tenant_id
               AND suppressed.dataset=r.dataset AND suppressed.row_key=r.row_key))) AS workspaceName
      FROM (SELECT DISTINCT tenant_id,workspace_id FROM eligible_sessions) identities
    ), session_details AS (
      SELECT s.id,s.tenant_id AS tenantId,s.user_id AS userId,s.workspace_id AS workspaceId,
        COALESCE(NULLIF(TRIM(u.username),''),NULLIF(TRIM(s.user_name),'')) AS userName,
        names.workspaceName,
        s.session_id AS sessionId,s.total_tokens AS totalTokens,s.skill_list AS skillList,
        s.start_time AS startTime,s.end_time AS endTime,s.ai_active_duration_seconds AS activeDurationSeconds
      FROM eligible_sessions s JOIN users u ON u.id=s.user_id
      LEFT JOIN workspace_labels names ON names.tenant_id=s.tenant_id AND names.workspace_id=s.workspace_id
    ), filtered AS (SELECT * FROM session_details
      WHERE (@userSearch IS NULL OR userName LIKE @userSearch ESCAPE '\\')
        AND (@workspaceSearch IS NULL OR workspaceName LIKE @workspaceSearch ESCAPE '\\'))`;
    const total = db.prepare(`${cte} SELECT COUNT(*) AS n FROM filtered`).get(ctx.params).n;
    const items = db.prepare(`${cte} SELECT * FROM filtered ORDER BY ${order} LIMIT @limit OFFSET @offset`)
      .all({ ...ctx.params, limit: ctx.pageSize, offset: (ctx.page - 1) * ctx.pageSize })
      .map(row => ({ ...row, id: ctx.params.allTenants ? `${row.tenantId}:${row.id}` : row.id, skillList: skillNames(row.skillList) }));
    return { ...meta, items, total, page: ctx.page, pageSize: ctx.pageSize };
  };
}
