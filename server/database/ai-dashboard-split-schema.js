// Additional topic-specific facts. The existing integration table stays intact.
const base = ['id', 'tenant_id', 'stat_date', 'occurred_at'];
const workspace = ['workspace_id', 'workspace_name'];
const actor = ['user_id', 'user_name', ...workspace];
const skill = ['skill_id', 'skill_name', 'publisher_user_id', 'publisher_user_name'];
export const SPLIT_SCHEMA_VERSION = 4;
// Six source fact kinds: four keep their v1 table shapes; AI interaction and
// duration are consolidated. These definitions also verify older projections.
export const LEGACY_SPLIT_DETAILS = [
  { key: 'interaction', table: 'ai_dashboard_interaction_detail', columns: [...base, ...actor, 'ai_session_id'], match: row => row.has_ai_interaction === 1 },
  { key: 'duration', table: 'ai_dashboard_duration_detail', columns: [...base, ...actor, 'ai_session_id', 'ai_active_duration_ms'], match: row => row.ai_active_duration_ms != null },
  { key: 'skill_publication', table: 'ai_dashboard_skill_publication_detail', columns: [...base, ...workspace, ...skill], match: row => row.skill_publish_count === 1 },
  { key: 'skill_invocation', table: 'ai_dashboard_skill_invocation_detail', columns: [...base, ...actor, ...skill], match: row => row.skill_call_count === 1 },
  { key: 'sql_generation', table: 'ai_dashboard_sql_generation_detail', columns: [...base, ...actor, 'sql_record_id', 'generated_sql_lines'], match: row => row.sql_record_id != null },
  { key: 'code_submission', table: 'ai_dashboard_code_submission_detail', columns: [...base, ...actor, 'code_submission_id', 'repository_url', 'commit_sha', 'submitted_code_lines'], match: row => row.code_submission_id != null },
].map(definition => ({ ...definition, staging: definition.table.replace(/_detail$/, '_staging') }));

const matches = (keys, row) => LEGACY_SPLIT_DETAILS.some(definition => keys.includes(definition.key) && definition.match(row));
export const V2_SPLIT_DETAILS = [
  { key: 'ai', table: 'ai_dashboard_ai_detail', columns: [...base, ...actor, 'ai_session_id', 'has_ai_interaction', 'ai_active_duration_ms'],
    match: row => matches(['interaction', 'duration'], row) },
  { key: 'skill', table: 'ai_dashboard_skill_detail', columns: [...base, ...actor, ...skill, 'skill_publish_count', 'skill_call_count'],
    match: row => matches(['skill_publication', 'skill_invocation'], row) },
  { key: 'code', table: 'ai_dashboard_code_detail', columns: [...base, ...actor, 'sql_record_id', 'generated_sql_lines', 'code_submission_id', 'repository_url', 'commit_sha', 'submitted_code_lines'],
    match: row => matches(['sql_generation', 'code_submission'], row) },
].map(definition => ({ ...definition, staging: definition.table.replace(/_detail$/, '_staging') }));

// AI is now one daily session/user/workspace row. The other four tables each
// contain one kind of fact, so publication/call discriminator flags are omitted.
export const SPLIT_DETAILS = [{ ...V2_SPLIT_DETAILS[0], columns: V2_SPLIT_DETAILS[0].columns.map(column => column === 'ai_active_duration_ms' ? 'ai_active_duration_seconds' : column) }, ...LEGACY_SPLIT_DETAILS.slice(2)];
export const PREVIOUS_SPLIT_DETAILS = [...LEGACY_SPLIT_DETAILS, ...V2_SPLIT_DETAILS];
export const RETIRED_SPLIT_DETAILS = PREVIOUS_SPLIT_DETAILS.filter(previous => !SPLIT_DETAILS.some(current => current.table === previous.table));

const integers = new Set(['tenant_id', 'user_id', 'workspace_id', 'publisher_user_id', 'has_ai_interaction', 'ai_active_duration_ms', 'skill_publish_count', 'skill_call_count', 'generated_sql_lines', 'submitted_code_lines']);
const fields = definition => definition.columns.map(column => `  ${column} ${column === 'ai_active_duration_seconds' ? 'REAL' : integers.has(column) ? 'INTEGER' : 'TEXT'}${['id', 'tenant_id', 'stat_date'].includes(column) ? ' NOT NULL' : ''}`).join(',\n');
export const splitTableDdl = (definition, staging = false) => `CREATE TABLE IF NOT EXISTS ${staging ? definition.staging : definition.table} (\n${staging ? '  batch_id TEXT NOT NULL,\n' : ''}${fields(definition)},\n  PRIMARY KEY (${staging ? 'batch_id, ' : ''}tenant_id, id)\n);`;
export const AI_DASHBOARD_SPLIT_PUBLIC_DDL = SPLIT_DETAILS.map(definition => `CREATE TABLE IF NOT EXISTS ${definition.table} (\n${fields(definition)},\n  PRIMARY KEY (tenant_id, id)\n);`).join('\n\n');
export const AI_DASHBOARD_SPLIT_SCHEMA_SQL = `${AI_DASHBOARD_SPLIT_PUBLIC_DDL}
${SPLIT_DETAILS.map(definition => `CREATE TABLE IF NOT EXISTS ${definition.staging} (
  batch_id TEXT NOT NULL,
${fields(definition)}, PRIMARY KEY (batch_id, tenant_id, id)
);`).join('\n')}
CREATE TABLE IF NOT EXISTS ai_dashboard_split_state (
  tenant_id INTEGER PRIMARY KEY, batch_id TEXT NOT NULL, schema_version INTEGER NOT NULL
);`;

// Same immediate privacy redaction as the integration table, not a second raw
// business-source collector. Drop this trigger before legacy report-table moves.
export const AI_DASHBOARD_SPLIT_REDACTION_SQL = `CREATE TRIGGER IF NOT EXISTS ai_dashboard_split_suppress_insert
AFTER INSERT ON ai_usage_suppressed_rows BEGIN
${SPLIT_DETAILS.filter(d => ['sql_generation', 'code_submission', 'skill_publication'].includes(d.key)).flatMap(definition => {
  const condition = definition.key === 'sql_generation'
    ? "NEW.dataset IN ('sql_generations','hook_records') AND sql_record_id=NEW.row_key"
    : definition.key === 'code_submission' ? "NEW.dataset='code_submissions' AND code_submission_id=NEW.row_key"
      : "NEW.dataset='skill_publications' AND skill_id IN (SELECT subject_id FROM ai_usage_report_rows WHERE tenant_id=NEW.tenant_id AND dataset=NEW.dataset AND row_key=NEW.row_key)";
  return [definition.table, definition.staging].map(table => `DELETE FROM ${table} WHERE tenant_id=NEW.tenant_id AND (${condition});`);
}).join('\n')}
END;`;
