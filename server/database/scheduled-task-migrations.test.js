import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { APP_CONFIG_TABLE_SQL } from './schema.js';
import {
  EXISTING_SCHEDULED_TASKS_MERGE_MIGRATION_KEY,
  migrateExistingScheduledTasksToNew,
} from './scheduled-task-migrations.js';

test('tasks affected by the merge migration return to new-session mode only once', () => {
  const database = new Database(':memory:');
  database.exec(APP_CONFIG_TABLE_SQL);
  database.exec(`
    CREATE TABLE scheduled_session_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_mode TEXT NOT NULL DEFAULT 'new',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO scheduled_session_tasks (session_mode, created_at)
    VALUES
      ('merge', '2026-07-22 10:00:00'),
      ('merge', '2026-07-24 10:00:00');
  `);
  database.prepare(`
    INSERT INTO app_config (key, value, created_at)
    VALUES (?, 'completed', '2026-07-23 10:00:00')
  `).run(EXISTING_SCHEDULED_TASKS_MERGE_MIGRATION_KEY);

  const firstMigration = migrateExistingScheduledTasksToNew(database);
  assert.deepEqual(firstMigration, { applied: true, updatedTasks: 1 });
  assert.deepEqual(
    database.prepare('SELECT session_mode FROM scheduled_session_tasks ORDER BY id').all(),
    [{ session_mode: 'new' }, { session_mode: 'merge' }],
  );

  const secondMigration = migrateExistingScheduledTasksToNew(database);
  assert.deepEqual(secondMigration, { applied: false, updatedTasks: 0 });
});

test('databases that never ran the merge migration keep task modes unchanged', () => {
  const database = new Database(':memory:');
  database.exec(APP_CONFIG_TABLE_SQL);
  database.exec(`
    CREATE TABLE scheduled_session_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_mode TEXT NOT NULL DEFAULT 'new',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO scheduled_session_tasks (session_mode) VALUES ('merge');
  `);

  const migration = migrateExistingScheduledTasksToNew(database);
  assert.deepEqual(migration, { applied: true, updatedTasks: 0 });
  assert.equal(
    database.prepare('SELECT session_mode FROM scheduled_session_tasks WHERE id = 1').get().session_mode,
    'merge',
  );
});
