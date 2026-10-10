import { aiUsageError } from './ai-usage-access.js';
import { reportOrder } from './ai-usage-analysis.js';
import { reportUserNameSql, reportWorkspaceNameSql } from './ai-usage-identities.js';
import { shiftDate } from './ai-usage-config.js';

const aggregate = `
  SUM(CASE WHEN dataset='sql_lines' THEN json_extract(value_json,'$.generatedLines') END) AS generatedLines,
  SUM(CASE WHEN dataset='code_submissions' THEN json_extract(value_json,'$.submittedLines') END) AS submittedLines,
  SUM(dataset='sql_lines') AS sqlRecordCount, SUM(dataset='code_submissions') AS submissionCount,
  SUM(dataset='sql_lines' AND json_extract(value_json,'$.generatedLines') IS NULL) AS unknownSqlRecords,
  SUM(dataset='code_submissions' AND json_extract(value_json,'$.submittedLines') IS NULL) AS unknownSubmissions`;

export function createCodeReport({ db, context, list }) {
  function source(access, filters = {}) {
    const groupBy = filters.groupBy || 'user';
    const dimensions = {
      user: ['CAST(actor_id AS TEXT)', reportUserNameSql('actor_id')],
      workspace: ['CAST(workspace_id AS TEXT)', reportWorkspaceNameSql],
      day: ['stat_date', 'stat_date'],
      week: ["date(stat_date,'-'||((CAST(strftime('%w',stat_date) AS INTEGER)+6)%7)||' days')"],
      month: ["substr(stat_date,1,7)"],
    };
    if (!Object.hasOwn(dimensions, groupBy)) throw aiUsageError(400, 'invalidFilter', 'Unsupported code grouping');
    const ctx = context(access, filters);
    const [key, label = key] = dimensions[groupBy];
    ctx.cte += `, code_source AS (SELECT *,COALESCE(${key},'__unknown__') AS groupKey,
      ${label} AS groupLabel, ${reportUserNameSql()} AS userName, ${reportWorkspaceNameSql} AS workspaceName
      FROM report WHERE dataset IN ('sql_lines','code_submissions'))`;
    return { ctx, groupBy };
  }
  function normalize(row, coverage) {
    const result = { ...row };
    for (const key of ['sqlRecordCount', 'submissionCount', 'unknownSqlRecords', 'unknownSubmissions']) result[key] ??= 0;
    // Zero matching records differs from rows whose numeric values are unknown.
    result.generatedLines = coverage.generatedSql === 'unavailable' ? null : row?.generatedLines ?? (result.sqlRecordCount ? null : 0);
    result.submittedLines = coverage.submittedCode === 'unavailable' ? null : row?.submittedLines ?? (result.submissionCount ? null : 0);
    return result;
  }
  function code(access, filters = {}) {
    const { ctx, groupBy } = source(access, filters);
    const order = reportOrder(filters, { groupLabel: 'groupLabel', generatedLines: 'generatedLines', submittedLines: 'submittedLines' }, 'generatedLines', 'groupKey');
    const result = list(ctx, `SELECT groupKey,MAX(groupLabel) AS groupLabel,${aggregate} FROM code_source GROUP BY groupKey ORDER BY ${order}`, {}, row => normalize(row, ctx.meta.coverage));
    if (!ctx.meta.batchId) return { ...result, groupBy, summary: null, trend: [] };
    const summary = normalize(db.prepare(`${ctx.cte} SELECT ${aggregate} FROM code_source`).get(ctx.params), ctx.meta.coverage);
    const days = db.prepare(`${ctx.cte} SELECT stat_date AS date,${aggregate} FROM code_source GROUP BY stat_date ORDER BY stat_date`).all(ctx.params);
    const byDate = new Map(days.map(row => [row.date, row]));
    const trend = [];
    for (let date = ctx.meta.from; date <= ctx.meta.to; date = shiftDate(date, 1)) {
      trend.push({ date, ...normalize(byDate.get(date) || {}, ctx.meta.coverage) });
    }
    return { ...result, groupBy, summary, trend, codeReportVersion: 1 };
  }
  function codeRecords(access, filters = {}) {
    if (filters.groupKey != null && (typeof filters.groupKey !== 'string' || filters.groupKey.length > 160)) throw aiUsageError(400, 'invalidFilter', 'Invalid code group');
    const { ctx, groupBy } = source(access, filters);
    const order = reportOrder(filters, { occurredAt: 'occurred_at', submittedLines: "json_extract(value_json,'$.submittedLines')", userName: 'userName', workspaceName: 'workspaceName' }, 'occurredAt', 'row_key');
    return { ...list(ctx, `SELECT subject_id AS submissionId,occurred_at AS occurredAt,userName,workspaceName,
      json_extract(value_json,'$.repositoryUrl') AS repositoryUrl,json_extract(value_json,'$.commitSha') AS commitSha,
      json_extract(value_json,'$.submittedLines') AS submittedLines FROM code_source
      WHERE dataset='code_submissions' AND (@groupKey IS NULL OR groupKey=@groupKey) ORDER BY ${order}`, { groupKey: filters.groupKey ?? null }), groupBy };
  }
  return { code, codeRecords };
}
