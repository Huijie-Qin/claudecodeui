// Public projection: fixed scalar columns, no dataset/JSON/version partition.
export const INTEGRATION_COLUMNS = [
  'id', 'tenant_id', 'stat_date', 'occurred_at', 'user_id', 'user_name', 'workspace_id', 'workspace_name',
  'ai_session_id', 'has_ai_interaction', 'ai_active_duration_ms', 'skill_id', 'skill_name',
  'publisher_user_id', 'publisher_user_name', 'skill_publish_count', 'skill_call_count',
  'sql_record_id', 'generated_sql_lines', 'code_submission_id', 'repository_url', 'commit_sha',
  'submitted_code_lines', 'refreshed_at',
];
const columns = INTEGRATION_COLUMNS.map(column => `${column} ${[
  'tenant_id', 'user_id', 'workspace_id', 'has_ai_interaction', 'ai_active_duration_ms',
  'publisher_user_id', 'skill_publish_count', 'skill_call_count', 'generated_sql_lines', 'submitted_code_lines',
].includes(column) ? 'INTEGER' : 'TEXT'}${['id', 'tenant_id', 'stat_date', 'refreshed_at'].includes(column) ? ' NOT NULL' : ''}`).join(',');

export const AI_DASHBOARD_INTEGRATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ai_dashboard_integration_detail (
  ${columns}, PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS ai_dashboard_integration_staging (
  batch_id TEXT NOT NULL, ${columns}, PRIMARY KEY(batch_id,tenant_id,id)
);`;

// Rename in place: preserve every identifier/value and any prepared candidate.
// All callers run schema migration before starting a statistics Worker.
export function migrateIntegrationId(database) {
  database.transaction(() => {
    const targets = ['ai_dashboard_integration_detail', 'ai_dashboard_integration_staging'].filter(table => {
      const columns = database.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
      if (columns.includes('id') && columns.includes('detail_id')) throw new Error('AI_INTEGRATION_AMBIGUOUS_ID_COLUMNS');
      return columns.includes('detail_id');
    });
    if (!targets.length) return;
    const now = new Date().toISOString();
    if (database.prepare('SELECT 1 FROM ai_usage_worker_lock WHERE lease_until>?').get(now)
      || database.prepare("SELECT 1 FROM ai_usage_batches WHERE status='running' AND lease_until>?").get(now)) {
      throw new Error('AI_INTEGRATION_MIGRATION_WORKER_ACTIVE');
    }
    for (const table of targets) database.exec(`ALTER TABLE ${table} RENAME COLUMN detail_id TO id`);
  }).immediate();
}
