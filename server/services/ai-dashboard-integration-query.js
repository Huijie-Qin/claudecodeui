// Previous wide-table query, retained as a regression reference for five-table
// migration. Production dashboard queries use ai-dashboard-split-query.js;
// this module is NOT a runtime fallback. Internal aliases are not stored columns.
export const integrationReportCte = `WITH RECURSIVE calendar(day) AS (
  SELECT @from UNION ALL SELECT date(day,'+1 day') FROM calendar WHERE day<@to
), integration_source AS (
  SELECT d.tenant_id,d.id AS row_key,d.stat_date,
    CASE WHEN d.skill_call_count=1 THEN d.publisher_user_id ELSE d.user_id END AS user_id,d.workspace_id,
    COALESCE(d.skill_id,d.sql_record_id,d.code_submission_id) AS subject_id,d.ai_session_id AS session_key,
    CASE WHEN d.occurred_at IS NOT NULL THEN replace(d.occurred_at,' ','T')||'+08:00' END AS occurred_at,
    CASE WHEN d.has_ai_interaction=1 THEN 'interactions'
      WHEN d.ai_active_duration_ms IS NOT NULL THEN 'turns'
      WHEN d.skill_publish_count=1 THEN 'skill_publications'
      WHEN d.skill_call_count=1 THEN 'skill_invocations'
      WHEN d.sql_record_id IS NOT NULL THEN 'sql_lines' ELSE 'code_submissions' END AS dataset,
    json_object('userName',CASE WHEN d.skill_id IS NOT NULL THEN d.publisher_user_name ELSE d.user_name END,
      'workspaceName',d.workspace_name,'status','completed','durationMs',d.ai_active_duration_ms,
      'skillName',d.skill_name,'publisherUserId',d.publisher_user_id,'callerUserId',d.user_id,
      'generatedLines',d.generated_sql_lines,'submittedLines',d.submitted_code_lines,
      'repositoryUrl',d.repository_url,'commitSha',d.commit_sha,'sqlRecordId',d.sql_record_id) AS value_json
  FROM ai_dashboard_integration_detail d WHERE d.tenant_id=@tenant AND d.stat_date<=@to
    AND NOT EXISTS (SELECT 1 FROM ai_usage_suppressed_rows s WHERE s.tenant_id=d.tenant_id
      AND s.dataset='hook_records' AND s.row_key=d.sql_record_id)
), integration_activity AS (
  SELECT i.tenant_id,'active:'||c.day||':'||i.user_id||':'||COALESCE(i.workspace_id,'') AS row_key,
    c.day AS stat_date,i.user_id,i.workspace_id,NULL AS subject_id,NULL AS session_key,NULL AS occurred_at,
    'active_users' AS dataset,json_object('isDau',MAX(i.stat_date=c.day),
      'userName',MAX(json_extract(i.value_json,'$.userName')),
      'workspaceName',MAX(json_extract(i.value_json,'$.workspaceName'))) AS value_json
  FROM integration_source i JOIN calendar c ON i.dataset='interactions'
    AND i.stat_date BETWEEN date(c.day,'-29 days') AND c.day AND i.user_id IS NOT NULL
  GROUP BY i.tenant_id,c.day,i.user_id,i.workspace_id
), integration_report AS (
  SELECT * FROM integration_source UNION ALL SELECT * FROM integration_activity
)`;

// Read-only compatibility for already-running, in-memory previews. Both names
// read the same new fact table; this never switches back to the old report.
export function integrationReportCteFor(db) {
  const columns = db.prepare('PRAGMA table_info(ai_dashboard_integration_detail)').all();
  return columns.some(column => column.name === 'id') ? integrationReportCte
    : columns.some(column => column.name === 'detail_id') ? integrationReportCte.replace('d.id AS row_key', 'd.detail_id AS row_key')
      : integrationReportCte;
}
