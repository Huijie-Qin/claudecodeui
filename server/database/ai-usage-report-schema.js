// The formal report contains only the current result, never historical versions.
export const REPORT_COLUMNS = 'tenant_id,dataset,row_key,stat_date,user_id,workspace_id,subject_id,session_key,occurred_at,value_json';
const COLUMNS_SQL = `tenant_id INTEGER NOT NULL, dataset TEXT NOT NULL, row_key TEXT NOT NULL,
  stat_date TEXT NOT NULL, user_id INTEGER, workspace_id INTEGER, subject_id TEXT, session_key TEXT,
  occurred_at TEXT, value_json TEXT NOT NULL`;
export const AI_USAGE_REPORT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ai_usage_report_rows (
  ${COLUMNS_SQL}, PRIMARY KEY(tenant_id,dataset,stat_date,row_key)
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_report_filter
  ON ai_usage_report_rows(tenant_id,stat_date,user_id,workspace_id,subject_id);
CREATE TABLE IF NOT EXISTS ai_usage_report_staging (
  batch_id TEXT NOT NULL, ${COLUMNS_SQL}, PRIMARY KEY(batch_id,dataset,stat_date,row_key)
);
`;

// A discarded work-in-progress may already have consumed dirty markers. Restore
// them from both sources and the current report (including deleted-source days).
export function requeueAiUsageReport(database, tenantId) {
  database.prepare(`INSERT INTO ai_usage_dirty_partitions(tenant_id,dataset,stat_date)
    SELECT tenant_id,dataset,stat_date FROM (
      SELECT tenant_id,dataset,stat_date FROM ai_usage_fact_rows WHERE tenant_id=@tenant
      UNION SELECT tenant_id,dataset,stat_date FROM ai_usage_report_rows WHERE tenant_id=@tenant
    ) WHERE dataset NOT IN ('skill_evidence','daily_active_users','hook_daily','active_users')
    ON CONFLICT(tenant_id,dataset,stat_date) DO UPDATE SET generation=generation+1`).run({ tenant: tenantId });
  database.prepare(`INSERT INTO ai_usage_dirty_activity_days(tenant_id,stat_date)
    SELECT DISTINCT tenant_id,stat_date FROM ai_usage_report_rows WHERE tenant_id=? AND dataset='active_users'
    ON CONFLICT(tenant_id,stat_date) DO UPDATE SET generation=generation+1`).run(tenantId);
}

export function migrateAiUsageReportRows(database) {
  if (!database.prepare('PRAGMA table_info(ai_usage_report_rows)').all().some((column) => column.name === 'partition_id')) return;
  database.transaction(() => {
    const now = new Date().toISOString();
    if (database.prepare('SELECT 1 FROM ai_usage_worker_lock WHERE lease_until>?').get(now)
      || database.prepare("SELECT 1 FROM ai_usage_batches WHERE status='running' AND lease_until>?").get(now)) {
      throw new Error('AI_USAGE_MIGRATION_WORKER_BUSY');
    }
    database.exec(`CREATE TABLE ai_usage_report_rows_current (
      ${COLUMNS_SQL}, PRIMARY KEY(tenant_id,dataset,stat_date,row_key)
    )`);
    // Copy only the published result actually displayed for each tenant. A failed
    // old batch and unreferenced copy-on-write blocks are not report data.
    database.exec(`INSERT INTO ai_usage_report_rows_current(${REPORT_COLUMNS})
      SELECT ${REPORT_COLUMNS.split(',').map((column) => `r.${column}`).join(',')}
      FROM ai_usage_report_rows r JOIN ai_usage_batch_partitions p
        ON p.partition_id=r.partition_id AND p.dataset=r.dataset AND p.stat_date=r.stat_date
      JOIN ai_usage_tenant_state s ON s.tenant_id=r.tenant_id AND s.active_batch_id=p.batch_id
      JOIN ai_usage_batches b ON b.id=p.batch_id AND b.tenant_id=r.tenant_id AND b.status='published'`);
    database.exec(`DROP TRIGGER IF EXISTS ai_dashboard_split_suppress_insert;
      DROP TRIGGER IF EXISTS ai_usage_integration_suppress_insert;
      DROP TABLE ai_usage_report_rows;
      ALTER TABLE ai_usage_report_rows_current RENAME TO ai_usage_report_rows;
      DROP TABLE ai_usage_batch_partitions;`);
    for (const { tenant_id: tenantId } of database.prepare("SELECT DISTINCT tenant_id FROM ai_usage_batches WHERE status IN ('running','paused','failed')").all()) {
      requeueAiUsageReport(database, tenantId);
    }
    database.exec(`DELETE FROM ai_usage_batch_files WHERE batch_id IN (SELECT id FROM ai_usage_batches WHERE status IN ('running','paused','failed'));
      DELETE FROM ai_usage_skill_work_items WHERE batch_id IN (SELECT id FROM ai_usage_batches WHERE status IN ('running','paused','failed'));
      UPDATE ai_usage_batches SET progress_json='{}',status='paused',lease_token=NULL,lease_until=NULL
      WHERE status IN ('running','paused','failed');`);
  }).immediate();
}
