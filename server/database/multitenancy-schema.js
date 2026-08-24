import { APP_CONFIG_TABLE_SQL } from './schema.js';

const CLAUDE_ENV_DENY_RULES_TABLE_NAME = 'claude_env_deny_rules';
const CLAUDE_ENV_DENY_RULES_MIGRATION_TABLE_NAME = 'claude_env_deny_rules_match_type_migration';
export const CLAUDE_ENV_ALLOWLIST_DEFAULT_CLEANUP_MIGRATION_KEY = 'migration:claude_env_allowlist:v1-defaults-cleanup';
export const CLAUDE_ENV_PERSONAL_DENY_RETIREMENT_MIGRATION_KEY = 'migration:claude_env_deny_rules:v1-retire-personal';
const LEGACY_CLAUDE_ENV_ALLOWLIST_DEFAULTS = Object.freeze([
  Object.freeze({ name: 'ANTHROPIC_API_KEY', maxLength: 8192 }),
  Object.freeze({ name: 'ANTHROPIC_AUTH_TOKEN', maxLength: 8192 }),
  Object.freeze({ name: 'ANTHROPIC_BASE_URL', maxLength: 2048 }),
  Object.freeze({ name: 'ANTHROPIC_MODEL', maxLength: 256 }),
  Object.freeze({ name: 'DAS', maxLength: 1024 }),
]);

function buildClaudeEnvDenyRulesTableSql(tableName, { ifNotExists = false } = {}) {
  return `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('platform', 'user')),
  owner_user_id INTEGER,
  match_type TEXT NOT NULL CHECK (match_type IN ('exact', 'prefix', 'suffix', 'contains')),
  pattern TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by_user_id INTEGER,
  updated_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (owner_type = 'platform' AND owner_user_id IS NULL)
    OR
    (owner_type = 'user' AND owner_user_id IS NOT NULL)
  ),
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);`;
}

const CLAUDE_ENV_DENY_RULES_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_env_deny_rules_platform_unique_nocase
  ON claude_env_deny_rules(match_type, pattern COLLATE NOCASE)
  WHERE owner_type = 'platform';
CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_env_deny_rules_user_unique_nocase
  ON claude_env_deny_rules(owner_user_id, match_type, pattern COLLATE NOCASE)
  WHERE owner_type = 'user';
CREATE INDEX IF NOT EXISTS idx_claude_env_deny_rules_active_owner
  ON claude_env_deny_rules(owner_type, owner_user_id, enabled);`;

export function migrateClaudeEnvDenyRuleMatchTypes(database) {
  const table = database.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(CLAUDE_ENV_DENY_RULES_TABLE_NAME);
  if (!table?.sql) return { applied: false, migratedRows: 0 };

  const currentSql = String(table.sql).toLowerCase();
  if (currentSql.includes("'suffix'") && currentSql.includes("'contains'")) {
    return { applied: false, migratedRows: 0 };
  }

  const indexSql = database.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
    ORDER BY name ASC
  `).all(CLAUDE_ENV_DENY_RULES_TABLE_NAME).map((row) => row.sql);
  const foreignKeysWereEnabled = database.pragma('foreign_keys', { simple: true }) === 1;
  database.pragma('foreign_keys = OFF');
  try {
    const migrate = database.transaction(() => {
      database.exec(`DROP TABLE IF EXISTS ${CLAUDE_ENV_DENY_RULES_MIGRATION_TABLE_NAME}`);
      database.exec(buildClaudeEnvDenyRulesTableSql(CLAUDE_ENV_DENY_RULES_MIGRATION_TABLE_NAME));
      const result = database.prepare(`
        INSERT INTO ${CLAUDE_ENV_DENY_RULES_MIGRATION_TABLE_NAME} (
          id, owner_type, owner_user_id, match_type, pattern, reason, enabled,
          created_by_user_id, updated_by_user_id, created_at, updated_at
        )
        SELECT
          id, owner_type, owner_user_id, match_type, pattern, reason, enabled,
          created_by_user_id, updated_by_user_id, created_at, updated_at
        FROM ${CLAUDE_ENV_DENY_RULES_TABLE_NAME}
        ORDER BY id ASC
      `).run();
      database.exec(`
        DROP TABLE ${CLAUDE_ENV_DENY_RULES_TABLE_NAME};
        ALTER TABLE ${CLAUDE_ENV_DENY_RULES_MIGRATION_TABLE_NAME}
          RENAME TO ${CLAUDE_ENV_DENY_RULES_TABLE_NAME};
      `);
      for (const sql of indexSql) database.exec(sql);
      database.exec(CLAUDE_ENV_DENY_RULES_INDEX_SQL);

      const foreignKeyViolations = database.pragma(
        `foreign_key_check(${CLAUDE_ENV_DENY_RULES_TABLE_NAME})`,
      );
      if (foreignKeyViolations.length > 0) {
        throw new Error('Claude environment deny-rule migration failed foreign-key validation');
      }
      return Number(result.changes);
    });
    return { applied: true, migratedRows: migrate() };
  } finally {
    database.pragma(`foreign_keys = ${foreignKeysWereEnabled ? 'ON' : 'OFF'}`);
  }
}

export function migrateLegacyDefaultClaudeEnvAllowlist(database) {
  database.exec(APP_CONFIG_TABLE_SQL);
  const readMarker = database.prepare('SELECT value FROM app_config WHERE key = ?');
  const migrate = database.transaction(() => {
    if (readMarker.get(CLAUDE_ENV_ALLOWLIST_DEFAULT_CLEANUP_MIGRATION_KEY)) {
      return { applied: false, removedRows: 0 };
    }

    const rows = database.prepare(`
      SELECT name, max_length, enabled, updated_by_user_id
      FROM claude_env_allowlist
      ORDER BY name COLLATE BINARY ASC
    `).all();
    const hasUntouchedLegacyFingerprint = rows.length === LEGACY_CLAUDE_ENV_ALLOWLIST_DEFAULTS.length
      && rows.every((row, index) => {
        const expected = LEGACY_CLAUDE_ENV_ALLOWLIST_DEFAULTS[index];
        return row.name === expected.name
          && row.max_length === expected.maxLength
          && row.enabled === 1
          && row.updated_by_user_id === null;
      });
    const removedRows = hasUntouchedLegacyFingerprint
      ? Number(database.prepare('DELETE FROM claude_env_allowlist').run().changes)
      : 0;
    database.prepare(`
      INSERT INTO app_config (key, value)
      VALUES (?, ?)
    `).run(
      CLAUDE_ENV_ALLOWLIST_DEFAULT_CLEANUP_MIGRATION_KEY,
      hasUntouchedLegacyFingerprint ? 'removed' : 'preserved',
    );
    return { applied: true, removedRows };
  });
  return migrate();
}

export function migrateRetiredPersonalClaudeEnvDenyRules(database) {
  database.exec(APP_CONFIG_TABLE_SQL);
  const readMarker = database.prepare('SELECT value FROM app_config WHERE key = ?');
  const migrate = database.transaction(() => {
    if (readMarker.get(CLAUDE_ENV_PERSONAL_DENY_RETIREMENT_MIGRATION_KEY)) {
      return { applied: false, disabledRows: 0 };
    }

    const disabledRows = Number(database.prepare(`
      UPDATE claude_env_deny_rules
      SET enabled = 0
      WHERE owner_type = 'user' AND enabled = 1
    `).run().changes);
    database.prepare(`
      INSERT INTO app_config (key, value)
      VALUES (?, 'completed')
    `).run(CLAUDE_ENV_PERSONAL_DENY_RETIREMENT_MIGRATION_KEY);
    return { applied: true, disabledRows };
  });
  return migrate();
}

export const MULTITENANCY_SCHEMA_SQL = `PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  prod_code TEXT,
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

CREATE TABLE IF NOT EXISTS claude_env_variables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('tenant', 'user')),
  tenant_id INTEGER,
  user_id INTEGER,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0, 1)),
  created_by_user_id INTEGER,
  updated_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (scope_type = 'tenant' AND tenant_id IS NOT NULL AND user_id IS NULL)
    OR
    (scope_type = 'user' AND tenant_id IS NULL AND user_id IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_env_variables_tenant_name_nocase
  ON claude_env_variables(tenant_id, name COLLATE NOCASE)
  WHERE scope_type = 'tenant';
CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_env_variables_user_name_nocase
  ON claude_env_variables(user_id, name COLLATE NOCASE)
  WHERE scope_type = 'user';
CREATE INDEX IF NOT EXISTS idx_claude_env_variables_scope_updated
  ON claude_env_variables(scope_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS claude_env_allowlist (
  name TEXT PRIMARY KEY,
  max_length INTEGER NOT NULL CHECK (max_length > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_env_allowlist_name_nocase
  ON claude_env_allowlist(name COLLATE NOCASE);

${buildClaudeEnvDenyRulesTableSql(CLAUDE_ENV_DENY_RULES_TABLE_NAME, { ifNotExists: true })}
${CLAUDE_ENV_DENY_RULES_INDEX_SQL}

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
  tool_settings_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (workspace_id, preset_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (preset_id) REFERENCES mcp_server_presets(id) ON DELETE CASCADE,
  FOREIGN KEY (installed_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_mcp_preset_installs_preset
  ON workspace_mcp_preset_installs(preset_id, status);

CREATE TABLE IF NOT EXISTS user_workspace_mcp_tool_preferences (
  tenant_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  preset_id INTEGER NOT NULL,
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, user_id, preset_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (preset_id) REFERENCES mcp_server_presets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_workspace_mcp_tool_preferences_owner
  ON user_workspace_mcp_tool_preferences(tenant_id, workspace_id, user_id);

CREATE TABLE IF NOT EXISTS agent_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  agent_markdown TEXT NOT NULL DEFAULT '',
  guide_text TEXT NOT NULL DEFAULT '',
  tenant_ids_json TEXT NOT NULL DEFAULT '[]',
  skill_preset_refs_json TEXT NOT NULL DEFAULT '[]',
  mcp_preset_refs_json TEXT NOT NULL DEFAULT '[]',
  global_visible INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'disabled')),
  created_by_user_id INTEGER NOT NULL,
  updated_by_user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_templates_status
  ON agent_templates(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_agent_template_snapshots (
  workspace_id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL,
  template_name TEXT NOT NULL,
  template_updated_at DATETIME,
  agent_markdown TEXT NOT NULL DEFAULT '',
  guide_text TEXT NOT NULL DEFAULT '',
  skill_presets_json TEXT NOT NULL DEFAULT '[]',
  mcp_presets_json TEXT NOT NULL DEFAULT '[]',
  created_by_user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES agent_templates(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_agent_template_snapshots_template
  ON workspace_agent_template_snapshots(template_id);

-- Template-installed MCPs are snapshots. This marker keeps later preset edits
-- from being pushed into workspaces that were created from a template.
CREATE TABLE IF NOT EXISTS workspace_agent_template_mcp_installs (
  workspace_id INTEGER NOT NULL,
  preset_id INTEGER NOT NULL,
  template_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, preset_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (preset_id) REFERENCES mcp_server_presets(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES agent_templates(id) ON DELETE RESTRICT
);

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

CREATE TABLE IF NOT EXISTS tenant_skill_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'skill-market-api' CHECK (source_type IN ('skill-market-api')),
  skill_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  nsp_path TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  source_json TEXT,
  preinstall_scope TEXT NOT NULL DEFAULT 'none' CHECK (preinstall_scope IN ('none', 'all_workspaces')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'disabled')),
  last_validation_status TEXT,
  last_validation_error TEXT,
  last_validated_at DATETIME,
  created_by_user_id INTEGER NOT NULL,
  updated_by_user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_skill_presets_tenant_status
  ON tenant_skill_presets(tenant_id, status);

CREATE TABLE IF NOT EXISTS workspace_skill_preset_installs (
  workspace_id INTEGER NOT NULL,
  preset_id INTEGER NOT NULL,
  skill_name TEXT NOT NULL,
  installed_by_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'installed' CHECK (status IN ('installed', 'removed', 'failed')),
  installed_version INTEGER NOT NULL DEFAULT 0,
  installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT,
  PRIMARY KEY (workspace_id, preset_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (preset_id) REFERENCES tenant_skill_presets(id) ON DELETE CASCADE,
  FOREIGN KEY (installed_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_skill_preset_installs_preset
  ON workspace_skill_preset_installs(preset_id, status);

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
CREATE INDEX IF NOT EXISTS idx_session_index_created_at ON session_index(created_at);
CREATE INDEX IF NOT EXISTS idx_session_index_updated_at ON session_index(updated_at);
CREATE INDEX IF NOT EXISTS idx_session_index_user_activity ON session_index(user_id, status, updated_at);

CREATE TABLE IF NOT EXISTS user_session_favorites (
  user_id INTEGER NOT NULL,
  project_key TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'cursor', 'gemini')),
  provider_session_id TEXT NOT NULL,
  tenant_id INTEGER,
  workspace_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, project_key, provider, provider_session_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_session_favorites_scope
  ON user_session_favorites(user_id, project_key);

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
  session_mode TEXT NOT NULL DEFAULT 'new' CHECK (session_mode IN ('new', 'merge')),
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

CREATE TABLE IF NOT EXISTS scheduled_task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event TEXT NOT NULL,
  process_id INTEGER,
  task_id INTEGER,
  tenant_id INTEGER,
  workspace_id INTEGER,
  user_id INTEGER,
  provider TEXT,
  tick_id TEXT,
  run_id TEXT,
  details_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scheduled_task_logs_timestamp
  ON scheduled_task_logs(timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_logs_level_event
  ON scheduled_task_logs(level, event, id DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_logs_task
  ON scheduled_task_logs(task_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_logs_scope
  ON scheduled_task_logs(tenant_id, workspace_id, user_id, id DESC);
`;
