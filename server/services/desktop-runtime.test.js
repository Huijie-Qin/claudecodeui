import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { DATABASE_SCHEMA_SQL } from '../database/schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';

import {
  DESKTOP_LOCAL_ADMIN_USERNAME,
  applyAuthoritativeDesktopRuntimeEnvironment,
  applyDesktopRuntimeEnvironment,
  captureDesktopParentEnvironment,
  createDesktopBootstrapSession,
  createDesktopBootstrapSessionErrorMessage,
  createDesktopBootstrapSessionForUser,
  createDesktopBootstrapSessionResultMessage,
  createDesktopReadyMessage,
  createDesktopStartupErrorMessage,
  parseDesktopBootstrapSessionRequest,
  postParentProcessMessage,
  selectDesktopBootstrapUser,
} from './desktop-runtime.js';

function createDatabase() {
  const database = new Database(':memory:');
  database.exec(DATABASE_SCHEMA_SQL);
  database.exec(MULTITENANCY_SCHEMA_SQL);
  return database;
}

function insertUser(database, {
  username,
  active = 1,
  systemAdmin = 0,
  createdAt,
  lastLogin = null,
}) {
  const result = database.prepare(`
    INSERT INTO users (
      username,
      password_hash,
      is_active,
      is_system_admin,
      created_at,
      last_login
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(username, `hash-${username}`, active, systemAdmin, createdAt, lastLogin);
  return Number(result.lastInsertRowid);
}

function createBootstrapDependencies(database) {
  const onboarding = [];
  const loginUpdates = [];
  const users = {
    createUser: (username, passwordHash, { isSystemAdmin } = {}) => {
      const result = database.prepare(`
        INSERT INTO users (username, password_hash, is_system_admin)
        VALUES (?, ?, ?)
      `).run(username, passwordHash, isSystemAdmin ? 1 : 0);
      return {
        id: Number(result.lastInsertRowid),
        username,
        is_system_admin: isSystemAdmin ? 1 : 0,
      };
    },
    completeOnboarding: (userId) => {
      onboarding.push(Number(userId));
      database.prepare('UPDATE users SET has_completed_onboarding = 1 WHERE id = ?').run(userId);
    },
    updateLastLogin: (userId) => {
      loginUpdates.push(Number(userId));
      database.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    },
  };
  const multitenancy = {
    tenants: {
      listTenants: () => database.prepare('SELECT * FROM tenants ORDER BY code ASC').all(),
      createTenant: ({ code, name, status }) => {
        const result = database.prepare(`
          INSERT INTO tenants (code, name, status) VALUES (?, ?, ?)
        `).run(code, name, status);
        return database.prepare('SELECT * FROM tenants WHERE id = ?').get(result.lastInsertRowid);
      },
    },
    memberships: {
      upsertMembership: ({ tenantId, userId, role, permission, status }) => {
        database.prepare(`
          INSERT INTO tenant_users (tenant_id, user_id, role, permission, status)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, user_id) DO UPDATE SET
            role = excluded.role,
            permission = excluded.permission,
            status = excluded.status
        `).run(tenantId, userId, role, permission, status);
      },
    },
  };
  return { users, multitenancy, onboarding, loginUpdates };
}

test('desktop environment always binds locally and forces Claude local mode', () => {
  const env = {
    CLOUDCLI_DESKTOP_MODE: 'true',
    HOST: '0.0.0.0',
    CLAUDE_EXECUTION_MODE: 'docker',
    VITE_IS_PLATFORM: 'true',
    API_KEY: 'web-only-secret',
    DATABASE_PATH: '/old/database.db',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
  };

  assert.equal(applyDesktopRuntimeEnvironment(env, {
    databasePath: '/test-home/.cloudcli/auth.db',
  }), true);
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.CLAUDE_EXECUTION_MODE, 'local');
  assert.equal(env.VITE_IS_PLATFORM, 'false');
  assert.equal('API_KEY' in env, false);
  assert.equal(env.DATABASE_PATH, '/test-home/.cloudcli/auth.db');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
});

test('non-desktop environment is not changed', () => {
  const env = { HOST: '0.0.0.0', CLAUDE_EXECUTION_MODE: 'docker' };
  assert.equal(applyDesktopRuntimeEnvironment(env), false);
  assert.deepEqual(env, { HOST: '0.0.0.0', CLAUDE_EXECUTION_MODE: 'docker' });
});

test('parent desktop mode remains authoritative after loading an env file', () => {
  const parentEnvironment = captureDesktopParentEnvironment({
    CLOUDCLI_DESKTOP_MODE: 'true',
    SERVER_PORT: '45678',
    CLAUDE_CLI_PATH: '/bundled/claude',
    CLOUDCLI_NODE_EXECUTABLE: '/bundled/node',
    CLOUDCLI_NPM_CLI_PATH: '/runtime/npm-cli.js',
    GRACEFUL_SHUTDOWN_TIMEOUT_MS: '1740000',
    HOME: '/test-home',
    PATH: '/bundled/bin:/usr/bin',
  });
  const desktopEnv = {
    CLOUDCLI_DESKTOP_MODE: 'false',
    SERVER_PORT: '9999',
    HOST: '0.0.0.0',
    CLAUDE_EXECUTION_MODE: 'docker',
    CLAUDE_CLI_PATH: '/host/claude',
    CLOUDCLI_NODE_EXECUTABLE: '/host/node',
    CLOUDCLI_NPM_CLI_PATH: '/host/npm',
    CLOUDCLI_BACKEND_ENTRY: '/host/server.js',
    CLOUDCLI_RUNTIME_ROOT: '/host/runtime',
    CLAUDE_CONFIG_DIR: '/host/claude-config',
    GRACEFUL_SHUTDOWN_TIMEOUT_MS: '1',
    HOME: '/host-home',
    Path: '/host/bin',
    VITE_IS_PLATFORM: 'true',
    API_KEY: 'from-env-file',
    DATABASE_PATH: '/from/env-file.db',
  };
  assert.equal(applyAuthoritativeDesktopRuntimeEnvironment(desktopEnv, {
    parentEnvironment,
    databasePath: '/test-home/.cloudcli/auth.db',
    runtimeRoot: '/test-home/.cloudcli/runtimes',
    claudeConfigPath: '/test-home/.claude',
  }), true);
  assert.deepEqual(desktopEnv, {
    CLOUDCLI_DESKTOP_MODE: 'true',
    SERVER_PORT: '45678',
    HOST: '127.0.0.1',
    CLAUDE_EXECUTION_MODE: 'local',
    CLAUDE_CLI_PATH: '/bundled/claude',
    CLOUDCLI_NODE_EXECUTABLE: '/bundled/node',
    CLOUDCLI_NPM_CLI_PATH: '/runtime/npm-cli.js',
    CLOUDCLI_RUNTIME_ROOT: '/test-home/.cloudcli/runtimes',
    CLAUDE_CONFIG_DIR: '/test-home/.claude',
    GRACEFUL_SHUTDOWN_TIMEOUT_MS: '1740000',
    HOME: '/test-home',
    PATH: '/bundled/bin:/usr/bin',
    VITE_IS_PLATFORM: 'false',
    DATABASE_PATH: '/test-home/.cloudcli/auth.db',
  });

  const webEnv = {
    CLOUDCLI_DESKTOP_MODE: 'true',
    HOST: '0.0.0.0',
    API_KEY: 'web-secret',
    DATABASE_PATH: '/web/database.db',
  };
  assert.equal(applyAuthoritativeDesktopRuntimeEnvironment(webEnv, {
    desktopModeValue: undefined,
    databasePath: '/unused/desktop.db',
  }), false);
  assert.deepEqual(webEnv, {
    HOST: '0.0.0.0',
    API_KEY: 'web-secret',
    DATABASE_PATH: '/web/database.db',
  });
});

test('desktop user selection prioritizes the most recently logged-in enabled system admin', () => {
  const database = createDatabase();
  try {
    insertUser(database, {
      username: 'newest-member',
      createdAt: '2026-01-01 00:00:00',
      lastLogin: '2026-08-19 12:00:00',
    });
    insertUser(database, {
      username: 'older-admin',
      systemAdmin: 1,
      createdAt: '2026-01-01 00:00:00',
      lastLogin: '2026-08-17 12:00:00',
    });
    insertUser(database, {
      username: 'newer-admin',
      systemAdmin: 1,
      createdAt: '2026-01-01 00:00:00',
      lastLogin: '2026-08-18 12:00:00',
    });
    insertUser(database, {
      username: 'disabled-admin',
      active: 0,
      systemAdmin: 1,
      createdAt: '2026-01-01 00:00:00',
      lastLogin: '2026-08-19 13:00:00',
    });

    assert.equal(selectDesktopBootstrapUser(database).username, 'newer-admin');
  } finally {
    database.close();
  }
});

test('desktop user selection falls back to the most recently logged-in enabled member', () => {
  const database = createDatabase();
  try {
    insertUser(database, {
      username: 'older-member',
      createdAt: '2026-01-01 00:00:00',
      lastLogin: '2026-08-18 12:00:00',
    });
    insertUser(database, {
      username: 'newer-member',
      createdAt: '2026-01-01 00:00:00',
      lastLogin: '2026-08-19 12:00:00',
    });
    assert.equal(selectDesktopBootstrapUser(database).username, 'newer-member');
  } finally {
    database.close();
  }
});

test('empty desktop database creates a private local admin, default tenant, and token', async () => {
  const database = createDatabase();
  try {
    const deps = createBootstrapDependencies(database);
    let hashedPassword = null;
    const session = await createDesktopBootstrapSession({
      database,
      users: deps.users,
      multitenancy: deps.multitenancy,
      generateToken: (user) => `desktop-token-${user.id}`,
      randomPassword: () => 'discarded-random-password',
      passwordHasher: async (password) => {
        assert.equal(password, 'discarded-random-password');
        hashedPassword = 'one-way-random-hash';
        return hashedPassword;
      },
    });

    assert.deepEqual(session, {
      user: { id: 1, username: DESKTOP_LOCAL_ADMIN_USERNAME, is_system_admin: 1 },
      token: 'desktop-token-1',
    });
    const storedUser = database.prepare('SELECT * FROM users WHERE id = 1').get();
    assert.equal(storedUser.password_hash, hashedPassword);
    assert.equal(storedUser.password_hash.includes('discarded-random-password'), false);
    assert.equal(storedUser.has_completed_onboarding, 1);
    assert.deepEqual(deps.onboarding, [1]);
    assert.deepEqual(deps.loginUpdates, [1]);
    assert.deepEqual(
      database.prepare('SELECT code, name, status FROM tenants').all(),
      [{ code: 'default', name: 'Default', status: 'active' }],
    );
    assert.deepEqual(
      database.prepare('SELECT role, permission, status FROM tenant_users').all(),
      [{ role: 'system_admin', permission: 'edit', status: 'active' }],
    );
  } finally {
    database.close();
  }
});

test('existing member without tenant access receives an editable default membership', async () => {
  const database = createDatabase();
  try {
    const userId = insertUser(database, {
      username: 'desktop-member',
      createdAt: '2026-01-01 00:00:00',
    });
    const deps = createBootstrapDependencies(database);
    const session = await createDesktopBootstrapSession({
      database,
      users: deps.users,
      multitenancy: deps.multitenancy,
      generateToken: (user) => `desktop-token-${user.id}`,
    });

    assert.equal(session.user.id, userId);
    assert.deepEqual(
      database.prepare('SELECT code, status FROM tenants').all(),
      [{ code: 'default', status: 'active' }],
    );
    assert.deepEqual(
      database.prepare(`
        SELECT role, permission, status
        FROM tenant_users
        WHERE user_id = ?
      `).all(userId),
      [{ role: 'member', permission: 'edit', status: 'active' }],
    );
  } finally {
    database.close();
  }
});

test('existing admin reactivates a disabled default tenant and membership', async () => {
  const database = createDatabase();
  try {
    const userId = insertUser(database, {
      username: 'desktop-admin',
      systemAdmin: 1,
      createdAt: '2026-01-01 00:00:00',
    });
    const tenantId = Number(database.prepare(`
      INSERT INTO tenants (code, name, status)
      VALUES ('default', 'Default', 'disabled')
    `).run().lastInsertRowid);
    database.prepare(`
      INSERT INTO tenant_users (tenant_id, user_id, role, permission, status)
      VALUES (?, ?, 'member', 'view', 'disabled')
    `).run(tenantId, userId);

    const deps = createBootstrapDependencies(database);
    await createDesktopBootstrapSession({
      database,
      users: deps.users,
      multitenancy: deps.multitenancy,
      generateToken: () => 'desktop-token',
    });

    assert.deepEqual(
      database.prepare('SELECT code, status FROM tenants WHERE id = ?').get(tenantId),
      { code: 'default', status: 'active' },
    );
    assert.deepEqual(
      database.prepare(`
        SELECT role, permission, status
        FROM tenant_users
        WHERE tenant_id = ? AND user_id = ?
      `).get(tenantId, userId),
      { role: 'system_admin', permission: 'edit', status: 'active' },
    );
  } finally {
    database.close();
  }
});

test('non-empty database with no enabled user fails desktop bootstrap', async () => {
  const database = createDatabase();
  try {
    insertUser(database, {
      username: 'disabled',
      active: 0,
      createdAt: '2026-01-01 00:00:00',
    });
    const deps = createBootstrapDependencies(database);
    await assert.rejects(
      createDesktopBootstrapSession({
        database,
        users: deps.users,
        multitenancy: deps.multitenancy,
        generateToken: () => 'unused',
      }),
      (error) => error.code === 'DESKTOP_NO_ACTIVE_USER',
    );
  } finally {
    database.close();
  }
});

test('fresh desktop bootstrap requests revalidate the selected user and sign a new token', async () => {
  const database = createDatabase();
  try {
    const userId = insertUser(database, {
      username: 'desktop-admin',
      systemAdmin: 1,
      createdAt: '2026-01-01 00:00:00',
    });
    const deps = createBootstrapDependencies(database);
    let tokenSequence = 0;
    const createFreshSession = () => createDesktopBootstrapSessionForUser({
      database,
      users: deps.users,
      multitenancy: deps.multitenancy,
      generateToken: (user) => `fresh-token-${user.id}-${++tokenSequence}`,
      userId,
    });

    assert.deepEqual(await createFreshSession(), {
      user: { id: userId, username: 'desktop-admin', is_system_admin: 1 },
      token: `fresh-token-${userId}-1`,
    });
    assert.deepEqual(await createFreshSession(), {
      user: { id: userId, username: 'desktop-admin', is_system_admin: 1 },
      token: `fresh-token-${userId}-2`,
    });

    database.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(userId);
    await assert.rejects(
      createFreshSession(),
      (error) => error.code === 'DESKTOP_BOOTSTRAP_USER_UNAVAILABLE',
    );
  } finally {
    database.close();
  }
});

test('desktop bootstrap message helpers validate and correlate private requests', () => {
  assert.deepEqual(parseDesktopBootstrapSessionRequest({
    type: 'bootstrap-session-request',
    requestId: 'request_123',
  }), {
    type: 'bootstrap-session-request',
    requestId: 'request_123',
  });
  assert.equal(parseDesktopBootstrapSessionRequest({
    type: 'bootstrap-session-request',
    requestId: '../bad',
  }), null);

  const session = { user: { id: 4, username: 'admin' }, token: 'fresh-token' };
  assert.deepEqual(createDesktopBootstrapSessionResultMessage({
    requestId: 'request_123',
    session,
  }), {
    type: 'bootstrap-session-result',
    requestId: 'request_123',
    session,
  });
  assert.deepEqual(createDesktopBootstrapSessionErrorMessage({
    requestId: 'request_123',
    error: { code: 'USER_DISABLED', message: ' disabled ' },
  }), {
    type: 'bootstrap-session-error',
    requestId: 'request_123',
    code: 'USER_DISABLED',
    message: 'disabled',
  });
});

test('desktop process messages expose the actual origin and a sanitized startup error', () => {
  const session = { user: { id: 4, username: 'admin' }, token: 'token' };
  assert.deepEqual(createDesktopReadyMessage({ port: 43123, session }), {
    type: 'ready',
    port: 43123,
    origin: 'http://127.0.0.1:43123',
    session,
  });
  assert.deepEqual(createDesktopStartupErrorMessage({ code: 'EADDRINUSE', message: 'in use' }), {
    type: 'startup-error',
    code: 'EADDRINUSE',
    message: 'in use',
  });
  assert.deepEqual(createDesktopStartupErrorMessage({ code: '@bad code', message: ' failed ' }), {
    type: 'startup-error',
    code: 'BAD_CODE',
    message: 'failed',
  });
});

test('utility-process parent port is preferred over the legacy child-process channel', () => {
  const parentMessages = [];
  const childMessages = [];
  const sent = postParentProcessMessage(
    { type: 'ready' },
    {
      parentPort: { postMessage: (message) => parentMessages.push(message) },
      send: (message) => childMessages.push(message),
    },
  );
  assert.equal(sent, true);
  assert.deepEqual(parentMessages, [{ type: 'ready' }]);
  assert.deepEqual(childMessages, []);
});
