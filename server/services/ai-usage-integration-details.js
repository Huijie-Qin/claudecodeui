import { INTEGRATION_COLUMNS } from '../database/ai-dashboard-integration-schema.js';

import { aiUsageError } from './ai-usage-access.js';
import { reportOrder } from './ai-usage-analysis.js';

const camelCase = column => column.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
const fields = Object.fromEntries(INTEGRATION_COLUMNS.map(column => [camelCase(column), `d.${column}`]));

// Read the published integration table verbatim. A row is one sparse fact, not
// a user/day aggregate, and user_id is the caller for invocation facts.
export function createIntegrationDetails({ db, context }) {
  return function integrationDetails(access, filters = {}) {
    if (filters.provider || filters.groupBy) throw aiUsageError(400, 'invalidFilter', 'Integration details do not support grouping or provider filters');
    const ctx = context(access, filters);
    const order = reportOrder(filters, fields, 'statDate', 'd.id');
    if (ctx.meta.batchId && ctx.meta.coverage.integrationVersion !== 1) {
      throw aiUsageError(409, 'integrationNotReady', 'Integration details have not been published for this batch');
    }
    const where = `d.tenant_id=@tenant AND @batch=(SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=@tenant)
      AND d.stat_date BETWEEN @from AND @to
      AND (@self IS NULL OR d.user_id=@self)
      AND (@userId IS NULL OR d.user_id=@userId)
      AND (@workspaceId IS NULL OR d.workspace_id=@workspaceId)
      AND (d.user_id IS NULL OR EXISTS(SELECT 1 FROM users u WHERE u.id=d.user_id))
      AND (@userSearch IS NULL OR d.user_name LIKE @userSearch ESCAPE '\\')
      AND (@workspaceSearch IS NULL OR d.workspace_name LIKE @workspaceSearch ESCAPE '\\')`;
    const total = ctx.meta.batchId ? db.prepare(`SELECT COUNT(*) AS n FROM ai_dashboard_integration_detail d WHERE ${where}`).get(ctx.params).n : 0;
    const items = ctx.meta.batchId ? db.prepare(`SELECT ${Object.entries(fields).map(([key, column]) => `${column} AS ${key}`).join(',')}
      FROM ai_dashboard_integration_detail d WHERE ${where} ORDER BY ${order} LIMIT @limit OFFSET @offset`)
      .all({ ...ctx.params, limit: ctx.pageSize, offset: (ctx.page - 1) * ctx.pageSize }) : [];
    return { ...ctx.meta, integrationDetailVersion: 1, items, total, page: ctx.page, pageSize: ctx.pageSize };
  };
}
