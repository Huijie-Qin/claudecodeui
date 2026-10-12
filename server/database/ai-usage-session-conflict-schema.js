// Source facts remain intact. These tables describe reversible exclusions from
// one published candidate and the lifetime of the underlying ownership issue.
export const AI_USAGE_SESSION_CONFLICT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ai_usage_session_issues (
  tenant_id INTEGER NOT NULL, session_key TEXT NOT NULL,
  workspace_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  provider TEXT NOT NULL, provider_session_id TEXT NOT NULL,
  reason TEXT NOT NULL, expected_json TEXT NOT NULL, actual_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  last_checked_batch_id TEXT NOT NULL, last_checked_at TEXT NOT NULL,
  last_check_conflict INTEGER NOT NULL CHECK(last_check_conflict IN (0,1)),
  resolved_at TEXT, resolved_batch_id TEXT,
  PRIMARY KEY(tenant_id,session_key)
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_session_issues_open
  ON ai_usage_session_issues(tenant_id,status,session_key);
CREATE TABLE IF NOT EXISTS ai_usage_batch_session_exclusions (
  batch_id TEXT NOT NULL, tenant_id INTEGER NOT NULL, session_key TEXT NOT NULL,
  reason TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(batch_id,tenant_id,session_key)
);
`;
