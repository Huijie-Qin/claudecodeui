import crypto from 'node:crypto';

const LEGACY_SQL_CHECK_HOOK_NAME = 'SQL 响应指标记录';
const SQL_CHECK_HOOK_NAME = 'SQL Check 强制校验';
const SQL_LINE_RECORD_HOOK_NAME = 'SQL 行数记录';

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
  binding_controller TEXT NOT NULL DEFAULT 'admin' CHECK (binding_controller IN ('admin', 'sql_check')),
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

CREATE TABLE IF NOT EXISTS hook_tenant_bindings (
  hook_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  bound_by INTEGER,
  bound_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (hook_id, tenant_id),
  FOREIGN KEY (hook_id) REFERENCES hooks(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (bound_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_hook_tenant_bindings_tenant
  ON hook_tenant_bindings(tenant_id, hook_id);

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
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
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

export function migrateHookExecutionDiagnostics(database) {
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hook_executions'")
    .get();
  if (!table) return { addedStartedAtMs: false, addedCompletedAtMs: false };

  const columns = database.prepare('PRAGMA table_info(hook_executions)').all();
  const hasStartedAtMs = columns.some((column) => column.name === 'started_at_ms');
  const hasCompletedAtMs = columns.some((column) => column.name === 'completed_at_ms');
  const migrate = database.transaction(() => {
    if (!hasStartedAtMs) {
      database.exec('ALTER TABLE hook_executions ADD COLUMN started_at_ms INTEGER');
    }
    if (!hasCompletedAtMs) {
      database.exec('ALTER TABLE hook_executions ADD COLUMN completed_at_ms INTEGER');
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_hook_executions_started_ms
      ON hook_executions(started_at_ms DESC)
    `);
    database.prepare(`
      UPDATE hook_executions
      SET started_at_ms = CAST(strftime('%s', started_at) AS INTEGER) * 1000
      WHERE started_at_ms IS NULL AND started_at IS NOT NULL
    `).run();
    database.prepare(`
      UPDATE hook_executions
      SET completed_at_ms = started_at_ms + COALESCE(duration_ms, 0)
      WHERE completed_at_ms IS NULL AND completed_at IS NOT NULL AND started_at_ms IS NOT NULL
    `).run();
  });
  migrate();
  return {
    addedStartedAtMs: !hasStartedAtMs,
    addedCompletedAtMs: !hasCompletedAtMs,
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
  const hasBindingController = hookColumns.some((column) => column.name === 'binding_controller');
  const hasHookName = hookColumns.some((column) => column.name === 'name');
  const hasBindingSource = bindingColumns.some((column) => column.name === 'binding_source');
  const hookColumnNames = new Set(hookColumns.map((column) => column.name));
  const canSeparateSqlCheck = [
    'id',
    'name',
    'description',
    'status',
    'event_name',
    'matcher_json',
    'extension_logic_json',
    'post_actions_json',
    'claude_response_json',
    'version',
    'created_by',
    'updated_by',
    'published_at',
  ].every((column) => hookColumnNames.has(column));
  let separatedSqlCheckHooks = 0;

  const migrate = database.transaction(() => {
    if (!hasActivationScope) {
      database.exec(
        "ALTER TABLE hooks ADD COLUMN activation_scope TEXT NOT NULL DEFAULT 'manual' CHECK (activation_scope IN ('manual', 'all_users'))",
      );
    }
    if (!hasBindingController) {
      database.exec(
        "ALTER TABLE hooks ADD COLUMN binding_controller TEXT NOT NULL DEFAULT 'admin' CHECK (binding_controller IN ('admin', 'sql_check'))",
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
    if (hasHookName) {
      database.prepare(`
        UPDATE hooks
        SET binding_controller = 'sql_check', activation_scope = 'manual'
        WHERE name IN (?, ?)
      `).run(LEGACY_SQL_CHECK_HOOK_NAME, SQL_CHECK_HOOK_NAME);
    }
    if (canSeparateSqlCheck) {
      const legacyHooks = database.prepare(`
        SELECT *
        FROM hooks
        WHERE name = ? AND binding_controller = 'sql_check'
      `).all(LEGACY_SQL_CHECK_HOOK_NAME);
      for (const legacyHook of legacyHooks) {
        let postActions = [];
        try {
          const parsed = JSON.parse(legacyHook.post_actions_json || '[]');
          postActions = Array.isArray(parsed) ? parsed : [];
        } catch {
          postActions = [];
        }
        const recordActions = postActions
          .filter((action) => action?.type === 'write_record')
          .map((action, position) => ({ ...action, position }));
        const checkActions = postActions
          .filter((action) => action?.type !== 'write_record')
          .map((action, position) => ({ ...action, position }));

        let recordHook = database.prepare('SELECT id FROM hooks WHERE name = ? LIMIT 1').get(SQL_LINE_RECORD_HOOK_NAME);
        if (!recordHook && recordActions.length > 0) {
          const recordHookId = crypto.randomUUID();
          database.prepare(`
            INSERT INTO hooks (
              id, name, description, status, event_name, matcher_json,
              extension_logic_json, post_actions_json, claude_response_json,
              version, activation_scope, binding_controller,
              created_by, updated_by, published_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'admin', ?, ?, ?)
          `).run(
            recordHookId,
            SQL_LINE_RECORD_HOOK_NAME,
            '检测模型输出中的 SQL，并将 SQL 行数、语句数等指标写入 Hook 数据记录。',
            legacyHook.status,
            legacyHook.event_name,
            legacyHook.matcher_json,
            legacyHook.extension_logic_json,
            JSON.stringify(recordActions),
            legacyHook.claude_response_json,
            legacyHook.version,
            legacyHook.created_by,
            legacyHook.updated_by,
            legacyHook.published_at,
          );
          recordHook = { id: recordHookId };
        }
        if (recordHook && recordActions.length > 0) {
          database.prepare(`
            INSERT OR IGNORE INTO user_hook_bindings (user_id, hook_id, bound_by)
            SELECT user_id, ?, bound_by
            FROM user_hook_bindings
            WHERE hook_id = ?
          `).run(recordHook.id, legacyHook.id);
        }
        database.prepare(`
          UPDATE hooks
          SET name = ?,
              description = ?,
              post_actions_json = ?
          WHERE id = ?
        `).run(
          SQL_CHECK_HOOK_NAME,
          '检测模型输出中的 SQL，并调用 SQL Check MCP Tool 执行强制语法校验。',
          JSON.stringify(checkActions),
          legacyHook.id,
        );
        separatedSqlCheckHooks += 1;
      }
    }
    database.prepare(`
      UPDATE hooks
      SET activation_scope = 'manual'
      WHERE binding_controller = 'sql_check'
    `).run();
  });
  migrate();

  const hasTenantBindings = Boolean(database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hook_tenant_bindings'")
    .get());
  if (hasTenantBindings) {
    database.prepare(`
      DELETE FROM hook_tenant_bindings
      WHERE hook_id IN (
        SELECT id FROM hooks WHERE binding_controller = 'sql_check'
      )
    `).run();
  }

  const hasDataRecords = Boolean(database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hook_data_records'")
    .get());
  if (hasDataRecords && hasHookName) {
    database.prepare(`
      UPDATE hook_data_records
      SET hook_id = (
        SELECT id FROM hooks WHERE name = ? ORDER BY updated_at DESC LIMIT 1
      )
      WHERE record_type = 'sql_response_metrics'
        AND hook_id IN (
          SELECT id FROM hooks WHERE name = ?
        )
        AND EXISTS (
          SELECT 1 FROM hooks WHERE name = ?
        )
    `).run(SQL_LINE_RECORD_HOOK_NAME, SQL_CHECK_HOOK_NAME, SQL_LINE_RECORD_HOOK_NAME);
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_hooks_activation_scope
      ON hooks(activation_scope, status);

  `);

  return {
    migratedGlobalEnabled: hasGlobalEnabled,
    addedActivationScope: !hasActivationScope,
    addedBindingController: !hasBindingController,
    removedBindingSource: hasBindingSource,
    separatedSqlCheckHooks,
  };
}
