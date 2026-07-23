import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { APP_CONFIG_TABLE_SQL } from './schema.js';
import { migrateExistingScheduledTasksToMerge } from './scheduled-task-migrations.js';

test('existing scheduled tasks migrate to merge mode only once', () => {
  const database = new Database(':memory:');
  database.exec(APP_CONFIG_TABLE_SQL);
  database.exec(`
    CREATE TABLE scheduled_session_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_mode TEXT NOT NULL DEFAULT 'new'
    );
    INSERT INTO scheduled_session_tasks (session_mode) VALUES ('new'), ('merge');
  `);

  const firstMigration = migrateExistingScheduledTasksToMerge(database);
  assert.deepEqual(firstMigration, { applied: true, updatedTasks: 2 });
  assert.deepEqual(
    database.prepare('SELECT session_mode FROM scheduled_session_tasks ORDER BY id').all(),
    [{ session_mode: 'merge' }, { session_mode: 'merge' }],
  );

  database.prepare("INSERT INTO scheduled_session_tasks (session_mode) VALUES ('new')").run();
  const secondMigration = migrateExistingScheduledTasksToMerge(database);
  assert.deepEqual(secondMigration, { applied: false, updatedTasks: 0 });
  assert.equal(
    database.prepare('SELECT session_mode FROM scheduled_session_tasks WHERE id = 3').get().session_mode,
    'new',
  );
});
