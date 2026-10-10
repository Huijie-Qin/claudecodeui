-- SQLite: five detail tables, schema version 4. Times: Asia/Shanghai; AI duration: fractional seconds.
CREATE TABLE IF NOT EXISTS ai_dashboard_ai_detail (
  id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  stat_date TEXT NOT NULL,
  occurred_at TEXT,
  user_id INTEGER,
  user_name TEXT,
  workspace_id INTEGER,
  workspace_name TEXT,
  ai_session_id TEXT,
  has_ai_interaction INTEGER,
  ai_active_duration_seconds REAL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS ai_dashboard_skill_publication_detail (
  id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  stat_date TEXT NOT NULL,
  occurred_at TEXT,
  workspace_id INTEGER,
  workspace_name TEXT,
  skill_id TEXT,
  skill_name TEXT,
  publisher_user_id INTEGER,
  publisher_user_name TEXT,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS ai_dashboard_skill_invocation_detail (
  id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  stat_date TEXT NOT NULL,
  occurred_at TEXT,
  user_id INTEGER,
  user_name TEXT,
  workspace_id INTEGER,
  workspace_name TEXT,
  skill_id TEXT,
  skill_name TEXT,
  publisher_user_id INTEGER,
  publisher_user_name TEXT,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS ai_dashboard_sql_generation_detail (
  id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  stat_date TEXT NOT NULL,
  occurred_at TEXT,
  user_id INTEGER,
  user_name TEXT,
  workspace_id INTEGER,
  workspace_name TEXT,
  sql_record_id TEXT,
  generated_sql_lines INTEGER,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS ai_dashboard_code_submission_detail (
  id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  stat_date TEXT NOT NULL,
  occurred_at TEXT,
  user_id INTEGER,
  user_name TEXT,
  workspace_id INTEGER,
  workspace_name TEXT,
  code_submission_id TEXT,
  repository_url TEXT,
  commit_sha TEXT,
  submitted_code_lines INTEGER,
  PRIMARY KEY (tenant_id, id)
);
