import { USER_KEY_ENV_NAME } from '../database/user-env.js';

const W3_NAME_ENV_NAME = 'W3_NAME';
const TENANT_ID_ENV_NAME = 'TENANT_ID';

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requirePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw createHttpError(`${name} must be a positive integer`, 400);
  }
  return number;
}

async function getUserStore(users) {
  if (users) return users;

  const { userDb } = await import('../database/db.js');
  return userDb;
}

export async function buildMcpTestHostEnv({ users = null, userId, tenantId } = {}) {
  const normalizedUserId = requirePositiveInteger(userId, 'userId');
  const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
  const userStore = await getUserStore(users);
  const user = typeof userStore?.getUserById === 'function'
    ? userStore.getUserById(normalizedUserId)
    : null;
  const username = user?.username;

  if (typeof username !== 'string' || username.trim() === '') {
    throw createHttpError('User not found', 404);
  }

  const userEnv = typeof userStore?.getEnvForUser === 'function'
    ? userStore.getEnvForUser(normalizedUserId)
    : {};
  const env = {
    [W3_NAME_ENV_NAME]: username.trim(),
    [TENANT_ID_ENV_NAME]: String(normalizedTenantId),
  };
  const userKey = userEnv?.[USER_KEY_ENV_NAME];
  if (typeof userKey === 'string' && userKey.trim() !== '') {
    env[USER_KEY_ENV_NAME] = userKey;
  }

  return env;
}

export async function withTemporaryProcessEnv(env, task) {
  const previousValues = new Map();

  for (const [key, value] of Object.entries(env)) {
    previousValues.set(key, {
      hadValue: Object.hasOwn(process.env, key),
      value: process.env[key],
    });
    process.env[key] = String(value);
  }

  try {
    return await task();
  } finally {
    for (const [key, previous] of previousValues) {
      if (previous.hadValue) {
        process.env[key] = previous.value;
      } else {
        delete process.env[key];
      }
    }
  }
}
