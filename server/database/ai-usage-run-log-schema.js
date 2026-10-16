// One durable tenant outcome per actual scheduling window, including unstarted tenants.
export const AI_USAGE_RUN_LOG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ai_usage_run_logs (
  scheduled_for TEXT NOT NULL, tenant_id INTEGER NOT NULL,
  run_date TEXT NOT NULL, time_zone TEXT NOT NULL, window_ends_at TEXT NOT NULL,
  target_through TEXT NOT NULL, queue_position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', batch_id TEXT,
  worker_lease_token TEXT, batch_lease_token TEXT,
  incremental_enabled INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT, last_started_at TEXT, updated_at TEXT NOT NULL, finished_at TEXT,
  stage TEXT, error TEXT, reason TEXT,
  published_batches INTEGER NOT NULL DEFAULT 0,
  last_published_batch_id TEXT, last_published_at TEXT,
  PRIMARY KEY(scheduled_for,tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_run_logs_date ON ai_usage_run_logs(run_date,status,tenant_id);
CREATE VIEW IF NOT EXISTS ai_usage_run_log_status AS
SELECT l.*,CASE WHEN l.status='running' AND (
  l.window_ends_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  OR NOT EXISTS(SELECT 1 FROM ai_usage_batches b WHERE b.id=l.batch_id AND b.tenant_id=l.tenant_id
    AND b.status='running' AND b.lease_token=l.batch_lease_token
    AND b.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  OR NOT EXISTS(SELECT 1 FROM ai_usage_worker_lock w WHERE w.id=1
    AND w.lease_token=l.worker_lease_token AND w.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) THEN 'interrupted' ELSE l.status END AS effective_status
FROM ai_usage_run_logs l;
`;
