import { aiUsageError } from './ai-usage-access.js';
import { reportOrder } from './ai-usage-analysis.js';

// First-publication history supplies the catalog; only selected dates supply
// new-publication counts and calls. Publisher attribution is owned by context().
export function skillReport(context, list, db, access, filters = {}) {
  const groupBy = filters.groupBy || 'skill';
  if (!['skill', 'publisher'].includes(groupBy)) throw aiUsageError(400, 'invalidFilter', 'Unsupported Skill grouping');
  const ctx = context(access, filters, { publicationHistory: true });
  ctx.cte += `, skill_names AS (
    SELECT subject_id AS skill_id, actor_id AS publisher_id,
      COALESCE(MAX(CASE WHEN dataset='skill_publications' THEN json_extract(value_json,'$.skillName') END),MAX(json_extract(value_json,'$.skillName')),subject_id) AS skill_name
    FROM report WHERE dataset IN ('skill_publications','skill_invocations') AND subject_id IS NOT NULL AND actor_id IS NOT NULL
    GROUP BY subject_id,actor_id
  ), skill_source AS (
    SELECT r.*,n.skill_name FROM report r JOIN skill_names n ON n.skill_id=r.subject_id AND n.publisher_id=r.actor_id
    WHERE r.dataset IN ('skill_publications','skill_invocations') AND n.skill_name LIKE @search ESCAPE '\\'
  )`;
  const aggregate = `COUNT(DISTINCT CASE WHEN dataset='skill_publications' AND stat_date BETWEEN @from AND @to THEN subject_id END) AS publishedSkillCount,
    COALESCE(SUM(CASE WHEN dataset='skill_invocations' THEN 1 ELSE 0 END),0) AS invocationCount,
    COUNT(DISTINCT CASE WHEN dataset='skill_invocations' THEN json_extract(value_json,'$.callerUserId') END) AS callerCount`;
  const sortKeys = ['publisherName','publishedSkillCount','invocationCount','callerCount','lastInvokedAt',...(groupBy === 'skill' ? ['skillName','firstPublishedAt'] : [])];
  const order = reportOrder(filters, Object.fromEntries(sortKeys.map(key => [key,key])), 'invocationCount', groupBy === 'skill' ? 'skillId,publisherUserId' : 'publisherUserId');
  const convert = row => ({ ...row,
    publishedSkillCount: ctx.meta.coverage.skillPublications === 'unavailable' ? null : row.publishedSkillCount,
    invocationCount: ctx.meta.coverage.skillInvocations === 'unavailable' ? null : row.invocationCount,
    callerCount: ctx.meta.coverage.skillInvocations === 'unavailable' ? null : row.callerCount,
  });
  const result = list(ctx, `SELECT actor_id AS publisherUserId,
    (SELECT username FROM users WHERE id=actor_id) AS publisherName,
    ${groupBy === 'skill' ? "subject_id AS skillId, MAX(skill_name) AS skillName, MIN(CASE WHEN dataset='skill_publications' THEN occurred_at END) AS firstPublishedAt," : ''}
    ${aggregate}, MAX(CASE WHEN dataset='skill_invocations' THEN occurred_at END) AS lastInvokedAt
    FROM skill_source GROUP BY ${groupBy === 'skill' ? 'subject_id,actor_id' : 'actor_id'} ORDER BY ${order}`, {}, convert);
  const summary = ctx.meta.batchId ? convert(db.prepare(`${ctx.cte} SELECT ${aggregate} FROM skill_source`).get(ctx.params)) : null;
  return { ...result, groupBy, skillGroupingVersion: 1, summary };
}
