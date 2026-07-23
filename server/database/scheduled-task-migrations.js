export const EXISTING_SCHEDULED_TASKS_MERGE_MIGRATION_KEY =
  'migration_scheduled_tasks_existing_session_mode_merge_v1';

function hasTable(database, tableName) {
  return Boolean(database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName));
}

export function migrateExistingScheduledTasksToMerge(database) {
  if (!hasTable(database, 'app_config') || !hasTable(database, 'scheduled_session_tasks')) {
    return { applied: false, updatedTasks: 0 };
  }

  const completed = database
    .prepare('SELECT 1 FROM app_config WHERE key = ?')
    .get(EXISTING_SCHEDULED_TASKS_MERGE_MIGRATION_KEY);
  if (completed) {
    return { applied: false, updatedTasks: 0 };
  }

  return database.transaction(() => {
    const result = database
      .prepare("UPDATE scheduled_session_tasks SET session_mode = 'merge'")
      .run();
    database.prepare('INSERT INTO app_config (key, value) VALUES (?, ?)').run(
      EXISTING_SCHEDULED_TASKS_MERGE_MIGRATION_KEY,
      'completed',
    );
    return { applied: true, updatedTasks: result.changes };
  })();
}
