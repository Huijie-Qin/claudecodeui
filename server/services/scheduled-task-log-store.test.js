import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { DATABASE_SCHEMA_SQL } from '../database/schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';

import { createScheduledTaskLogStore } from './scheduled-task-log-store.js';

function createDatabase() {
  const database = new Database(':memory:');
  database.exec(DATABASE_SCHEMA_SQL);
  database.exec(MULTITENANCY_SCHEMA_SQL);
  database.prepare('INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)').run('admin-log-user', 'test');
  database.prepare('INSERT INTO tenants (id, code, name) VALUES (1, ?, ?)').run('tenant-a', 'Tenant A');
  database.prepare(`
    INSERT INTO workspaces (id, tenant_id, owner_user_id, slug, display_name, path)
    VALUES (1, 1, 1, 'workspace-a', 'Workspace A', '/tmp/workspace-a')
  `).run();
  database.prepare(`
    INSERT INTO scheduled_session_tasks (
      id, tenant_id, workspace_id, user_id, provider, name, prompt,
      interval_minutes, next_run_at
    )
    VALUES (1, 1, 1, 1, 'claude', 'Daily report', 'private prompt', 60, '2026-08-20T07:00:00.000Z')
  `).run();
  return database;
}

function logEntry(overrides = {}) {
  return {
    timestamp: '2026-08-20T06:00:00.000Z',
    level: 'info',
    event: 'task_succeeded',
    processId: 42,
    taskId: 1,
    tenantId: 1,
    workspaceId: 1,
    userId: 1,
    provider: 'claude',
    tickId: 'tick-1',
    runId: 'run-1',
    durationMs: 25,
    ...overrides,
  };
}

test('scheduled task log store persists, joins and filters admin log rows', () => {
  const database = createDatabase();
  const store = createScheduledTaskLogStore({
    database,
    now: () => new Date('2026-08-20T06:30:00.000Z'),
    cleanupEvery: 100,
  });
  store.append(logEntry());
  store.append(logEntry({
    timestamp: '2026-08-20T06:05:00.000Z',
    level: 'error',
    event: 'task_failed',
    runId: 'run-2',
    error: { message: 'Synthetic failure' },
  }));

  const result = store.list({ level: 'error', q: 'Synthetic', limit: 25 });

  assert.equal(result.total, 1);
  assert.equal(result.rows[0].event, 'task_failed');
  assert.equal(result.rows[0].taskName, 'Daily report');
  assert.equal(result.rows[0].tenantCode, 'tenant-a');
  assert.equal(result.rows[0].username, 'admin-log-user');
  assert.equal(result.rows[0].workspaceName, 'Workspace A');
  assert.equal(result.rows[0].details.error.message, 'Synthetic failure');
  assert.deepEqual(result.summary, { total: 1, debug: 0, info: 0, warn: 0, error: 1 });
  assert.deepEqual(result.retention, { days: 30, maxRows: 10_000 });
  database.close();
});

test('scheduled task log store enforces age and row-count retention', () => {
  const database = createDatabase();
  const store = createScheduledTaskLogStore({
    database,
    retentionDays: 2,
    maxRows: 100,
    cleanupEvery: 10_000,
    now: () => new Date('2026-08-20T06:30:00.000Z'),
  });
  store.append(logEntry({ timestamp: '2026-08-01T00:00:00.000Z', runId: 'expired' }));
  for (let index = 0; index < 105; index += 1) {
    store.append(logEntry({
      timestamp: `2026-08-20T06:${String(index % 60).padStart(2, '0')}:00.000Z`,
      runId: `run-${index}`,
    }));
  }

  const cleanup = store.cleanup();
  const count = database.prepare('SELECT COUNT(*) AS count FROM scheduled_task_logs').get().count;

  assert.equal(cleanup.expired, 0);
  assert.equal(cleanup.overflow, 5);
  assert.equal(count, 100);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM scheduled_task_logs WHERE run_id = 'expired'").get().count, 0);
  database.close();
});

test('scheduled task log store rejects invalid admin filters', () => {
  const database = createDatabase();
  const store = createScheduledTaskLogStore({ database });

  assert.throws(() => store.list({ level: 'fatal' }), /Invalid level/);
  assert.throws(() => store.list({ limit: 500 }), /limit must be an integer/);
  assert.throws(() => store.list({ from: 'invalid' }), /from must be a valid date/);
  database.close();
});
