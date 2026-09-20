export function migrateAiUsageExportSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_usage_export_jobs (
    id TEXT PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('self', 'tenant')),
    batch_id TEXT NOT NULL REFERENCES ai_usage_batches(id) ON DELETE RESTRICT,
    dataset TEXT NOT NULL,
    filters_json TEXT NOT NULL,
    data_revision INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    lease_token TEXT,
    lease_until TEXT,
    filename TEXT,
    mime_type TEXT,
    size_bytes INTEGER,
    error_code TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_exports_owner ON ai_usage_export_jobs(tenant_id, user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ai_usage_exports_queue ON ai_usage_export_jobs(status, lease_until, created_at);`);
  if (!db.prepare('PRAGMA table_info(ai_usage_export_jobs)').all().some((column) => column.name === 'data_revision')) {
    db.exec('ALTER TABLE ai_usage_export_jobs ADD COLUMN data_revision INTEGER NOT NULL DEFAULT 0');
  }
}
