import { userDb } from '../database/db.js';

const USER_SESSION_LIMIT_ENV_NAME = 'session_limit';
const FALLBACK_SESSION_LIMIT_ENV_NAME = 'SESSION_LIMIT';

export class SessionLimitExceededError extends Error {
  constructor({ activeCount, limit, source, userId }) {
    super('Session concurrency limit exceeded');
    this.name = 'SessionLimitExceededError';
    this.code = 'SESSION_LIMIT_EXCEEDED';
    this.activeCount = activeCount;
    this.limit = limit;
    this.source = source;
    this.userId = userId;
  }
}

function parsePositiveInteger(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (!/^\d+$/.test(normalized)) return null;

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function getConfiguredUserLimit(userEnv) {
  if (!userEnv || typeof userEnv !== 'object') {
    return null;
  }

  if (Object.hasOwn(userEnv, USER_SESSION_LIMIT_ENV_NAME)) {
    const parsed = parsePositiveInteger(userEnv[USER_SESSION_LIMIT_ENV_NAME]);
    if (parsed != null) {
      return {
        limit: parsed,
        source: 'database',
      };
    }
  }

  return null;
}

export function resolveSessionLimit({ userId, users = userDb, env = process.env } = {}) {
  if (userId != null && users && typeof users.getEnvForUser === 'function') {
    try {
      const userLimit = getConfiguredUserLimit(users.getEnvForUser(userId));
      if (userLimit) {
        return userLimit;
      }
    } catch (error) {
      console.warn('[SessionLimit] Failed to read user session_limit:', error?.message || error);
    }
  }

  const fallbackLimit = parsePositiveInteger(env?.[FALLBACK_SESSION_LIMIT_ENV_NAME]);
  return fallbackLimit == null
    ? null
    : {
      limit: fallbackLimit,
      source: 'env',
    };
}

export function createSessionConcurrencyLimiter({
  users = userDb,
  env = process.env,
} = {}) {
  const activeRequestIdsByUser = new Map();
  let nextRequestId = 1;

  function getActiveCount(userId) {
    return activeRequestIdsByUser.get(Number(userId))?.size || 0;
  }

  function acquire({ userId }) {
    const normalizedUserId = Number(userId);
    if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
      return { release: () => {} };
    }

    const config = resolveSessionLimit({ userId: normalizedUserId, users, env });
    if (!config) {
      return { release: () => {} };
    }

    const activeRequests = activeRequestIdsByUser.get(normalizedUserId) || new Set();
    const activeCount = activeRequests.size;
    if (activeCount >= config.limit) {
      throw new SessionLimitExceededError({
        activeCount,
        limit: config.limit,
        source: config.source,
        userId: normalizedUserId,
      });
    }

    const requestId = nextRequestId;
    nextRequestId += 1;
    activeRequests.add(requestId);
    activeRequestIdsByUser.set(normalizedUserId, activeRequests);

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const currentRequests = activeRequestIdsByUser.get(normalizedUserId);
        if (!currentRequests) return;
        currentRequests.delete(requestId);
        if (currentRequests.size === 0) {
          activeRequestIdsByUser.delete(normalizedUserId);
        }
      },
    };
  }

  return {
    acquire,
    getActiveCount,
  };
}

export function isSessionLimitExceededError(error) {
  return error instanceof SessionLimitExceededError || error?.code === 'SESSION_LIMIT_EXCEEDED';
}

export function createSessionLimitExceededMessage(error) {
  const activeCount = Number(error?.activeCount || 0);
  const limit = Number(error?.limit || 0);
  return `当前用户已有 ${activeCount} 个并发请求正在运行，已达到并发请求限制 ${limit}。请等待已有请求完成后再试；如需提高请求并发数，请联系管理员配置。`;
}

export const sessionConcurrencyLimiter = createSessionConcurrencyLimiter();
