import crypto from 'node:crypto';

import bcrypt from 'bcrypt';

export const DESKTOP_MODE_ENV_NAME = 'CLOUDCLI_DESKTOP_MODE';
export const DESKTOP_LOOPBACK_HOST = '127.0.0.1';
export const DESKTOP_LOCAL_ADMIN_USERNAME = 'desktop-local-admin';
const DESKTOP_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DESKTOP_PARENT_ENVIRONMENT_NAMES = Object.freeze([
  'HOME',
  'USERPROFILE',
  'SERVER_PORT',
  'CLOUDCLI_BACKEND_ENTRY',
  'CLAUDE_CLI_PATH',
  'CLOUDCLI_NODE_EXECUTABLE',
  'CLOUDCLI_NPM_CLI_PATH',
  'GRACEFUL_SHUTDOWN_TIMEOUT_MS',
]);

export function isDesktopMode(env = process.env) {
  return String(env?.[DESKTOP_MODE_ENV_NAME] || '').trim().toLowerCase() === 'true';
}

export function applyDesktopRuntimeEnvironment(
  env = process.env,
  { databasePath, runtimeRoot, claudeConfigPath } = {},
) {
  if (!isDesktopMode(env)) {
    return false;
  }

  // Desktop is always an in-process local installation. These values intentionally
  // override both the parent environment and .env so a stale Docker configuration
  // cannot make a packaged application depend on a daemon or expose its HTTP server.
  env.HOST = DESKTOP_LOOPBACK_HOST;
  env.CLAUDE_EXECUTION_MODE = 'local';
  env.VITE_IS_PLATFORM = 'false';
  delete env.API_KEY;
  if (typeof databasePath === 'string' && databasePath.trim() !== '') {
    env.DATABASE_PATH = databasePath;
  }
  if (typeof runtimeRoot === 'string' && runtimeRoot.trim() !== '') {
    env.CLOUDCLI_RUNTIME_ROOT = runtimeRoot;
  }
  if (typeof claudeConfigPath === 'string' && claudeConfigPath.trim() !== '') {
    env.CLAUDE_CONFIG_DIR = claudeConfigPath;
  }
  return true;
}

export function captureDesktopParentEnvironment(env = process.env) {
  const snapshot = {
    [DESKTOP_MODE_ENV_NAME]: env[DESKTOP_MODE_ENV_NAME],
  };
  for (const name of DESKTOP_PARENT_ENVIRONMENT_NAMES) {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      snapshot[name] = env[name];
    }
  }
  const pathEntry = Object.entries(env)
    .find(([name]) => name.toLowerCase() === 'path');
  if (pathEntry) {
    snapshot.PATH = pathEntry[1];
  }
  return snapshot;
}

function restoreDesktopParentEnvironment(env, snapshot) {
  for (const name of DESKTOP_PARENT_ENVIRONMENT_NAMES) {
    if (Object.prototype.hasOwnProperty.call(snapshot, name)) {
      env[name] = snapshot[name];
    } else {
      delete env[name];
    }
  }
  for (const name of Object.keys(env)) {
    if (name.toLowerCase() === 'path') {
      delete env[name];
    }
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, 'PATH')) {
    env.PATH = snapshot.PATH;
  }
}

export function applyAuthoritativeDesktopRuntimeEnvironment(
  env = process.env,
  {
    desktopModeValue,
    parentEnvironment,
    databasePath,
    runtimeRoot,
    claudeConfigPath,
  } = {},
) {
  const parentDesktopModeValue = parentEnvironment
    ? parentEnvironment[DESKTOP_MODE_ENV_NAME]
    : desktopModeValue;
  if (parentDesktopModeValue === undefined) {
    delete env[DESKTOP_MODE_ENV_NAME];
  } else {
    env[DESKTOP_MODE_ENV_NAME] = parentDesktopModeValue;
  }
  if (!isDesktopMode(env)) {
    return false;
  }
  if (parentEnvironment) {
    restoreDesktopParentEnvironment(env, parentEnvironment);
  }
  return applyDesktopRuntimeEnvironment(env, {
    databasePath,
    runtimeRoot,
    claudeConfigPath,
  });
}

export function selectDesktopBootstrapUser(database) {
  return database.prepare(`
    SELECT id, username, created_at, last_login, is_system_admin
    FROM users
    WHERE is_active = 1
    ORDER BY
      CASE WHEN is_system_admin = 1 THEN 0 ELSE 1 END ASC,
      CASE WHEN last_login IS NULL THEN 1 ELSE 0 END ASC,
      last_login DESC,
      created_at DESC,
      id DESC
    LIMIT 1
  `).get() || null;
}

function createStartupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function countAllUsers(database) {
  const row = database.prepare('SELECT COUNT(*) AS count FROM users').get();
  return Number(row?.count || 0);
}

function findOrCreateActiveDefaultTenant(database, multitenancy) {
  const tenants = multitenancy.tenants.listTenants();
  const existing = tenants.find((tenant) => tenant.code === 'default');
  if (existing) {
    if (existing.status !== 'active') {
      database.prepare(`
        UPDATE tenants
        SET status = 'active', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(existing.id);
    }
    return { ...existing, status: 'active' };
  }
  return multitenancy.tenants.createTenant({
    code: 'default',
    name: 'Default',
    status: 'active',
  });
}

function isSystemAdmin(user) {
  return user?.is_system_admin === 1 || user?.is_system_admin === true;
}

function hasAccessibleActiveTenant(database, user) {
  if (isSystemAdmin(user)) {
    return Boolean(database.prepare(`
      SELECT 1
      FROM tenants
      WHERE status = 'active'
      LIMIT 1
    `).get());
  }

  return Boolean(database.prepare(`
    SELECT 1
    FROM tenant_users tu
    JOIN tenants t ON t.id = tu.tenant_id
    WHERE tu.user_id = ?
      AND tu.status = 'active'
      AND t.status = 'active'
    LIMIT 1
  `).get(user.id));
}

function ensureDesktopBootstrapTenant(database, multitenancy, user) {
  if (hasAccessibleActiveTenant(database, user)) {
    return null;
  }

  const tenant = findOrCreateActiveDefaultTenant(database, multitenancy);
  multitenancy.memberships.upsertMembership({
    tenantId: tenant.id,
    userId: user.id,
    role: isSystemAdmin(user) ? 'system_admin' : 'member',
    permission: 'edit',
    status: 'active',
  });
  return tenant;
}

function presentBootstrapUser(user) {
  return {
    id: Number(user.id),
    username: user.username,
    is_system_admin: user.is_system_admin === 1 || user.is_system_admin === true ? 1 : 0,
  };
}

function assertDesktopRequestId(requestId) {
  if (typeof requestId !== 'string' || !DESKTOP_REQUEST_ID_PATTERN.test(requestId)) {
    throw new TypeError('Desktop bootstrap request ID is invalid');
  }
  return requestId;
}

function findActiveDesktopBootstrapUser(database, userId) {
  const normalizedUserId = Number(userId);
  if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
    return null;
  }
  return database.prepare(`
    SELECT id, username, created_at, last_login, is_system_admin
    FROM users
    WHERE id = ? AND is_active = 1
    LIMIT 1
  `).get(normalizedUserId) || null;
}

export async function createDesktopBootstrapSession({
  database,
  users,
  multitenancy,
  generateToken,
  passwordHasher = (password) => bcrypt.hash(password, 12),
  randomPassword = () => crypto.randomBytes(48).toString('base64url'),
} = {}) {
  if (!database || !users || !multitenancy || typeof generateToken !== 'function') {
    throw createStartupError(
      'DESKTOP_BOOTSTRAP_CONFIGURATION_INVALID',
      'Desktop bootstrap dependencies are incomplete',
    );
  }

  let user = selectDesktopBootstrapUser(database);

  if (!user) {
    if (countAllUsers(database) > 0) {
      throw createStartupError(
        'DESKTOP_NO_ACTIVE_USER',
        'Desktop mode requires at least one enabled user',
      );
    }

    // The generated password is deliberately discarded. The account can only be
    // reached through the private Electron bootstrap session, not with a known default
    // password over the public authentication routes.
    const passwordHash = await passwordHasher(randomPassword());
    const createLocalAdmin = database.transaction(() => {
      const createdUser = users.createUser(
        DESKTOP_LOCAL_ADMIN_USERNAME,
        passwordHash,
        { isSystemAdmin: true },
      );
      users.completeOnboarding?.(createdUser.id);

      ensureDesktopBootstrapTenant(database, multitenancy, createdUser);
      return createdUser;
    });

    user = createLocalAdmin();
  } else {
    database.transaction(() => {
      ensureDesktopBootstrapTenant(database, multitenancy, user);
    })();
  }

  const sessionUser = presentBootstrapUser(user);
  const token = generateToken(sessionUser);
  users.updateLastLogin?.(sessionUser.id);

  return { user: sessionUser, token };
}

export async function createDesktopBootstrapSessionForUser({
  database,
  users,
  multitenancy,
  generateToken,
  userId,
} = {}) {
  if (!database || !users || !multitenancy || typeof generateToken !== 'function') {
    throw createStartupError(
      'DESKTOP_BOOTSTRAP_CONFIGURATION_INVALID',
      'Desktop bootstrap dependencies are incomplete',
    );
  }

  const user = findActiveDesktopBootstrapUser(database, userId);
  if (!user) {
    throw createStartupError(
      'DESKTOP_BOOTSTRAP_USER_UNAVAILABLE',
      'The selected desktop user is no longer enabled',
    );
  }

  database.transaction(() => {
    ensureDesktopBootstrapTenant(database, multitenancy, user);
  })();
  const sessionUser = presentBootstrapUser(user);
  const token = generateToken(sessionUser);
  users.updateLastLogin?.(sessionUser.id);
  return { user: sessionUser, token };
}

export function parseDesktopBootstrapSessionRequest(message) {
  if (
    !message
    || typeof message !== 'object'
    || Array.isArray(message)
    || message.type !== 'bootstrap-session-request'
    || typeof message.requestId !== 'string'
    || !DESKTOP_REQUEST_ID_PATTERN.test(message.requestId)
  ) {
    return null;
  }
  return {
    type: 'bootstrap-session-request',
    requestId: message.requestId,
  };
}

export function createDesktopBootstrapSessionResultMessage({ requestId, session }) {
  assertDesktopRequestId(requestId);
  if (
    !session
    || typeof session !== 'object'
    || typeof session.token !== 'string'
    || !session.token
    || !session.user
    || typeof session.user !== 'object'
    || typeof session.user.username !== 'string'
    || !session.user.username
  ) {
    throw new TypeError('Desktop bootstrap session is invalid');
  }
  return {
    type: 'bootstrap-session-result',
    requestId,
    session,
  };
}

export function createDesktopBootstrapSessionErrorMessage({ requestId, error }) {
  assertDesktopRequestId(requestId);
  const startupError = createDesktopStartupErrorMessage(error);
  return {
    type: 'bootstrap-session-error',
    requestId,
    code: startupError.code,
    message: startupError.message,
  };
}

export function createDesktopReadyMessage({ port, session }) {
  const normalizedPort = Number(port);
  if (!Number.isInteger(normalizedPort) || normalizedPort <= 0 || normalizedPort > 65535) {
    throw new TypeError('Desktop ready port must be an integer between 1 and 65535');
  }

  return {
    type: 'ready',
    port: normalizedPort,
    origin: `http://${DESKTOP_LOOPBACK_HOST}:${normalizedPort}`,
    session: session || null,
  };
}

export function createDesktopStartupErrorMessage(error) {
  const rawCode = typeof error?.code === 'string' ? error.code.trim() : '';
  const normalizedCode = rawCode
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '_')
    .replace(/^[^A-Z0-9]+/, '')
    .slice(0, 128);
  const rawMessage = typeof error?.message === 'string' ? error.message.trim() : '';
  return {
    type: 'startup-error',
    code: normalizedCode || 'SERVER_STARTUP_FAILED',
    message: (rawMessage || 'CloudCLI server failed to start').slice(0, 2_000),
  };
}

export function postParentProcessMessage(message, targetProcess = process) {
  if (typeof targetProcess?.parentPort?.postMessage === 'function') {
    targetProcess.parentPort.postMessage(message);
    return true;
  }
  if (typeof targetProcess?.send === 'function') {
    targetProcess.send(message);
    return true;
  }
  return false;
}
