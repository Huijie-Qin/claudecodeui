export const APP_CONFIG_TABLE_SQL = `CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`;

export const USER_NOTIFICATION_PREFERENCES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id INTEGER PRIMARY KEY,
  preferences_json TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);`;

export const VAPID_KEYS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS vapid_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`;

export const PUSH_SUBSCRIPTIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);`;

export const USER_INVITATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS user_invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_user_id INTEGER NOT NULL,
  expires_at DATETIME NOT NULL,
  accepted_at DATETIME,
  revoked_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);`;

export const USER_INVITATIONS_TOKEN_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_user_invitations_token_hash ON user_invitations(token_hash);`;
export const USER_INVITATIONS_USER_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_user_invitations_user_status ON user_invitations(user_id, accepted_at, revoked_at);`;

export const USER_PASSWORD_RESETS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS user_password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_user_id INTEGER NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  revoked_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);`;

export const USER_PASSWORD_RESETS_TOKEN_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_user_password_resets_token_hash ON user_password_resets(token_hash);`;
export const USER_PASSWORD_RESETS_USER_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_user_password_resets_user_status ON user_password_resets(user_id, used_at, revoked_at);`;

export const SESSION_NAMES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS session_names (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude',
  custom_name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, provider)
);`;

export const SESSION_NAMES_LOOKUP_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_session_names_lookup ON session_names(session_id, provider);`;

export const CODEHUB_REPOSITORIES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS codehub_repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  target_repository TEXT NOT NULL,
  private_repository TEXT NOT NULL,
  token_encrypted TEXT NOT NULL,
  last_test_status TEXT,
  last_test_error TEXT,
  last_tested_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, target_repository, private_repository),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);`;

export const CODEHUB_REPOSITORIES_USER_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_codehub_repositories_user
  ON codehub_repositories(user_id, updated_at);`;

export const CODEHUB_WORKSPACE_REPOSITORIES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS codehub_workspace_repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  repo_relative_path TEXT NOT NULL,
  repository_url TEXT NOT NULL,
  project_id INTEGER,
  public_repository_url TEXT,
  public_project_id INTEGER,
  codehub_host TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, repo_relative_path)
);`;

export const CODEHUB_WORKSPACE_REPOSITORIES_LOOKUP_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_codehub_workspace_repositories_lookup
  ON codehub_workspace_repositories(workspace_id, repo_relative_path);`;

export const AI_MR_SUBMISSIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ai_mr_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  repo_relative_path TEXT NOT NULL,
  repository_url TEXT NOT NULL,
  project_id INTEGER,
  public_repository_url TEXT,
  public_project_id INTEGER,
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  mr_id TEXT,
  mr_iid TEXT,
  mr_project_id INTEGER,
  mr_url TEXT,
  ticket_no TEXT NOT NULL,
  description TEXT,
  binary_source TEXT,
  mr_title TEXT,
  additions INTEGER DEFAULT 0,
  deletions INTEGER DEFAULT 0,
  files_changed INTEGER DEFAULT 0,
  binary_files_changed INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  mr_state TEXT,
  mr_created_at DATETIME,
  mr_updated_at DATETIME,
  merged_at DATETIME,
  closed_at DATETIME,
  expires_at DATETIME NOT NULL,
  last_checked_at DATETIME,
  next_check_at DATETIME,
  last_error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`;

export const AI_MR_SUBMISSIONS_POLL_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_ai_mr_submissions_poll
  ON ai_mr_submissions(status, next_check_at, expires_at);`;

export const AI_MR_SUBMISSIONS_TENANT_STATS_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_ai_mr_submissions_stats_tenant
  ON ai_mr_submissions(status, tenant_id, merged_at);`;

export const AI_MR_SUBMISSIONS_USER_STATS_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_ai_mr_submissions_stats_user
  ON ai_mr_submissions(status, tenant_id, user_id, merged_at);`;

export const AI_MR_SUBMISSION_FILES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ai_mr_submission_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL,
  additions INTEGER DEFAULT 0,
  deletions INTEGER DEFAULT 0,
  is_binary BOOLEAN DEFAULT 0,
  FOREIGN KEY (submission_id) REFERENCES ai_mr_submissions(id) ON DELETE CASCADE
);`;

export const AI_MR_SUBMISSION_FILES_SUBMISSION_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_ai_mr_submission_files_submission
  ON ai_mr_submission_files(submission_id);`;

export const DATABASE_SCHEMA_SQL = `PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME,
  is_active BOOLEAN DEFAULT 1,
  is_system_admin BOOLEAN DEFAULT 0,
  git_name TEXT,
  git_email TEXT,
  git_token TEXT,
  has_completed_onboarding BOOLEAN DEFAULT 0,
  env TEXT DEFAULT '{}',
  env_visibility TEXT DEFAULT '{}',
  env_encrypted TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

${USER_INVITATIONS_TABLE_SQL}

${USER_INVITATIONS_TOKEN_INDEX_SQL}

${USER_INVITATIONS_USER_INDEX_SQL}

${USER_PASSWORD_RESETS_TABLE_SQL}

${USER_PASSWORD_RESETS_TOKEN_INDEX_SQL}

${USER_PASSWORD_RESETS_USER_INDEX_SQL}

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  key_name TEXT NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used DATETIME,
  is_active BOOLEAN DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

CREATE TABLE IF NOT EXISTS user_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  credential_name TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  credential_value TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credentials_type ON user_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_user_credentials_active ON user_credentials(is_active);

${USER_NOTIFICATION_PREFERENCES_TABLE_SQL}

${VAPID_KEYS_TABLE_SQL}

${PUSH_SUBSCRIPTIONS_TABLE_SQL}

${SESSION_NAMES_TABLE_SQL}

${SESSION_NAMES_LOOKUP_INDEX_SQL}

${CODEHUB_REPOSITORIES_TABLE_SQL}

${CODEHUB_REPOSITORIES_USER_INDEX_SQL}

${CODEHUB_WORKSPACE_REPOSITORIES_TABLE_SQL}

${CODEHUB_WORKSPACE_REPOSITORIES_LOOKUP_INDEX_SQL}

${AI_MR_SUBMISSIONS_TABLE_SQL}

${AI_MR_SUBMISSIONS_POLL_INDEX_SQL}

${AI_MR_SUBMISSIONS_TENANT_STATS_INDEX_SQL}

${AI_MR_SUBMISSIONS_USER_STATS_INDEX_SQL}

${AI_MR_SUBMISSION_FILES_TABLE_SQL}

${AI_MR_SUBMISSION_FILES_SUBMISSION_INDEX_SQL}

${APP_CONFIG_TABLE_SQL}
`;
