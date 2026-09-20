import { SPLIT_SCHEMA_VERSION } from '../database/ai-dashboard-split-schema.js';

// Adapt the five published topic tables to the existing endpoint DTOs. These
// aliases are query-local only: neither the wide table nor the old report is a
// metric source here. The AI daily row can supply BOTH an interaction and time.
const source = (table, dataset, { user = 'd.user_id', subject = 'NULL', session = 'NULL', values, condition = '1' }) => `
  SELECT d.tenant_id,'${dataset}:'||d.id AS row_key,d.stat_date,
    ${user} AS user_id,d.workspace_id,${subject} AS subject_id,${session} AS session_key,
    CASE WHEN d.occurred_at IS NOT NULL THEN replace(d.occurred_at,' ','T')||'+08:00' END AS occurred_at,
    '${dataset}' AS dataset,json_object(${values},'workspaceName',d.workspace_name) AS value_json
  FROM ${table} d WHERE d.tenant_id=@tenant AND d.stat_date<=@to AND (${condition})`;

export const splitReportCte = `WITH RECURSIVE calendar(day) AS (
  SELECT @from UNION ALL SELECT date(day,'+1 day') FROM calendar WHERE day<@to
), split_snapshot AS (
  SELECT tenant_id FROM ai_dashboard_split_state
  WHERE tenant_id=@tenant AND batch_id=@batch AND schema_version=${SPLIT_SCHEMA_VERSION}
), split_ai AS (
  SELECT * FROM ai_dashboard_ai_detail WHERE tenant_id=@tenant AND stat_date<=@to
), split_source AS (
  ${source('split_ai', 'interactions', {
    session: 'd.ai_session_id', values: "'userName',d.user_name", condition: 'd.has_ai_interaction=1',
  })}
  UNION ALL
  ${source('split_ai', 'turns', {
    session: 'd.ai_session_id',
    // Storage uses fractional seconds; preserve the existing millisecond API
    // and avoid binary floating-point drift when summing many daily sessions.
    values: "'userName',d.user_name,'status','completed','durationMs',CAST(round(d.ai_active_duration_seconds*1000) AS INTEGER)",
    condition: 'd.ai_active_duration_seconds IS NOT NULL',
  })}
  UNION ALL
  ${source('ai_dashboard_skill_publication_detail', 'skill_publications', {
    user: 'd.publisher_user_id', subject: 'd.skill_id',
    values: "'userName',d.publisher_user_name,'skillName',d.skill_name,'publisherUserId',d.publisher_user_id",
  })}
  UNION ALL
  ${source('ai_dashboard_skill_invocation_detail', 'skill_invocations', {
    user: 'd.publisher_user_id', subject: 'd.skill_id',
    values: "'userName',d.publisher_user_name,'skillName',d.skill_name,'publisherUserId',d.publisher_user_id,'callerUserId',d.user_id",
  })}
  UNION ALL
  ${source('ai_dashboard_sql_generation_detail', 'sql_lines', {
    subject: 'd.sql_record_id', values: "'userName',d.user_name,'generatedLines',d.generated_sql_lines,'sqlRecordId',d.sql_record_id",
    condition: "NOT EXISTS (SELECT 1 FROM ai_usage_suppressed_rows s WHERE s.tenant_id=d.tenant_id AND s.dataset='hook_records' AND s.row_key=d.sql_record_id)",
  })}
  UNION ALL
  ${source('ai_dashboard_code_submission_detail', 'code_submissions', {
    subject: 'd.code_submission_id',
    values: "'userName',d.user_name,'submittedLines',d.submitted_code_lines,'repositoryUrl',d.repository_url,'commitSha',d.commit_sha",
    condition: "NOT EXISTS (SELECT 1 FROM ai_usage_suppressed_rows s WHERE s.tenant_id=d.tenant_id AND s.dataset='code_submissions' AND s.row_key=d.code_submission_id)",
  })}
), split_activity AS (
  SELECT i.tenant_id,'active:'||c.day||':'||i.user_id||':'||COALESCE(i.workspace_id,'') AS row_key,
    c.day AS stat_date,i.user_id,i.workspace_id,NULL AS subject_id,NULL AS session_key,NULL AS occurred_at,
    'active_users' AS dataset,json_object('isDau',MAX(i.stat_date=c.day),
      'userName',MAX(json_extract(i.value_json,'$.userName')),
      'workspaceName',MAX(json_extract(i.value_json,'$.workspaceName'))) AS value_json
  FROM split_source i JOIN calendar c ON i.dataset='interactions'
    AND i.stat_date BETWEEN date(c.day,'-29 days') AND c.day AND i.user_id IS NOT NULL
  GROUP BY i.tenant_id,c.day,i.user_id,i.workspace_id
), split_report AS (
  SELECT * FROM split_source WHERE EXISTS (SELECT 1 FROM split_snapshot)
  UNION ALL SELECT * FROM split_activity WHERE EXISTS (SELECT 1 FROM split_snapshot)
)`;

// Fail closed for an ungenerated, obsolete or mismatched snapshot. A read never
// backfills or falls back to another fact table; migrations/nightly publish own it.
export function splitSnapshotReady(db, tenantId, batchId) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_dashboard_split_state'").get()) return false;
  const state = db.prepare('SELECT batch_id,schema_version FROM ai_dashboard_split_state WHERE tenant_id=?').get(tenantId);
  return state?.batch_id === batchId && state.schema_version === SPLIT_SCHEMA_VERSION;
}
