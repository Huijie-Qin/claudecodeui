function getColumnNames(database, tableName) {
  return database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((col) => col.name);
}

export function runMultitenancyMigrationsForDatabase(database) {
  const mcpPresetColumns = getColumnNames(database, 'mcp_server_presets');

  if (!mcpPresetColumns.includes('preinstall_scope')) {
    console.log('Running migration: Adding mcp_server_presets.preinstall_scope column');
    database.exec("ALTER TABLE mcp_server_presets ADD COLUMN preinstall_scope TEXT NOT NULL DEFAULT 'none'");
  }

  const scheduledTaskColumns = getColumnNames(database, 'scheduled_session_tasks');

  if (!scheduledTaskColumns.includes('schedule_type')) {
    console.log('Running migration: Adding scheduled_session_tasks.schedule_type column');
    database.exec("ALTER TABLE scheduled_session_tasks ADD COLUMN schedule_type TEXT NOT NULL DEFAULT 'interval'");
  }

  if (!scheduledTaskColumns.includes('schedule_cron')) {
    console.log('Running migration: Adding scheduled_session_tasks.schedule_cron column');
    database.exec('ALTER TABLE scheduled_session_tasks ADD COLUMN schedule_cron TEXT');
  }

  const sqlCheckPreferenceColumns = getColumnNames(database, 'user_sql_check_preferences');

  if (!sqlCheckPreferenceColumns.includes('custom_enabled')) {
    console.log('Running migration: Adding user_sql_check_preferences.custom_enabled column');
    database.exec('ALTER TABLE user_sql_check_preferences ADD COLUMN custom_enabled INTEGER NOT NULL DEFAULT 0');
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_mcp_server_presets_tenant_preinstall
      ON mcp_server_presets(tenant_id, preinstall_scope, status)
  `);
}
