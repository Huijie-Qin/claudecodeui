import { aiUsageError } from './ai-usage-access.js';
import { reportUserNameSql, reportWorkspaceNameSql } from './ai-usage-identities.js';

export function reportOrder(filters = {}, allowed, defaultKey, stable) {
  const key = filters.sortBy || defaultKey;
  const direction = filters.sortDir || 'desc';
  if (typeof key !== 'string' || !Object.hasOwn(allowed, key) || !['asc', 'desc'].includes(direction)) {
    throw aiUsageError(400, 'invalidFilter', 'Invalid report sort');
  }
  const column = allowed[key];
  return `(${column} IS NULL) ASC, ${column} ${direction.toUpperCase()}, ${stable}`;
}

function numericRange(filters, allowed) {
  const metric = filters.metric || '';
  if (metric && (typeof metric !== 'string' || !allowed.includes(metric))) throw aiUsageError(400, 'invalidFilter', 'Invalid metric');
  const parse = (value) => {
    if (value == null || value === '') return null;
    if (!['string', 'number'].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) < 0) {
      throw aiUsageError(400, 'invalidFilter', 'Metric bounds must be finite non-negative numbers');
    }
    return Number(value);
  };
  const min = parse(filters.minValue); const max = parse(filters.maxValue);
  if ((min != null || max != null) && !metric) throw aiUsageError(400, 'invalidFilter', 'A metric is required for bounds');
  if (min != null && max != null && min > max) throw aiUsageError(400, 'invalidFilter', 'Metric minimum exceeds maximum');
  return { metric, min, max };
}

// All SQL fragments below are code-owned. Interactive analysis operates only on
// the authorized, immutable report CTE; no raw history handle is exposed.
export function createAiUsageAnalysis({ db, context, durationSql, hookConditions }) {
  return function analysis(access, filters = {}) {
    const dataset = filters.dataset || 'usage';
    const allowed = {
      usage: ['user', 'workspace', 'provider', 'day', 'week', 'month'],
      hooks: ['hook', 'user', 'workspace', 'day', 'week', 'month'],
      hookExecutions: ['hook', 'user', 'workspace', 'day', 'week', 'month'],
      templates: ['template', 'user', 'workspace', 'day', 'week', 'month'],
    };
    if (typeof dataset !== 'string' || !Object.hasOwn(allowed, dataset)) throw aiUsageError(400, 'invalidFilter', 'Invalid analysis dataset');
    const groupBy = filters.groupBy || allowed[dataset][0];
    if (!allowed[dataset].includes(groupBy)) throw aiUsageError(400, 'invalidFilter', 'Unsupported grouping');
    if (filters.includeZeroUsers != null && ![true, false, 'true', 'false'].includes(filters.includeZeroUsers)) {
      throw aiUsageError(400, 'invalidFilter', 'Invalid zero-usage user option');
    }
    const includeZeroUsers = filters.includeZeroUsers === true || filters.includeZeroUsers === 'true';
    if (includeZeroUsers && (dataset !== 'usage' || groupBy !== 'user')) {
      throw aiUsageError(400, 'invalidFilter', 'Zero-usage users are only available in usage grouped by user');
    }
    const ctx = context(access, filters);
    const userLabel = reportUserNameSql('actor_id');
    const templateId = "COALESCE(json_extract(value_json,'$.templateId'),CASE WHEN dataset='template_applications' THEN subject_id END)";
    const dimensions = {
      user: ['CAST(actor_id AS TEXT)', userLabel],
      workspace: ['CAST(workspace_id AS TEXT)', reportWorkspaceNameSql],
      provider: ["json_extract(value_json,'$.provider')", "json_extract(value_json,'$.provider')"],
      day: ['stat_date', 'stat_date'],
      week: ["date(stat_date,'-' || ((CAST(strftime('%w',stat_date) AS INTEGER)+6)%7) || ' days')"],
      month: ["substr(stat_date,1,7)"],
      hook: ['subject_id', "json_extract(value_json,'$.hookName')"],
      template: [`CAST(${templateId} AS TEXT)`, "json_extract(value_json,'$.templateName')"],
    };
    const [key, name = key] = dimensions[groupBy];
    let where; let aggregate; let keys; let extra = {};
    if (dataset === 'usage') {
      where = "dataset IN ('interactions','turns')";
      where += ` AND COALESCE(${userLabel},'') LIKE @search ESCAPE '\\'`;
      aggregate = `COUNT(DISTINCT CASE WHEN dataset='interactions' THEN session_key END) AS sessionCount,
        COALESCE(SUM(${durationSql}),0) AS activeDurationMs,
        COUNT(DISTINCT CASE WHEN dataset='interactions' THEN actor_id END) AS activeUserCount`;
      keys = ['sessionCount', 'activeDurationMs', 'activeUserCount'];
    } else if (dataset === 'hookExecutions') {
      where = "dataset='hook_executions' AND COALESCE(json_extract(value_json,'$.hookName'),'') LIKE @search ESCAPE '\\'";
      aggregate = `COUNT(*) AS executionCount,SUM(json_extract(value_json,'$.status')='succeeded') AS successCount,
        SUM(json_extract(value_json,'$.status')='failed') AS failureCount,SUM(json_extract(value_json,'$.status')='running') AS runningCount,
        AVG(json_extract(value_json,'$.durationMs')) AS averageDurationMs`;
      keys = ['executionCount','successCount','failureCount','runningCount','averageDurationMs'];
    } else if (dataset === 'hooks') {
      const conditions = hookConditions(null, filters);
      where = `${conditions.where} AND COALESCE(json_extract(value_json,'$.hookName'),'') LIKE @search ESCAPE '\\'`;
      extra = conditions.params;
      aggregate = 'COUNT(*) AS recordCount,COUNT(DISTINCT actor_id) AS activeUserCount,COUNT(DISTINCT workspace_id) AS workspaceCount';
      keys = ['recordCount', 'activeUserCount', 'workspaceCount'];
    } else {
      where = `dataset IN ('template_applications','interactions','turns') AND ${templateId} IS NOT NULL
        AND COALESCE(json_extract(value_json,'$.templateName'),'') LIKE @search ESCAPE '\\'`;
      if (filters.templateId != null) {
        if (typeof filters.templateId !== 'string' || !filters.templateId || filters.templateId.length > 160) {
          throw aiUsageError(400, 'invalidFilter', 'Invalid template identity');
        }
        extra.template = filters.templateId;
        where += ` AND CAST(${templateId} AS TEXT)=@template`;
      }
      aggregate = `SUM(CASE WHEN dataset='template_applications' THEN 1 ELSE 0 END) AS applicationCount,
        COUNT(DISTINCT CASE WHEN dataset='template_applications' THEN actor_id END) AS applicationUserCount,
        COUNT(DISTINCT CASE WHEN dataset='interactions' THEN actor_id END) AS activeUserCount,
        COUNT(DISTINCT CASE WHEN dataset='interactions' THEN session_key END) AS sessionCount,
        COALESCE(SUM(${durationSql}),0) AS activeDurationMs`;
      keys = ['applicationCount', 'applicationUserCount', 'activeUserCount', 'sessionCount', 'activeDurationMs'];
    }
    const range = numericRange(filters, keys);
    const unavailable = { activeDurationMs: 'duration', publishedSkillCount: 'skillPublications', skillInvocationCount: 'skillInvocations' };
    if ((range.min != null || range.max != null) && ctx.meta.coverage[unavailable[range.metric]] === 'unavailable') {
      throw aiUsageError(400, 'invalidFilter', 'Cannot bound an unavailable metric');
    }
    const order = reportOrder(filters, Object.fromEntries(['groupLabel', ...keys].map((value) => [value, value])), keys[0], 'groupKey');
    const parameters = { ...ctx.params, ...extra, metricMin: range.min, metricMax: range.max };
    const selection = range.metric ? `(@metricMin IS NULL OR ${range.metric}>=@metricMin) AND (@metricMax IS NULL OR ${range.metric}<=@metricMax)` : '1=1';
    // Keep the historical groups from the published projection, and add current
    // authorized tenant members with no matching facts. Zero rows never enter
    // the fact source, so distinct totals/activity cannot be inflated.
    const zeroUsers = includeZeroUsers ? `UNION ALL
      SELECT CAST(u.id AS TEXT) AS groupKey, u.username AS groupLabel, ${keys.map((field) => `0 AS ${field}`).join(',')}
      FROM users u WHERE EXISTS (SELECT 1 FROM tenant_users m WHERE m.user_id=u.id AND m.tenant_id=@tenant)
      AND (@self IS NULL OR u.id=@self) AND (@userId IS NULL OR u.id=@userId)
      AND u.username LIKE @search ESCAPE '\\'
      AND (@userSearch IS NULL OR u.username LIKE @userSearch ESCAPE '\\')
      AND NOT EXISTS (SELECT 1 FROM source s WHERE s.groupKey=CAST(u.id AS TEXT))` : '';
    const cte = `${ctx.cte}, source AS (SELECT *,COALESCE(CAST(${key} AS TEXT),'__unknown__') AS groupKey,
      ${name} AS groupLabel FROM report WHERE ${where}),
      grouped AS (SELECT groupKey,MAX(groupLabel) AS groupLabel,${aggregate} FROM source GROUP BY groupKey ${zeroUsers}),
      selected AS (SELECT * FROM grouped WHERE ${selection})`;
    const convert = (row) => {
      const output = { ...row };
      for (const field of keys) if (field !== 'averageDurationMs') output[field] = output[field] ?? 0;
      if (dataset === 'usage' && ctx.meta.coverage.duration === 'unavailable') output.activeDurationMs = null;
      else if (dataset === 'templates' && ctx.meta.coverage.duration === 'unavailable') output.activeDurationMs = null;
      return output;
    };
    if (!ctx.meta.batchId) return { ...ctx.meta, dataset, groupBy, includeZeroUsers, items: [], total: 0, summary: null, page: ctx.page, pageSize: ctx.pageSize };
    const total = db.prepare(`${cte} SELECT COUNT(*) AS n FROM selected`).get(parameters).n;
    const items = db.prepare(`${cte} SELECT * FROM selected ORDER BY ${order} LIMIT @limit OFFSET @offset`)
      .all({ ...parameters, limit: ctx.pageSize, offset: (ctx.page - 1) * ctx.pageSize }).map(convert);
    // Recompute distinct counts over every matching group, never SUM the page
    // or its per-group distinct user/session counts (which can overlap).
    const summary = convert(db.prepare(`${cte} SELECT ${aggregate} FROM source
      WHERE groupKey IN (SELECT groupKey FROM selected)`).get(parameters));
    return { ...ctx.meta, dataset, groupBy, includeZeroUsers, items, total, summary, page: ctx.page, pageSize: ctx.pageSize };
  };
}
