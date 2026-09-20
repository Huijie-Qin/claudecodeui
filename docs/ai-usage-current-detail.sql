-- SQLite: formal current-result table. Do not DROP a populated table to apply
-- this DDL. Use migrateAiUsageSchema(), which preserves the active result.
CREATE TABLE IF NOT EXISTS ai_usage_report_rows (
  tenant_id INTEGER NOT NULL,
  dataset TEXT NOT NULL,
  row_key TEXT NOT NULL,
  stat_date TEXT NOT NULL,
  user_id INTEGER,
  workspace_id INTEGER,
  subject_id TEXT,
  session_key TEXT,
  occurred_at TEXT,
  value_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, dataset, stat_date, row_key)
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_report_filter
  ON ai_usage_report_rows (tenant_id, stat_date, user_id, workspace_id, subject_id);

-- Persistent work area: never queried by dashboard endpoints.
CREATE TABLE IF NOT EXISTS ai_usage_report_staging (
  batch_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  dataset TEXT NOT NULL,
  row_key TEXT NOT NULL,
  stat_date TEXT NOT NULL,
  user_id INTEGER,
  workspace_id INTEGER,
  subject_id TEXT,
  session_key TEXT,
  occurred_at TEXT,
  value_json TEXT NOT NULL,
  PRIMARY KEY (batch_id, dataset, stat_date, row_key)
);
