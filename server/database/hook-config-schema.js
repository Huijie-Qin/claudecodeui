export const HOOK_CONFIG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS hooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'disabled')),
  event_name TEXT NOT NULL,
  matcher_json TEXT NOT NULL DEFAULT '{}',
  gate_json TEXT NOT NULL DEFAULT '{"mode":"all","conditions":[]}',
  advanced_script_json TEXT,
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

CREATE TABLE IF NOT EXISTS hook_actions (
  id TEXT PRIMARY KEY,
  hook_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (hook_id) REFERENCES hooks(id) ON DELETE CASCADE,
  UNIQUE(hook_id, position)
);

CREATE INDEX IF NOT EXISTS idx_hook_actions_hook_position
  ON hook_actions(hook_id, position);

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
`;

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
      database.exec("ALTER TABLE hooks ADD COLUMN activation_scope TEXT NOT NULL DEFAULT 'manual' CHECK (activation_scope IN ('manual', 'all_users'))");
    }
    if (hasGlobalEnabled) {
      database.prepare(`
        UPDATE hooks
        SET activation_scope = CASE global_enabled WHEN 1 THEN 'all_users' ELSE 'manual' END
      `).run();
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
