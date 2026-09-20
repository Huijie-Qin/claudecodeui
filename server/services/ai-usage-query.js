import { aiUsageError, positiveId } from './ai-usage-access.js';
import { createAiUsageAnalysis, reportOrder } from './ai-usage-analysis.js';
import { skillReport } from './ai-usage-skill-report.js';
import { shiftDate } from './ai-usage-config.js';
import { reportIdentityColumns, reportIdentitySorts, reportUserNameSql, reportWorkspaceNameSql } from './ai-usage-identities.js';
import { splitReportCte, splitSnapshotReady } from './ai-dashboard-split-query.js';
import { createCodeReport } from './ai-usage-code-report.js';

const parseJson = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
function hookDto(json) {
  const value = parseJson(json);
  const fields = Array.isArray(value.fields) ? value.fields.filter((field) => field && typeof field.key === 'string' &&
    ((field.type === 'number' && Number.isFinite(field.value)) || (field.type === 'boolean' && typeof field.value === 'boolean') || (field.type === 'string' && typeof field.value === 'string')))
    .map((field) => ({ key: field.key, label: field.label, type: field.type, value: field.value, unit: field.unit, aggregation: field.aggregation })) : [];
  return { hookId: value.hookId, hookName: value.hookName, postActionId: value.postActionId, recordType: value.recordType,
    hookVersion: value.hookVersion, recordSource: value.recordSource, fieldsUnavailable: Boolean(value.fieldsUnavailable), fields };
}
const actorSql = `CASE WHEN r.dataset = 'skill_invocations' THEN json_extract(r.value_json, '$.publisherUserId') WHEN r.dataset = 'skill_publications' THEN COALESCE(json_extract(r.value_json, '$.publisherUserId'), r.user_id) ELSE r.user_id END`;
const durationSql = `CASE WHEN dataset = 'turns' AND json_extract(value_json, '$.status') = 'completed' THEN COALESCE(json_extract(value_json, '$.durationMs'), 0) ELSE 0 END`;
const metricSql = `COUNT(DISTINCT CASE WHEN dataset = 'interactions' THEN session_key END) AS sessionCount,
  COALESCE(SUM(${durationSql}), 0) AS activeDurationMs,
  COUNT(DISTINCT CASE WHEN dataset = 'skill_publications' THEN subject_id END) AS publishedSkillCount,
  SUM(CASE WHEN dataset = 'skill_invocations' AND actor_id IS NOT NULL THEN 1 ELSE 0 END) AS skillInvocationCount`;
const activitySql = (endOnly = false) => `COUNT(DISTINCT CASE WHEN dataset='active_users' ${endOnly ? 'AND stat_date=@to' : ''}
  AND json_extract(value_json,'$.isDau')=1 THEN actor_id END) AS dau,
  COUNT(DISTINCT CASE WHEN dataset='active_users' ${endOnly ? 'AND stat_date=@to' : ''} THEN actor_id END) AS mau`;

function dayInZone(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type).value).join('-');
}

function parseDay(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw aiUsageError(400, 'invalidFilter', `${name} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

export function createAiUsageQueryService({ db, getScheduleStatus = () => ({}) }) {
  function batchFor(access, batchId) {
    if (batchId != null && (typeof batchId !== 'string' || !batchId || batchId.length > 160)) throw aiUsageError(400, 'invalidFilter', 'Invalid batchId');
    const batch = batchId
      ? db.prepare("SELECT * FROM ai_usage_batches WHERE id = ? AND tenant_id = ? AND status = 'published'").get(batchId, access.tenantId)
      : db.prepare("SELECT b.* FROM ai_usage_tenant_state s JOIN ai_usage_batches b ON b.id = s.active_batch_id AND b.tenant_id = s.tenant_id WHERE s.tenant_id = ? AND b.status = 'published'").get(access.tenantId);
    if (batchId && !batch) throw aiUsageError(404, 'batchNotFound', 'Published report batch not found');
    if (batchId && db.prepare('SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=?').get(access.tenantId)?.active_batch_id !== batchId) {
      throw aiUsageError(409, 'reportUpdated', 'Report has been refreshed; reload before querying or exporting');
    }
    return batch || null;
  }

  function status(access, batchId) {
    const schedule = getScheduleStatus() || {};
    const batch = batchFor(access, batchId);
    const rawCoverage = batch ? parseJson(batch.coverage_json) : {};
    // Tenant-wide diagnostic counts must not become an activity side channel in self scope.
    const coverage = access.scope === 'self'
      ? Object.fromEntries(['sessions', 'duration', 'skillPublications', 'skillInvocations', 'activeUsers', 'hooks', 'hookExecutions', 'templates', 'integrationVersion', 'generatedSql', 'submittedCode', 'reasons']
        .filter((key) => rawCoverage[key] !== undefined).map((key) => [key, rawCoverage[key]]))
      : { ...rawCoverage };
    coverage.status = !batch ? 'unavailable' : Object.values(coverage).some((value) => value === 'partial' || value === 'unavailable') ? 'partial' : 'complete';
    return { ...schedule, tenantId: access.tenantId, scope: access.scope, batchId: batch?.id ?? null,
      timeZone: batch?.time_zone || schedule.timeZone || 'Asia/Shanghai', dataThrough: batch?.target_through ?? null,
      dataThroughDate: batch ? dayInZone(Date.parse(batch.target_through) - 1, batch.time_zone || schedule.timeZone || 'Asia/Shanghai') : null,
      generatedAt: batch?.completed_at ?? null, lastSucceededAt: batch?.completed_at ?? null,
      sourceReadAt: batch?.source_read_at ?? null, calculationVersion: batch?.calculation_version ?? null,
      coverage, state: schedule.state || (batch ? 'idle' : 'not_generated') };
  }

  function context(access, filters = {}, { publicationHistory = false, split = false } = {}) {
    const meta = status(access, filters.batchId);
    if (split && meta.batchId && !splitSnapshotReady(db, access.tenantId, meta.batchId)) {
      throw aiUsageError(409, 'splitNotReady', 'Topic details have not been published for this batch; migrate or refresh the report');
    }
    if (split && (filters.provider || filters.groupBy === 'provider')) {
      throw aiUsageError(400, 'invalidFilter', 'Provider is not a supported dimension of the topic report');
    }
    const lastDay = meta.dataThrough ? dayInZone(Date.parse(meta.dataThrough) - 1, meta.timeZone) : null;
    const to = filters.to == null ? lastDay : parseDay(filters.to, 'to');
    const from = filters.from == null ? (to ? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10) : null) : parseDay(filters.from, 'from');
    if (from && to && from > to) throw aiUsageError(400, 'invalidFilter', 'from must not be after to');
    if (lastDay && to > lastDay) throw aiUsageError(400, 'dataNotGenerated', 'Requested dates have not been generated');
    if (from && to && Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 365 * 86400000) throw aiUsageError(400, 'invalidFilter', 'Date range must not exceed 366 days');
    const page = filters.page == null ? 1 : Number(filters.page);
    const pageSize = filters.pageSize == null ? 25 : Number(filters.pageSize);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw aiUsageError(400, 'invalidFilter', 'Invalid pagination');
    const provider = filters.provider == null || filters.provider === '' ? null : filters.provider;
    if (provider !== null && !['claude', 'codex', 'cursor', 'gemini'].includes(provider)) throw aiUsageError(400, 'invalidFilter', 'Invalid provider');
    const userId = filters.userId == null || filters.userId === '' ? null : positiveId(filters.userId, 'userId');
    const workspaceId = filters.workspaceId == null || filters.workspaceId === '' ? null : positiveId(filters.workspaceId, 'workspaceId');
    if (access.scope === 'self' && userId !== null && userId !== access.userId) throw aiUsageError(403, 'tenantReportDenied', 'Cannot filter another user in self scope');
    if (filters.search != null && (typeof filters.search !== 'string' || filters.search.length > 150)) throw aiUsageError(400, 'invalidFilter', 'search must be at most 150 characters');
    const search = `%${String(filters.search || '').replace(/[\\%_]/g, '\\$&')}%`;
    if (filters.userSearch != null && (typeof filters.userSearch !== 'string' || filters.userSearch.length > 150)) throw aiUsageError(400, 'invalidFilter', 'Invalid user search');
    const userSearch = filters.userSearch ? `%${filters.userSearch.replace(/[\\%_]/g, '\\$&')}%` : null;
    if (filters.workspaceSearch != null && (typeof filters.workspaceSearch !== 'string' || filters.workspaceSearch.length > 150)) throw aiUsageError(400, 'invalidFilter', 'Invalid workspace search');
    const workspaceSearch = filters.workspaceSearch ? `%${filters.workspaceSearch.replace(/[\\%_]/g, '\\$&')}%` : null;
    const params = { batch: meta.batchId, tenant: access.tenantId, from, to, self: access.scope === 'self' ? access.userId : null, provider, userId, workspaceId, search, userSearch, workspaceSearch };
    // These are safe report projections, never the raw message/Hook source tables.
    const cte = `${split ? splitReportCte + ',' : 'WITH'} scoped_report AS (SELECT r.*, ${actorSql} AS actor_id FROM ${split ? 'split_report' : 'ai_usage_report_rows'} r
      WHERE r.tenant_id = @tenant AND @batch=(SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=@tenant)
      AND (r.stat_date BETWEEN @from AND @to${publicationHistory ? " OR (r.dataset='skill_publications' AND r.stat_date<=@to)" : ''})
      AND (@self IS NULL OR ${actorSql} = @self)
      AND (@userId IS NULL OR ${actorSql} = @userId)
      AND (@workspaceId IS NULL OR r.workspace_id = @workspaceId)
      AND (@provider IS NULL OR r.dataset NOT IN ('interactions', 'turns', 'skill_invocations','daily_active_users','active_users') OR json_extract(r.value_json, '$.provider') = @provider)
      AND NOT EXISTS (SELECT 1 FROM ai_usage_suppressed_rows suppressed WHERE suppressed.tenant_id = r.tenant_id AND suppressed.dataset = r.dataset AND suppressed.row_key = r.row_key)
      AND (r.user_id IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id))),
      report AS (SELECT * FROM scoped_report report
        WHERE (@userSearch IS NULL OR ${reportUserNameSql('actor_id')} LIKE @userSearch ESCAPE '\\')
        AND (@workspaceSearch IS NULL OR ${reportWorkspaceNameSql} LIKE @workspaceSearch ESCAPE '\\'))`;
    return { meta: { ...meta, from, to }, params, cte, page, pageSize };
  }

  const coreContext = (access, filters, options = {}) => context(access, filters, { ...options, split: true });

  function metrics(row, coverage) {
    return { sessionCount: row?.sessionCount ?? 0, activeDurationMs: coverage.duration === 'unavailable' ? null : row?.activeDurationMs ?? 0,
      publishedSkillCount: coverage.skillPublications === 'unavailable' ? null : row?.publishedSkillCount ?? 0,
      skillInvocationCount: coverage.skillInvocations === 'unavailable' ? null : row?.skillInvocationCount ?? 0 };
  }

  function overview(access, filters) {
    const ctx = coreContext(access, filters);
    if (!ctx.meta.batchId) return { ...ctx.meta, sessionCount: null, activeDurationMs: null, publishedSkillCount: null, skillInvocationCount: null, dau: null, mau: null };
    const row = db.prepare(`${ctx.cte} SELECT ${metricSql},${activitySql(true)} FROM report`).get(ctx.params);
    const generated = ['complete', 'partial'].includes(ctx.meta.coverage.activeUsers);
    return { ...ctx.meta, ...metrics(row, ctx.meta.coverage), dau: generated ? row.dau : null, mau: generated ? row.mau : null,
      activityDate: ctx.meta.to, mauFrom: shiftDate(ctx.meta.to, -29) };
  }

  // Dashboard cards have their own scope and clock. Never inherit interactive
  // filters; only the authorized tenant/user and published batch are relevant.
  function summary(access, filters = {}) {
    const summaryAccess = { ...access, scope: access.canViewTenant ? 'tenant' : 'self' };
    const ctx = coreContext(summaryAccess, { batchId: filters.batchId }, { publicationHistory: true });
    const meta = { ...ctx.meta, summaryVersion: 1, activityDate: ctx.meta.to, mauFrom: ctx.meta.to ? shiftDate(ctx.meta.to, -29) : null };
    if (!ctx.meta.batchId) return { ...meta, sessionCount: null, publishedSkillCount: null, dau: null, mau: null };
    // The publication projection contains confirmed first publications only.
    // Include its full history, while sessions/activity retain the fixed 30 days.
    const row = db.prepare(`${ctx.cte} SELECT
      COUNT(DISTINCT CASE WHEN dataset='interactions' THEN session_key END) AS sessionCount,
      COUNT(DISTINCT CASE WHEN dataset='skill_publications' THEN subject_id END) AS publishedSkillCount,
      ${activitySql(true)} FROM report WHERE dataset IN ('interactions','skill_publications','active_users')`).get(ctx.params);
    const generated = ['complete', 'partial'].includes(ctx.meta.coverage.activeUsers);
    return { ...meta, sessionCount: row.sessionCount,
      publishedSkillCount: ctx.meta.coverage.skillPublications === 'unavailable' ? null : row.publishedSkillCount,
      dau: generated ? row.dau : null, mau: generated ? row.mau : null };
  }

  function list(ctx, sql, params = {}, transform = (row) => row) {
    const bindings = { ...ctx.params, ...params };
    const total = ctx.meta.batchId ? db.prepare(`${ctx.cte} SELECT COUNT(*) AS n FROM (${sql})`).get(bindings).n : 0;
    const rows = ctx.meta.batchId ? db.prepare(`${ctx.cte} ${sql} LIMIT @limit OFFSET @offset`).all({ ...bindings, limit: ctx.pageSize, offset: (ctx.page - 1) * ctx.pageSize }) : [];
    return { ...ctx.meta, items: rows.map(transform), total, page: ctx.page, pageSize: ctx.pageSize };
  }

  function trend(access, filters) {
    const ctx = coreContext(access, filters);
    const generated = ['complete', 'partial'].includes(ctx.meta.coverage.activeUsers);
    const rows = ctx.meta.batchId ? db.prepare(`${ctx.cte} SELECT stat_date AS date, ${metricSql},${activitySql()} FROM report GROUP BY stat_date ORDER BY stat_date`).all(ctx.params) : [];
    const byDate = new Map(rows.map((row) => [row.date, row]));
    const items = [];
    if (ctx.meta.batchId) for (let date = ctx.meta.from; date <= ctx.meta.to; date = shiftDate(date, 1)) {
      const row = byDate.get(date);
      items.push({ date, ...metrics(row, ctx.meta.coverage), dau: generated ? row?.dau || 0 : null, mau: generated ? row?.mau || 0 : null });
    }
    return { ...ctx.meta, items };
  }

  function users(access, filters) {
    if (!access.canViewTenant || access.scope !== 'tenant') throw aiUsageError(403, 'tenantReportDenied', 'Tenant user list requires tenant report access');
    const ctx = coreContext(access, filters);
    const order = reportOrder(filters, { displayName: 'u.username', sessionCount: 'COALESCE(stats.sessionCount,0)', activeDurationMs: 'COALESCE(stats.activeDurationMs,0)',
      publishedSkillCount: 'COALESCE(stats.publishedSkillCount,0)', skillInvocationCount: 'COALESCE(stats.skillInvocationCount,0)' }, 'activeDurationMs', 'u.id');
    return list(ctx, `SELECT u.id AS userId, u.username AS userName, u.username AS displayName, m.status AS memberStatus,
      COALESCE(stats.sessionCount,0) AS sessionCount, COALESCE(stats.activeDurationMs,0) AS activeDurationMs,
      COALESCE(stats.publishedSkillCount,0) AS publishedSkillCount, COALESCE(stats.skillInvocationCount,0) AS skillInvocationCount
      FROM users u JOIN tenant_users m ON m.user_id = u.id AND m.tenant_id = @tenant
      LEFT JOIN (SELECT actor_id, ${metricSql} FROM report GROUP BY actor_id) stats ON stats.actor_id = u.id
      WHERE (@userId IS NULL OR u.id = @userId) AND u.username LIKE @search ESCAPE '\\'
      AND (@userSearch IS NULL OR u.username LIKE @userSearch ESCAPE '\\')
      ORDER BY ${order}`, {}, (row) => ({ ...row, ...metrics(row, ctx.meta.coverage) }));
  }

  function hooks(access, filters) {
    const { where, params } = hookConditions(null, filters);
    const order = reportOrder(filters, Object.fromEntries(['hookName','postActionId','recordType','hookVersion','recordSource','recordCount'].map((key) => [key,key])),
      'recordCount', 'subject_id, postActionId, recordType, hookVersion, recordSource');
    return list(context(access, filters), `SELECT subject_id AS hookId, json_extract(value_json, '$.hookName') AS hookName,
      json_extract(value_json, '$.postActionId') AS postActionId, json_extract(value_json, '$.recordType') AS recordType,
      json_extract(value_json, '$.hookVersion') AS hookVersion, json_extract(value_json, '$.recordSource') AS recordSource,
      COUNT(*) AS recordCount FROM report WHERE ${where} AND COALESCE(json_extract(value_json, '$.hookName'), '') LIKE @search ESCAPE '\\'
      GROUP BY subject_id, postActionId, recordType, hookVersion, recordSource ORDER BY ${order}`, params);
  }

  function skills(access, filters = {}) {
    return skillReport(coreContext, list, db, access, filters);
  }

  function hookExecutions(access, filters = {}) {
    const order = reportOrder(filters, Object.fromEntries(['hookName','hookVersion','eventName','executionCount','successCount','failureCount','runningCount','averageDurationMs'].map((key) => [key,key])), 'executionCount', 'hookId,hookVersion,eventName');
    return list(context(access, filters), `SELECT subject_id AS hookId, MAX(json_extract(value_json,'$.hookName')) AS hookName,
      json_extract(value_json,'$.hookVersion') AS hookVersion,json_extract(value_json,'$.eventName') AS eventName,
      COUNT(*) AS executionCount,SUM(json_extract(value_json,'$.status')='succeeded') AS successCount,
      SUM(json_extract(value_json,'$.status')='failed') AS failureCount,SUM(json_extract(value_json,'$.status')='running') AS runningCount,
      AVG(json_extract(value_json,'$.durationMs')) AS averageDurationMs
      FROM report WHERE dataset='hook_executions' AND COALESCE(json_extract(value_json,'$.hookName'),'') LIKE @search ESCAPE '\\'
      GROUP BY subject_id,hookVersion,eventName ORDER BY ${order}`);
  }

  function hookExecutionRecords(access, hookId, filters = {}) {
    const params = { hook: String(hookId) };
    let conditions = "dataset='hook_executions' AND subject_id=@hook";
    for (const key of ['hookVersion','eventName','executionStatus']) {
      if (filters[key] == null || filters[key] === '') continue;
      if (typeof filters[key] !== 'string' || filters[key].length > 150) throw aiUsageError(400, 'invalidFilter', 'Invalid execution filter');
      if (key === 'executionStatus' && !['running','succeeded','failed'].includes(filters[key])) throw aiUsageError(400, 'invalidFilter', 'Invalid execution status');
      params[key] = filters[key];
      conditions += ` AND CAST(json_extract(value_json,'$.${key === 'executionStatus' ? 'status' : key}') AS TEXT)=@${key}`;
    }
    const order = reportOrder(filters, { ...reportIdentitySorts, occurredAt: 'occurred_at', userId: 'user_id', workspaceId: 'workspace_id', status: "json_extract(value_json,'$.status')", durationMs: "json_extract(value_json,'$.durationMs')" }, 'occurredAt', 'row_key');
    return list(context(access, filters), `SELECT row_key AS id,user_id AS userId,workspace_id AS workspaceId,session_key AS sessionKey,occurred_at AS occurredAt,
      ${reportIdentityColumns},
      json_extract(value_json,'$.status') AS status,json_extract(value_json,'$.durationMs') AS durationMs,
      json_extract(value_json,'$.eventName') AS eventName,json_extract(value_json,'$.hookVersion') AS hookVersion,
      json_extract(value_json,'$.completedAt') AS completedAt
      FROM report WHERE ${conditions} ORDER BY ${order}`, params);
  }

  function hookConditions(hookId, filters = {}) {
    const params = {};
    let where = "dataset = 'hook_records'";
    if (hookId != null) { params.hook = String(hookId); where += ' AND subject_id = @hook'; }
    // A grouped-field drilldown must retain its actor, including unknown actors.
    // The enclosing report CTE still enforces tenant and self-scope permissions.
    if (filters.recordUserId != null && filters.recordUserId !== '') {
      if (filters.recordUserId === '__unknown__') where += ' AND user_id IS NULL';
      else { params.recordUserId = positiveId(filters.recordUserId, 'recordUserId'); where += ' AND user_id = @recordUserId'; }
    }
    for (const key of ['postActionId', 'recordType', 'hookVersion', 'recordSource']) {
      if (filters[key] != null) {
        if (typeof filters[key] !== 'string' || filters[key].length > 150) throw aiUsageError(400, 'invalidFilter', `Invalid ${key}`);
        if (filters[key] === '__unknown__') where += ` AND (json_extract(value_json, '$.${key}') IS NULL OR json_extract(value_json, '$.${key}') = '')`;
        else { params[key] = filters[key]; where += ` AND CAST(json_extract(value_json, '$.${key}') AS TEXT) = @${key}`; }
      }
    }
    return { where, params };
  }

  function hookRecords(access, hookId, filters = {}) {
    const ctx = context(access, filters);
    const { where, params } = hookConditions(hookId, filters);
    if (filters.fieldKey != null && (typeof filters.fieldKey !== 'string' || filters.fieldKey.length > 150)) throw aiUsageError(400, 'invalidFilter', 'Invalid field key');
    const fieldWhere = filters.fieldKey ? ` AND EXISTS (SELECT 1 FROM json_each(report.value_json,'$.fields') f
      WHERE json_extract(f.value,'$.key')=@fieldKey AND json_extract(f.value,'$.type')='number'
      AND json_type(f.value,'$.value') IN ('integer','real'))` : '';
    const order = reportOrder(filters, { ...reportIdentitySorts, occurredAt: 'occurred_at', userId: 'user_id', workspaceId: 'workspace_id', sessionKey: 'session_key' }, 'occurredAt', 'row_key');
    return list(ctx, `SELECT row_key AS id, user_id AS userId, workspace_id AS workspaceId, ${reportIdentityColumns}, session_key AS sessionKey, occurred_at AS occurredAt, value_json FROM report WHERE ${where}${fieldWhere} ORDER BY ${order}`, { ...params, ...(filters.fieldKey ? { fieldKey: filters.fieldKey } : {}) },
      ({ value_json: value, ...row }) => ({ ...row, ...hookDto(value) }));
  }

  function hookStatistics(access, hookId, filters = {}, paginated = false, reportView = false) {
    // Keep revision comparison and the selected projection in one short read snapshot.
    // A deleted source invalidates the frozen daily aggregate until the next batch.
    return db.transaction(() => {
      const ctx = context(access, filters);
      const groupBy = filters.groupBy ?? 'hook';
      if (!(reportView ? ['hook', 'user', 'workspace', 'day', 'week', 'month'] : ['hook', 'user']).includes(groupBy)) throw aiUsageError(400, 'invalidFilter', 'Unsupported Hook statistics grouping');
      const byUser = groupBy === 'user';
      const dimensions = {
        hook: ['subject_id', "json_extract(value_json,'$.hookName')"],
        user: ['user_id', reportUserNameSql()],
        workspace: ['workspace_id', reportWorkspaceNameSql],
        day: ['stat_date', 'stat_date'],
        week: ["date(stat_date,'-' || ((CAST(strftime('%w',stat_date) AS INTEGER)+6)%7) || ' days')"],
        month: ["substr(stat_date,1,7)"],
      };
      const [dimension, dimensionName = dimension] = dimensions[groupBy];
      // The single-Hook report combines versions of the same field definition.
      // Different actions, record types, sources, labels and units remain separate.
      const versionSelect = reportView ? '' : "json_extract(value_json, '$.hookVersion') AS hookVersion,";
      const versionGroup = reportView ? '' : 'hookVersion,';
      const dimensionSelect = reportView ? `${dimension} AS groupKey, MAX(${dimensionName}) AS groupLabel,` : '';
      const dimensionGroup = reportView ? `${dimension},` : byUser ? 'user_id,' : '';
      const conditions = hookConditions(hookId, filters);
      const revision = db.prepare('SELECT data_revision FROM ai_usage_tenant_state WHERE tenant_id = ?').get(access.tenantId)?.data_revision ?? 0;
      const privateCoverage = ctx.meta.batchId ? parseJson(batchFor(access, ctx.meta.batchId)?.coverage_json) : {};
      // Older daily summaries skipped number fields configured as display-only.
      // Until rebuilt overnight, use their already-redacted published records,
      // never raw Hook data, to provide complete statistics for every number.
      const daily = privateCoverage.hookNumericStatisticsVersion === 1 && Number.isInteger(privateCoverage.dataRevision) && privateCoverage.dataRevision === revision;
      const where = daily ? conditions.where.replace("dataset = 'hook_records'", "dataset = 'hook_daily'") : conditions.where;
      const count = daily ? "SUM(json_extract(f.value, '$.validCount'))" : 'COUNT(*)';
      const sum = `SUM(json_extract(f.value, '$.${daily ? 'sum' : 'value'}'))`;
      const min = `MIN(json_extract(f.value, '$.${daily ? 'min' : 'value'}'))`;
      const max = `MAX(json_extract(f.value, '$.${daily ? 'max' : 'value'}'))`;
      if (filters.fieldKey != null && (typeof filters.fieldKey !== 'string' || filters.fieldKey.length > 150)) throw aiUsageError(400, 'invalidFilter', 'Invalid field key');
      const sql = `SELECT ${dimensionSelect}${byUser ? `user_id AS userId, MAX(${reportUserNameSql()}) AS userName,` : ''}
      subject_id AS hookId, MAX(json_extract(value_json,'$.hookName')) AS hookName, json_extract(value_json, '$.postActionId') AS postActionId,
      json_extract(value_json, '$.recordType') AS recordType, ${versionSelect}
      json_extract(value_json, '$.recordSource') AS recordSource,
      json_extract(f.value, '$.key') AS key, json_extract(f.value, '$.label') AS label, json_extract(f.value, '$.unit') AS unit,
      ${count} AS validCount,
      ${sum} AS sum, 1.0 * ${sum} / NULLIF(${count}, 0) AS average, ${min} AS min, ${max} AS max
      FROM report, json_each(report.value_json, '$.fields') f WHERE ${where}
      AND COALESCE(json_extract(value_json,'$.hookName'),'') LIKE @search ESCAPE '\\'
      AND (@fieldKey IS NULL OR json_extract(f.value,'$.key')=@fieldKey)
      AND json_extract(f.value, '$.type') = 'number' AND json_type(f.value, '$.${daily ? 'sum' : 'value'}') IN ('integer', 'real')
      GROUP BY ${dimensionGroup} subject_id, postActionId, recordType, ${versionGroup} recordSource, key, label, unit`;
      const parameters = { ...ctx.params, ...conditions.params, fieldKey: filters.fieldKey || null };
      const order = paginated ? reportOrder(filters, Object.fromEntries(['hookName','label','validCount','sum','average','min','max', ...(reportView ? ['groupKey','groupLabel'] : ['hookVersion']), ...(byUser ? ['userId','userName'] : [])].map((key) => [key,key])), reportView ? 'groupLabel' : byUser ? 'userName' : 'hookName', `${reportView ? 'groupKey,' : byUser ? 'userId,' : ''}hookId,postActionId,recordType,${versionGroup}recordSource,key,label,unit`) : `${byUser ? 'userId,' : ''}key`;
      const items = ctx.meta.batchId ? db.prepare(`${ctx.cte} ${sql} ORDER BY ${order}${paginated ? ' LIMIT @limit OFFSET @offset' : ''}`)
        .all({ ...parameters, ...(paginated ? { limit: ctx.pageSize, offset: (ctx.page - 1) * ctx.pageSize } : {}) }) : [];
      const total = paginated && ctx.meta.batchId ? db.prepare(`${ctx.cte} SELECT COUNT(*) AS n FROM (${sql})`).get(parameters).n : items.length;
      const availableFields = reportView && ctx.meta.batchId ? db.prepare(`${ctx.cte} SELECT DISTINCT key,label,unit FROM (${sql}) ORDER BY label,key,unit`).all({ ...parameters, fieldKey: null }) : [];
      return { ...ctx.meta, groupBy, items, total, page: ctx.page, pageSize: ctx.pageSize, aggregationSource: daily ? 'daily' : 'records', numericStatisticsVersion: 1,
        ...(reportView ? { hookReportVersion: 1, availableFields } : {}) };
    }).deferred();
  }

  function templates(access, filters) {
    const ctx = context(access, filters);
    const order = reportOrder(filters, Object.fromEntries(['templateName','applicationCount','applicationUserCount','activeUserCount','sessionCount','activeDurationMs'].map((key) => [key,key])), 'applicationCount', 'templateId');
    return list(ctx, `SELECT COALESCE(json_extract(value_json, '$.templateId'), CASE WHEN dataset = 'template_applications' THEN subject_id END) AS templateId,
      MAX(json_extract(value_json, '$.templateName')) AS templateName,
      SUM(CASE WHEN dataset = 'template_applications' THEN 1 ELSE 0 END) AS applicationCount,
      COUNT(DISTINCT CASE WHEN dataset = 'template_applications' THEN user_id END) AS applicationUserCount,
      COUNT(DISTINCT CASE WHEN dataset = 'interactions' THEN user_id END) AS activeUserCount,
      COUNT(DISTINCT CASE WHEN dataset = 'interactions' THEN session_key END) AS sessionCount,
      SUM(${durationSql}) AS activeDurationMs FROM report
      WHERE dataset IN ('template_applications', 'interactions', 'turns')
      AND (json_extract(value_json, '$.templateId') IS NOT NULL OR dataset = 'template_applications')
      AND COALESCE(json_extract(value_json, '$.templateName'), '') LIKE @search ESCAPE '\\'
      GROUP BY templateId ORDER BY ${order}`, {}, (row) => ({ ...row, activeDurationMs: ctx.meta.coverage.duration === 'unavailable' ? null : row.activeDurationMs }));
  }

  function templateApplications(access, templateId, filters) {
    const order = reportOrder(filters, { ...reportIdentitySorts, occurredAt: 'occurred_at', userId: 'user_id', workspaceId: 'workspace_id' }, 'occurredAt', 'row_key');
    return list(context(access, filters), `SELECT row_key AS id, user_id AS userId, workspace_id AS workspaceId, ${reportIdentityColumns}, occurred_at AS occurredAt, value_json
      FROM report WHERE dataset = 'template_applications' AND subject_id = @template ORDER BY ${order}`, { template: String(templateId) },
    ({ value_json: value, ...row }) => ({ ...parseJson(value), ...row }));
  }

  function templateSessions(access, templateId, filters) {
    const ctx = context(access, filters);
    const order = reportOrder(filters, { ...reportIdentitySorts, ...Object.fromEntries(['firstInteractionAt','lastInteractionAt','userId','workspaceId','provider','activeDurationMs'].map((key) => [key,key])) }, 'lastInteractionAt', 'session_key');
    return list(ctx, `SELECT session_key AS sessionKey, user_id AS userId, workspace_id AS workspaceId,
      MAX(${reportUserNameSql()}) AS userName, MAX(${reportWorkspaceNameSql}) AS workspaceName, MAX(json_extract(value_json, '$.provider')) AS provider,
      MIN(CASE WHEN dataset = 'interactions' THEN COALESCE(json_extract(value_json, '$.firstInteractionAt'), occurred_at) END) AS firstInteractionAt,
      MAX(CASE WHEN dataset = 'interactions' THEN COALESCE(json_extract(value_json, '$.lastInteractionAt'), occurred_at) END) AS lastInteractionAt,
      SUM(${durationSql}) AS activeDurationMs
      FROM report WHERE dataset IN ('interactions', 'turns') AND CAST(json_extract(value_json, '$.templateId') AS TEXT) = @template
      AND session_key IS NOT NULL GROUP BY session_key, user_id, workspace_id
      HAVING SUM(CASE WHEN dataset = 'interactions' THEN 1 ELSE 0 END) > 0 ORDER BY ${order}`, { template: String(templateId) },
    (row) => ({ ...row, activeDurationMs: ctx.meta.coverage.duration === 'unavailable' ? null : row.activeDurationMs }));
  }

  const analysis = createAiUsageAnalysis({ db,
    context: (access, filters) => (filters.dataset || 'usage') === 'usage' ? coreContext(access, filters) : context(access, filters),
    metricSql, durationSql, hookConditions, metrics });
  const hookFieldStatistics = (access, filters) => hookStatistics(access, null, filters, true);
  const { code, codeRecords } = createCodeReport({ db, context: coreContext, list });
  // A worker can publish through a different SQLite connection between two
  // SELECTs. Metadata, counts, totals and rows must share one read snapshot.
  const queries = { status, context, overview, summary, trend, users, skills, code, codeRecords, hooks, hookRecords, hookStatistics, hookFieldStatistics, hookExecutions, hookExecutionRecords, templates, templateApplications, templateSessions, analysis };
  return Object.fromEntries(Object.entries(queries).map(([name, query]) => [name, db.transaction(query).deferred]));
}
