import assert from 'node:assert/strict';
import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import { DATABASE_SCHEMA_SQL } from '../database/schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';

// Precreate an isolated database before importing application singletons. Never
// let this regression test discover or migrate the developer's real database.
const directory = await mkdtemp(path.join(os.tmpdir(), 'tenant-role-projection-'));
const databasePath = path.join(directory, 'imports.sqlite');
const previousDatabasePath = process.env.DATABASE_PATH;
const importDatabase = new Database(databasePath);
importDatabase.exec(DATABASE_SCHEMA_SQL);
importDatabase.close();
process.env.DATABASE_PATH = databasePath;
let singletonDatabase;
after(async () => {
  if (singletonDatabase?.open) singletonDatabase.close();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  for (const filename of await readdir(directory)) await unlink(path.join(directory, filename));
  await rmdir(directory);
});
({ db: singletonDatabase } = await import('../database/db.js'));
assert.equal(singletonDatabase.name, databasePath);
const { createMultitenancyDb } = await import('../database/multitenancy-db.js');
const { createTenantsRouter } = await import('./tenants.js');

async function fixture(t) {
  const database = new Database(':memory:');
  database.exec(`${DATABASE_SCHEMA_SQL} ${MULTITENANCY_SCHEMA_SQL}`);
  database.exec(`
    INSERT INTO users(id, username, password_hash, is_system_admin)
    VALUES (1, 'platform', 'test-only', 1), (2, 'alice', 'test-only', 0), (3, 'bob', 'test-only', 0);
    INSERT INTO tenants(id, code, name) VALUES (10, 'alpha', 'Alpha'), (20, 'beta', 'Beta');
    INSERT INTO tenant_users(tenant_id, user_id, role, permission, status) VALUES
      (10, 2, 'tenant_admin', 'edit', 'active'), (20, 2, 'member', 'view', 'active'),
      (10, 3, 'member', 'view', 'active');
  `);
  const multitenancy = createMultitenancyDb(database);
  const app = express();
  app.use((req, _res, next) => {
    req.user = database.prepare('SELECT id, is_system_admin FROM users WHERE id = ?').get(Number(req.get('x-test-user') || 2));
    next();
  });
  // Real route AND real membership query: a mocked /me payload hid this bug.
  app.use('/api/tenants', createTenantsRouter(multitenancy));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    database.close();
  });
  const mine = async (user = 2) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tenants/me`, { headers: { 'x-test-user': String(user) } });
    assert.equal(response.status, 200);
    return (await response.json()).tenants;
  };
  return { database, mine };
}

test('V1 tenant list exposes the current user role and permission for each tenant', async (t) => {
  const { mine } = await fixture(t);
  const project = (rows) => rows.map(({ id, role, permission }) => ({ id, role, permission }));
  assert.deepEqual(project(await mine()), [
    { id: 10, role: 'tenant_admin', permission: 'edit' },
    { id: 20, role: 'member', permission: 'view' },
  ]);
  assert.deepEqual(project(await mine(3)), [{ id: 10, role: 'member', permission: 'view' }]);
});

test('V1 tenant list reflects role changes and excludes disabled memberships and tenants', async (t) => {
  const { database, mine } = await fixture(t);
  database.prepare("UPDATE tenant_users SET role = 'member' WHERE tenant_id = 10 AND user_id = 2").run();
  assert.equal((await mine())[0].role, 'member');
  database.prepare("UPDATE tenant_users SET role = 'tenant_admin' WHERE tenant_id = 10 AND user_id = 2").run();
  assert.equal((await mine())[0].role, 'tenant_admin');
  database.prepare("UPDATE tenant_users SET status = 'disabled' WHERE tenant_id = 10 AND user_id = 2").run();
  assert.deepEqual((await mine()).map(({ id }) => id), [20]);
  database.prepare("UPDATE tenants SET status = 'disabled' WHERE id = 20").run();
  assert.deepEqual(await mine(), []);
});

test('platform admin tenant lists keep system_admin role rather than tenant_admin', async (t) => {
  const { mine } = await fixture(t);
  const rows = await mine(1);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(({ role, permission }) => role === 'system_admin' && permission === 'edit'));
});
