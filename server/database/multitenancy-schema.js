export const MULTITENANCY_SCHEMA_SQL = `PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenants_code ON tenants(code);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

CREATE TABLE IF NOT EXISTS tenant_users (
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  permission TEXT NOT NULL DEFAULT 'view' CHECK (permission IN ('view', 'edit')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'pending')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_users_user_status ON tenant_users(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant_status ON tenant_users(tenant_id, status);

CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, owner_user_id, slug),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspaces_tenant_owner ON workspaces(tenant_id, owner_user_id);

CREATE TABLE IF NOT EXISTS workspace_acl (
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('view', 'edit')),
  created_by_user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_acl_user_permission ON workspace_acl(user_id, permission);

CREATE TABLE IF NOT EXISTS mcp_server_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT 'http' CHECK (transport IN ('http')),
  config_json TEXT NOT NULL,
  preinstall_scope TEXT NOT NULL DEFAULT 'none' CHECK (preinstall_scope IN ('none', 'all_workspaces')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'disabled')),
  docker_compatible INTEGER NOT NULL DEFAULT 0,
  last_test_status TEXT,
  last_test_error TEXT,
  last_tested_at DATETIME,
  tool_count INTEGER NOT NULL DEFAULT 0,
  tools_json TEXT,
  created_by_user_id INTEGER NOT NULL,
  updated_by_user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mcp_server_presets_tenant_status
  ON mcp_server_presets(tenant_id, status);

CREATE TABLE IF NOT EXISTS mcp_preset_helper_scripts (
  preset_id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  content TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  uploaded_by_user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (preset_id) REFERENCES mcp_server_presets(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mcp_preset_helper_scripts_tenant
  ON mcp_preset_helper_scripts(tenant_id);

CREATE TABLE IF NOT EXISTS workspace_mcp_preset_installs (
  workspace_id INTEGER NOT NULL,
  preset_id INTEGER NOT NULL,
  installed_by_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'installed' CHECK (status IN ('installed', 'removed')),
  installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_probe_status TEXT,
  last_probe_error TEXT,
  tool_count INTEGER NOT NULL DEFAULT 0,
  tools_json TEXT,
  PRIMARY KEY (workspace_id, preset_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (preset_id) REFERENCES mcp_server_presets(id) ON DELETE CASCADE,
  FOREIGN KEY (installed_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_mcp_preset_installs_preset
  ON workspace_mcp_preset_installs(preset_id, status);

CREATE TABLE IF NOT EXISTS workspace_skill_market_imports (
  workspace_id INTEGER NOT NULL,
  skill_name TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  nsp_path TEXT NOT NULL DEFAULT '',
  create_user_id TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'skill-market-api',
  imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, skill_name),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_skill_market_imports_remote
  ON workspace_skill_market_imports(remote_id);

CREATE TABLE IF NOT EXISTS tenant_sql_check_rules (
  tenant_id INTEGER NOT NULL,
  rule_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, rule_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_sql_check_rules_tenant_order
  ON tenant_sql_check_rules(tenant_id, sort_order);

CREATE TABLE IF NOT EXISTS user_sql_check_preferences (
  tenant_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  custom_enabled INTEGER NOT NULL DEFAULT 0 CHECK (custom_enabled IN (0, 1)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_sql_check_rules (
  tenant_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  rule_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, user_id, rule_id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES user_sql_check_preferences(workspace_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_sql_check_rules_owner_order
  ON user_sql_check_rules(workspace_id, user_id, sort_order);

CREATE TABLE IF NOT EXISTS tenant_join_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_join_requests_status_tenant ON tenant_join_requests(status, tenant_id);

CREATE TABLE IF NOT EXISTS session_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'cursor', 'gemini')),
  provider_session_id TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'aborted', 'failed', 'deleted')),
  metadata_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, provider_session_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_index_owner ON session_index(tenant_id, workspace_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_session_index_lookup ON session_index(provider, provider_session_id, user_id);

CREATE TABLE IF NOT EXISTS agent_session_runtime (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  runtime_id TEXT NOT NULL UNIQUE,
  tenant_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'cursor', 'gemini')),
  provider_session_id TEXT,
  container_name TEXT NOT NULL,
  image TEXT NOT NULL,
  workspace_host_path TEXT NOT NULL,
  runtime_home_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'idle', 'failed', 'deleted')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_session_runtime_provider_session
  ON agent_session_runtime(tenant_id, user_id, workspace_id, provider, provider_session_id)
  WHERE provider_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_session_runtime_owner
  ON agent_session_runtime(tenant_id, user_id, workspace_id, provider, status);
CREATE INDEX IF NOT EXISTS idx_agent_session_runtime_last_used
  ON agent_session_runtime(last_used_at);

CREATE TABLE IF NOT EXISTS agent_session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  runtime_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'cursor', 'gemini')),
  provider_session_id TEXT,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  role TEXT,
  content_text TEXT,
  normalized_json TEXT NOT NULL,
  provider_timestamp TEXT,
  sequence INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (runtime_id, message_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (runtime_id) REFERENCES agent_session_runtime(runtime_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_session_messages_provider_message
  ON agent_session_messages(tenant_id, user_id, workspace_id, provider, provider_session_id, message_id)
  WHERE provider_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_session_messages_history
  ON agent_session_messages(tenant_id, user_id, workspace_id, provider, provider_session_id, sequence);

CREATE TABLE IF NOT EXISTS scheduled_session_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'cursor', 'gemini')),
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_type TEXT NOT NULL DEFAULT 'interval' CHECK (schedule_type IN ('interval', 'cron')),
  schedule_cron TEXT,
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes >= 1),
  schedule_start_at TEXT,
  next_run_at TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  model TEXT,
  permission_mode TEXT,
  tools_settings_json TEXT,
  last_run_at TEXT,
  last_session_id TEXT,
  last_error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scheduled_session_tasks_due
  ON scheduled_session_tasks(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_session_tasks_owner
  ON scheduled_session_tasks(tenant_id, workspace_id, user_id, updated_at DESC);
`;
