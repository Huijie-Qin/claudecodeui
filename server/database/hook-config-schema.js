export const HOOK_CONFIG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS hooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'disabled')),
  event_name TEXT NOT NULL,
  matcher_json TEXT NOT NULL DEFAULT '{}',
  extension_logic_json TEXT NOT NULL DEFAULT 'null',
  post_actions_json TEXT NOT NULL DEFAULT '[]',
  claude_response_json TEXT NOT NULL DEFAULT '{"bindings":{}}',
  version INTEGER NOT NULL DEFAULT 0,
  activation_scope TEXT NOT NULL DEFAULT 'manual' CHECK (activation_scope IN ('manual', 'all_users')),
  created_by INTEGER NOT NULL,
  updated_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_hooks_status_updated
  ON hooks(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_hooks_event_name
  ON hooks(event_name);

CREATE TABLE IF NOT EXISTS user_hook_bindings (
  user_id INTEGER NOT NULL,
  hook_id TEXT NOT NULL,
  bound_by INTEGER,
  bound_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, hook_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (hook_id) REFERENCES hooks(id) ON DELETE CASCADE,
  FOREIGN KEY (bound_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_user_hook_bindings_hook
  ON user_hook_bindings(hook_id, user_id);

CREATE TABLE IF NOT EXISTS hook_executions (
  id TEXT PRIMARY KEY,
  hook_id TEXT NOT NULL,
  hook_version INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER,
  tenant_id INTEGER,
  workspace_id INTEGER,
  session_id TEXT,
  event_name TEXT NOT NULL,
  tool_use_id TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  input_json TEXT NOT NULL DEFAULT '{}',
  script_output_json TEXT,
  actions_json TEXT NOT NULL DEFAULT '{}',
  response_json TEXT NOT NULL DEFAULT '{}',
  logs_json TEXT NOT NULL DEFAULT '[]',
  error_message TEXT,
  duration_ms INTEGER,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (hook_id) REFERENCES hooks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_hook_executions_hook_started
  ON hook_executions(hook_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_hook_executions_user_started
  ON hook_executions(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_hook_executions_session
  ON hook_executions(session_id, started_at DESC);

CREATE TABLE IF NOT EXISTS hook_data_records (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  hook_id TEXT NOT NULL,
  user_id INTEGER,
  tenant_id INTEGER,
  workspace_id INTEGER,
  session_id TEXT,
  record_type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (execution_id) REFERENCES hook_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (hook_id) REFERENCES hooks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_hook_data_records_hook_created
  ON hook_data_records(hook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hook_data_records_type_created
  ON hook_data_records(record_type, created_at DESC);
`;

export function migrateHookConfigurationModel(database) {
  const columns = database.prepare('PRAGMA table_info(hooks)').all();
  const hasExtensionLogic = columns.some((column) => column.name === 'extension_logic_json');
  const hasPostActions = columns.some((column) => column.name === 'post_actions_json');
  const hasClaudeResponse = columns.some((column) => column.name === 'claude_response_json');
  const hasGate = columns.some((column) => column.name === 'gate_json');
  const hasAdvancedScript = columns.some((column) => column.name === 'advanced_script_json');
  const migrate = database.transaction(() => {
    if (!hasExtensionLogic) {
      database.exec(`
        ALTER TABLE hooks
        ADD COLUMN extension_logic_json TEXT NOT NULL
        DEFAULT 'null'
      `);
    }
    if (!hasPostActions) {
      database.exec(`
        ALTER TABLE hooks
        ADD COLUMN post_actions_json TEXT NOT NULL DEFAULT '[]'
      `);
    }
    if (!hasClaudeResponse) {
      database.exec(`
        ALTER TABLE hooks
        ADD COLUMN claude_response_json TEXT NOT NULL DEFAULT '{"bindings":{}}'
      `);
    }
    database.exec('DROP TABLE IF EXISTS hook_actions');
    if (hasGate) database.exec('ALTER TABLE hooks DROP COLUMN gate_json');
    if (hasAdvancedScript) database.exec('ALTER TABLE hooks DROP COLUMN advanced_script_json');
  });
  migrate();
  return {
    addedExtensionLogic: !hasExtensionLogic,
    addedPostActions: !hasPostActions,
    addedClaudeResponse: !hasClaudeResponse,
    removedGate: hasGate,
    removedAdvancedScript: hasAdvancedScript,
  };
}

export function migrateHookActivationModel(database) {
  database.exec(`
    DROP TRIGGER IF EXISTS trg_bind_active_hooks_after_user_insert;
    DROP TRIGGER IF EXISTS trg_bind_all_user_hooks_after_user_insert;
    DROP INDEX IF EXISTS idx_hooks_global_enabled;
  `);
  const hookColumns = database.prepare('PRAGMA table_info(hooks)').all();
  const bindingColumns = database.prepare('PRAGMA table_info(user_hook_bindings)').all();
  const hasGlobalEnabled = hookColumns.some((column) => column.name === 'global_enabled');
  const hasActivationScope = hookColumns.some((column) => column.name === 'activation_scope');
  const hasBindingSource = bindingColumns.some((column) => column.name === 'binding_source');

  const migrate = database.transaction(() => {
    if (!hasActivationScope) {
      database.exec(
        "ALTER TABLE hooks ADD COLUMN activation_scope TEXT NOT NULL DEFAULT 'manual' CHECK (activation_scope IN ('manual', 'all_users'))",
      );
    }
    if (hasGlobalEnabled) {
      database
        .prepare(
          `
        UPDATE hooks
        SET activation_scope = CASE global_enabled WHEN 1 THEN 'all_users' ELSE 'manual' END
      `,
        )
        .run();
      if (!hasBindingSource) {
        database.prepare('DELETE FROM user_hook_bindings').run();
      }
      database.exec('ALTER TABLE hooks DROP COLUMN global_enabled');
    }
    if (hasBindingSource) {
      database.prepare("DELETE FROM user_hook_bindings WHERE binding_source = 'admin_global'").run();
      database.exec('ALTER TABLE user_hook_bindings DROP COLUMN binding_source');
    }
  });
  migrate();

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_hooks_activation_scope
      ON hooks(activation_scope, status);

  `);

  return {
    migratedGlobalEnabled: hasGlobalEnabled,
    addedActivationScope: !hasActivationScope,
    removedBindingSource: hasBindingSource,
  };
}
