import assert from 'node:assert/strict';
import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import Database from 'better-sqlite3';
import express from 'express';

import { DATABASE_SCHEMA_SQL } from '../database/schema.js';

// Run this file with normal node:test process isolation. The application module
// copies a legacy DB only when DATABASE_PATH does not exist, so create a fresh
// schema before the first dynamic import of admin.js (and transitively db.js).
const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-role-tests-'));
const databasePath = path.join(directory, 'roles-fixture.sqlite');
const previousDatabasePath = process.env.DATABASE_PATH;
let singletonDatabase;
let createAdminRouter;
let cleaned = false;

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (singletonDatabase?.name === databasePath && singletonDatabase.open) singletonDatabase.close();
  if (process.env.DATABASE_PATH === databasePath) {
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
  }
  // Only this fresh fixture directory is cleaned, never the application DB path.
  for (const filename of await readdir(directory)) await unlink(path.join(directory, filename));
  await rmdir(directory);
}

after(cleanup);
try {
  const fixtureDatabase = new Database(databasePath);
  try {
    fixtureDatabase.exec(DATABASE_SCHEMA_SQL);
    fixtureDatabase.exec('CREATE TABLE ai_usage_role_test_guard (id INTEGER PRIMARY KEY); INSERT INTO ai_usage_role_test_guard VALUES(1)');
  } finally { fixtureDatabase.close(); }
  process.env.DATABASE_PATH = databasePath;
  ({ db: singletonDatabase } = await import('../database/db.js'));
  assert.equal(singletonDatabase.name, databasePath, 'Role tests require their own isolated database singleton');
  assert.equal(singletonDatabase.prepare('SELECT id FROM ai_usage_role_test_guard').get().id, 1, 'The precreated fixture must not be replaced by legacy data');
  ({ createAdminRouter } = await import('./admin.js'));
} catch (error) {
  await cleanup();
  throw error;
}

async function setup(t) {
  const updates = [];
  const multitenancy = { memberships: { getMembership: () => ({ role: 'tenant_admin' }), upsertMembership: (value) => { updates.push(value); return { ...value, status: 'disabled' }; } } };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 1, is_system_admin: req.headers['x-admin'] === 'true' ? 1 : 0 }; next(); });
  app.use(createAdminRouter(multitenancy, { getUserByIdAnyStatus: () => ({ is_system_admin: 0 }) }));
  const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  async function update(body, admin = true) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/tenants/10/users/3`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-admin': String(admin) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  return { updates, update };
}

test('system admin can assign tenant report admin and omitted role preserves existing role', async (t) => {
  const { update, updates } = await setup(t);
  assert.equal((await update({ role: 'tenant_admin', status: 'disabled' })).status, 200);
  assert.equal(updates[0].role, 'tenant_admin');
  assert.equal((await update({ permission: 'view', status: 'disabled' })).status, 200);
  assert.equal(updates[1].role, 'tenant_admin');
  assert.equal((await update({ role: 'member', status: 'disabled' })).status, 200);
  assert.equal(updates[2].role, 'member');
});

test('membership role cannot create platform admins and tenant admins cannot call admin routes', async (t) => {
  const { update, updates } = await setup(t);
  assert.equal((await update({ role: 'system_admin' })).status, 400);
  assert.equal((await update({ role: 'owner' })).status, 400);
  assert.equal((await update({ role: 'tenant_admin' }, false)).status, 403);
  assert.equal(updates.length, 0);
});
