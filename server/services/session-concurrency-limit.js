import { userDb } from '../database/db.js';

const USER_SESSION_LIMIT_ENV_NAME = 'session_limit';
const FALLBACK_SESSION_LIMIT_ENV_NAME = 'SESSION_LIMIT';

export class SessionLimitExceededError extends Error {
  constructor({ activeCount, activeLeases = [], limit, source, userId }) {
    super('Session concurrency limit exceeded');
    this.name = 'SessionLimitExceededError';
    this.code = 'SESSION_LIMIT_EXCEEDED';
    this.activeCount = activeCount;
    this.activeLeases = activeLeases;
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
  const activeRequestsByUser = new Map();
  let nextRequestId = 1;

  function reserve(userId, metadata) {
    const activeRequests = activeRequestsByUser.get(userId) || new Map();
    const leaseId = nextRequestId++;
    activeRequests.set(leaseId, { ...metadata, startedAt: Date.now() });
    activeRequestsByUser.set(userId, activeRequests);

    let released = false;
    return {
      updateSessionId: (sessionId) => {
        if (released || typeof sessionId !== 'string' || !sessionId.trim()) return false;
        const currentRequest = activeRequestsByUser.get(userId)?.get(leaseId);
        if (!currentRequest) return false;
        currentRequest.sessionId = sessionId.trim();
        return true;
      },
      release: () => {
        if (released) return;
        released = true;
        const currentRequests = activeRequestsByUser.get(userId);
        if (!currentRequests) return;
        currentRequests.delete(leaseId);
        if (currentRequests.size === 0) activeRequestsByUser.delete(userId);
      },
    };
  }

  function getActiveCount(userId) {
    return activeRequestsByUser.get(Number(userId))?.size || 0;
  }

  function getActiveLeases(userId) {
    return [...(activeRequestsByUser.get(Number(userId))?.values() || [])]
      .map((entry) => ({ ...entry }));
  }

  function acquire({ userId, provider = null, sessionId = null, clientSessionId = null, requestId = null, workspaceId = null, tenantId = null }) {
    const normalizedUserId = Number(userId);
    if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
      return { release: () => {} };
    }

    const config = resolveSessionLimit({ userId: normalizedUserId, users, env });
    const activeRequests = activeRequestsByUser.get(normalizedUserId) || new Map();
    const activeCount = activeRequests.size;
    if (config && activeCount >= config.limit) {
      throw new SessionLimitExceededError({
        activeCount,
        activeLeases: [...activeRequests.values()].map((entry) => ({ ...entry })),
        limit: config.limit,
        source: config.source,
        userId: normalizedUserId,
      });
    }

    return reserve(normalizedUserId, {
      provider,
      sessionId,
      clientSessionId,
      requestId,
      workspaceId,
      tenantId,
    });
  }

  return {
    acquire,
    getActiveCount,
    getActiveLeases,
  };
}

export function createSessionConcurrencyLease({ limiter, userId, ...metadata }) {
  let lease = null;
  return {
    acquire() {
      if (!lease) lease = limiter.acquire({ userId, ...metadata });
    },
    updateSessionId(sessionId) {
      if (!lease?.updateSessionId?.(sessionId)) return false;
      metadata.sessionId = sessionId.trim();
      return true;
    },
    release() {
      lease?.release();
      lease = null;
    },
  };
}

export function isSessionLimitExceededError(error) {
  return error instanceof SessionLimitExceededError || error?.code === 'SESSION_LIMIT_EXCEEDED';
}

export function createSessionLimitExceededMessage(error, activeLeases = error?.activeLeases || []) {
  const activeCount = Number(error?.activeCount || 0);
  const limit = Number(error?.limit || 0);
  const summary = activeLeases.slice(0, 5).map((lease) => {
    const provider = String(lease.provider || 'unknown').toUpperCase();
    const session = lease.sessionId ? `会话 ${String(lease.sessionId).slice(0, 32)}` : '新会话准备中';
    const duration = Math.max(0, Math.floor((Date.now() - Number(lease.startedAt || Date.now())) / 1000));
    return `${provider} ${session}（${duration} 秒）`;
  });
  const activeDetails = summary.length > 0
    ? ` 当前占用：${summary.join('；')}${activeLeases.length > summary.length ? '；…' : ''}。`
    : '';
  return `当前用户已有 ${activeCount} 个并发请求正在运行，已达到并发请求限制 ${limit}。${activeDetails}请等待已有请求完成后再试；如需提高请求并发数，请联系管理员配置。`;
}

export const sessionConcurrencyLimiter = createSessionConcurrencyLimiter();
