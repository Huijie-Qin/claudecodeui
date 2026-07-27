import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  buildAdminAnalyticsSummary,
  buildAdminAnalyticsUsers,
} from './admin-analytics.js';

function createAnalyticsDatabase() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      created_at DATETIME NOT NULL,
      last_login DATETIME,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE tenant_users (
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE session_index (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      workspace_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    );
  `);

  const insertUser = database.prepare(`
    INSERT INTO users (id, username, created_at, last_login, is_active)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertUser.run(1, 'alice', '2026-07-26 16:30:00', '2026-07-27 01:00:00', 1);
  insertUser.run(2, 'bob', '2026-07-20 04:00:00', null, 1);
  insertUser.run(3, 'carol', '2026-06-01 04:00:00', null, 0);

  database.prepare('INSERT INTO tenants (id, code, name, status) VALUES (?, ?, ?, ?)').run(
    1,
    'alpha',
    'Alpha',
    'active',
  );
  database.prepare('INSERT INTO tenants (id, code, name, status) VALUES (?, ?, ?, ?)').run(
    2,
    'beta',
    'Beta',
    'active',
  );
  const insertMembership = database.prepare(`
    INSERT INTO tenant_users (tenant_id, user_id, status)
    VALUES (?, ?, ?)
  `);
  insertMembership.run(1, 1, 'active');
  insertMembership.run(2, 2, 'active');
  insertMembership.run(2, 3, 'active');

  const insertSession = database.prepare(`
    INSERT INTO session_index (
      id,
      tenant_id,
      workspace_id,
      user_id,
      provider,
      provider_session_id,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, 'claude', ?, ?, ?, ?)
  `);
  insertSession.run(1, 1, 1, 1, 'session-1', 'completed', '2026-07-26 17:00:00', '2026-07-27 03:00:00');
  insertSession.run(2, 1, 1, 1, 'session-2', 'completed', '2026-07-01 04:00:00', '2026-07-20 04:00:00');
  insertSession.run(3, 2, 2, 2, 'session-3', 'completed', '2026-06-10 04:00:00', '2026-07-10 04:00:00');
  insertSession.run(4, 2, 2, 3, 'session-4', 'failed', '2026-05-10 04:00:00', '2026-06-10 04:00:00');

  return database;
}

test('summary uses only user, tenant, and session index data with Shanghai day boundaries', () => {
  const database = createAnalyticsDatabase();
  const summary = buildAdminAnalyticsSummary({
    database,
    rangeDays: 30,
    now: new Date('2026-07-27T04:00:00.000Z'),
  });

  assert.deepEqual(summary.metrics, {
    totalUsers: 3,
    activeUsers: 2,
    newUsersToday: 1,
    dau: 1,
    mau: 2,
    totalSessions: 4,
    newSessionsToday: 1,
  });
  assert.equal(summary.dailyNewUsers.length, 30);
  assert.equal(summary.dailyNewUsers.at(-1).day, '2026-07-27');
  assert.equal(summary.dailyNewUsers.at(-1).count, 1);
  assert.equal(summary.dailyNewUsers.find((row) => row.day === '2026-07-20')?.count, 1);
  assert.deepEqual(
    summary.tenantSessionRanking.map((row) => ({
      tenantName: row.tenantName,
      userCount: row.userCount,
      sessionCount: row.sessionCount,
    })),
    [
      { tenantName: 'Alpha', userCount: 1, sessionCount: 2 },
      { tenantName: 'Beta', userCount: 2, sessionCount: 2 },
    ],
  );

  database.close();
});

test('user ranking is ordered by session count and supports tenant-name search', () => {
  const database = createAnalyticsDatabase();
  const ranking = buildAdminAnalyticsUsers({
    database,
    page: 1,
    pageSize: 20,
    now: new Date('2026-07-27T04:00:00.000Z'),
  });

  assert.deepEqual(
    ranking.users.map((row) => [row.username, row.sessionCount]),
    [
      ['alice', 2],
      ['bob', 1],
      ['carol', 1],
    ],
  );

  const filtered = buildAdminAnalyticsUsers({
    database,
    search: 'alpha',
  });
  assert.equal(filtered.pagination.total, 1);
  assert.equal(filtered.users[0].username, 'alice');

  database.close();
});
