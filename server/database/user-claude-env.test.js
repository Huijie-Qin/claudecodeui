import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

test('admin user env deletes remove NOCASE keys from value, visibility, and encryption records', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'user-claude-env-delete-'));
  const databasePath = path.join(directory, 'auth.db');
  const bootstrapDatabase = new Database(databasePath);
  bootstrapDatabase.exec(`
    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      prod_code TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  bootstrapDatabase.close();
  const previousDatabasePath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = databasePath;
  let databaseModule;

  try {
    databaseModule = await import(`./db.js?user-claude-env-delete=${Date.now()}`);
    await databaseModule.initializeDatabase();
    const user = databaseModule.userDb.createUser('env-delete-user', 'hash', {
      env: { KEEP_VALUE: 'keep' },
    });

    databaseModule.userDb.updateClaudeEnvForUsers({
      userIds: [user.id],
      env: {
        MiXeD_Key: 'visible-value',
        SECRET_TOKEN: 'encrypted-value',
      },
      visibility: { MiXeD_Key: true, SECRET_TOKEN: true },
      encrypted: { MiXeD_Key: false, SECRET_TOKEN: true },
    });
    const before = databaseModule.db.prepare(`
      SELECT env, env_visibility, env_encrypted FROM users WHERE id = ?
    `).get(user.id);
    assert.match(JSON.parse(before.env).SECRET_TOKEN, /^secret:/);
    assert.equal(JSON.parse(before.env_visibility).MiXeD_Key, true);
    assert.equal(JSON.parse(before.env_encrypted).SECRET_TOKEN, true);
    databaseModule.db.prepare(`
      UPDATE users SET env_visibility = ?, env_encrypted = ? WHERE id = ?
    `).run(
      JSON.stringify({ MiXeD_Key: true, secret_token: true }),
      JSON.stringify({ MiXeD_Key: false, secret_token: true }),
      user.id,
    );
    const beforeList = databaseModule.userDb.listClaudeEnvForUsers()[0].env;
    assert.equal(beforeList.find((entry) => entry.name === 'MiXeD_Key')?.value, 'visible-value');
    const listedSecret = beforeList.find((entry) => entry.name === 'SECRET_TOKEN');
    assert.equal(listedSecret?.visible, true);
    assert.equal(listedSecret?.encrypted, true);
    assert.equal(Object.hasOwn(listedSecret, 'value'), false);

    const [result] = databaseModule.userDb.updateClaudeEnvForUsers({
      userIds: [user.id],
      env: {},
      visibility: {},
      encrypted: {},
      deletes: ['mixed_key', 'secret_token', 'MIXED_KEY'],
    });
    assert.equal(result.success, true);
    assert.deepEqual(result.env, {});
    assert.deepEqual(result.deleted, ['mixed_key', 'secret_token']);

    const runtimeEnv = databaseModule.userDb.getEnvForUser(user.id);
    assert.equal(runtimeEnv.KEEP_VALUE, 'keep');
    assert.equal(Object.keys(runtimeEnv).some((name) => name.toUpperCase() === 'MIXED_KEY'), false);
    assert.equal(Object.keys(runtimeEnv).some((name) => name.toUpperCase() === 'SECRET_TOKEN'), false);
    assert.equal(typeof runtimeEnv.USER_KEY, 'string');

    const after = databaseModule.db.prepare(`
      SELECT env, env_visibility, env_encrypted FROM users WHERE id = ?
    `).get(user.id);
    for (const column of ['env', 'env_visibility', 'env_encrypted']) {
      const names = Object.keys(JSON.parse(after[column])).map((name) => name.toUpperCase());
      assert.equal(names.includes('MIXED_KEY'), false);
      assert.equal(names.includes('SECRET_TOKEN'), false);
    }
    assert.deepEqual(
      databaseModule.userDb.listClaudeEnvForUsers()[0].env.map((entry) => entry.name),
      ['KEEP_VALUE'],
    );

    assert.throws(
      () => databaseModule.userDb.updateClaudeEnvForUsers({
        userIds: [user.id],
        env: { keep_value: 'replacement' },
        deletes: ['KEEP_VALUE'],
      }),
      /cannot be both updated and deleted/,
    );
    assert.throws(
      () => databaseModule.userDb.updateClaudeEnvForUsers({
        userIds: [user.id],
        env: {},
        deletes: ['user_key'],
      }),
      /managed and cannot be deleted/,
    );
    assert.equal(databaseModule.userDb.getEnvForUser(user.id).KEEP_VALUE, 'keep');
  } finally {
    databaseModule?.db?.close();
    if (previousDatabasePath == null) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
