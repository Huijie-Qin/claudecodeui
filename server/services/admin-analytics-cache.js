import { db as defaultDb } from '../database/db.js';

import {
  buildAdminAnalyticsSummary,
  buildAdminAnalyticsUsers,
} from './admin-analytics.js';

const CACHE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS admin_analytics_cache (
    cache_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    refresh_interval_minutes INTEGER NOT NULL
  )
`;

const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 365;
const DEFAULT_USER_ANALYTICS_PAGE_SIZE = 20;
const MAX_USER_ANALYTICS_PAGE_SIZE = 100;
const REFRESH_INTERVAL_MINUTES = 30;
const WARM_RANGE_DAYS = [7, 30, 90];
const VALID_USER_SORTS = new Set(['sessionCount', 'userMessageCount']);

function normalizeRangeDays(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_RANGE_DAYS), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_RANGE_DAYS;
  }
  return Math.min(parsed, MAX_RANGE_DAYS);
}

function normalizePositiveInteger(value, fallback, max = Number.POSITIVE_INFINITY) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function normalizeUserAnalyticsSortBy(value) {
  return VALID_USER_SORTS.has(String(value)) ? String(value) : 'sessionCount';
}

function normalizeSearchTerm(value) {
  const normalized = String(value ?? '').trim();
  return normalized.length > 128 ? normalized.slice(0, 128) : normalized;
}

function addMinutesIso(value, minutes) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + minutes * 60 * 1000).toISOString();
}

function summaryCacheKey(rangeDays) {
  return `summary:${rangeDays}`;
}

function usersCacheKey({ rangeDays, page, pageSize, sortBy, search }) {
  const params = new URLSearchParams({
    rangeDays: String(rangeDays),
    page: String(page),
    pageSize: String(pageSize),
    sortBy,
    search,
  });
  return `users:${params.toString()}`;
}

function withCacheMetadata(payload, row) {
  const updatedAt = row.updated_at;
  return {
    ...payload,
    cache: {
      updatedAt,
      intervalMinutes: Number(row.refresh_interval_minutes || REFRESH_INTERVAL_MINUTES),
      nextRefreshAt: addMinutesIso(updatedAt, Number(row.refresh_interval_minutes || REFRESH_INTERVAL_MINUTES)),
    },
  };
}

export function createAdminAnalyticsCacheService({
  database = defaultDb,
  refreshIntervalMinutes = REFRESH_INTERVAL_MINUTES,
  warmRangeDays = WARM_RANGE_DAYS,
  logger = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  database.exec(CACHE_TABLE_SQL);

  const refreshIntervalMs = refreshIntervalMinutes * 60 * 1000;
  const runningKeys = new Set();
  let startupTimer = null;
  let interval = null;
  let refreshAllRunning = false;

  function isRowStale(updatedAt, now = Date.now()) {
    const updatedTime = new Date(updatedAt).getTime();
    if (!Number.isFinite(updatedTime)) return true;
    return now - updatedTime >= refreshIntervalMs;
  }

  function readCache(cacheKey) {
    const row = database.prepare(`
      SELECT cache_key, payload_json, updated_at, refresh_interval_minutes
      FROM admin_analytics_cache
      WHERE cache_key = ?
    `).get(cacheKey);
    if (!row) return null;

    try {
      return {
        row,
        payload: JSON.parse(row.payload_json),
      };
    } catch (error) {
      logger?.warn?.('[Admin Analytics Cache] Failed to parse cached payload', {
        cacheKey,
        error: error?.message,
      });
      return null;
    }
  }

  function writeCache(cacheKey, payload) {
    const updatedAt = new Date().toISOString();
    database.prepare(`
      INSERT INTO admin_analytics_cache (
        cache_key,
        payload_json,
        updated_at,
        refresh_interval_minutes
      )
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at,
        refresh_interval_minutes = excluded.refresh_interval_minutes
    `).run(
      cacheKey,
      JSON.stringify(payload),
      updatedAt,
      refreshIntervalMinutes,
    );
    return {
      cache_key: cacheKey,
      payload_json: JSON.stringify(payload),
      updated_at: updatedAt,
      refresh_interval_minutes: refreshIntervalMinutes,
    };
  }

  function computeSummary(rangeDays) {
    return buildAdminAnalyticsSummary({ database, rangeDays });
  }

  function computeUsers(params) {
    return buildAdminAnalyticsUsers({ database, ...params });
  }

  function refreshKey(cacheKey, computePayload) {
    if (runningKeys.has(cacheKey)) return;
    runningKeys.add(cacheKey);

    setTimeout(() => {
      try {
        writeCache(cacheKey, computePayload());
      } catch (error) {
        logger?.warn?.('[Admin Analytics Cache] Refresh failed', {
          cacheKey,
          error: error?.message,
        });
      } finally {
        runningKeys.delete(cacheKey);
      }
    }, 0);
  }

  function getOrCompute(cacheKey, computePayload) {
    const cached = readCache(cacheKey);
    if (cached) {
      if (isRowStale(cached.row.updated_at)) {
        refreshKey(cacheKey, computePayload);
      }
      return withCacheMetadata(cached.payload, cached.row);
    }

    const payload = computePayload();
    return withCacheMetadata(payload, writeCache(cacheKey, payload));
  }

  function normalizeUsersParams({
    rangeDays = DEFAULT_RANGE_DAYS,
    page = 1,
    pageSize = DEFAULT_USER_ANALYTICS_PAGE_SIZE,
    sortBy = 'sessionCount',
    search = '',
  } = {}) {
    return {
      rangeDays: normalizeRangeDays(rangeDays),
      page: normalizePositiveInteger(page, 1),
      pageSize: normalizePositiveInteger(
        pageSize,
        DEFAULT_USER_ANALYTICS_PAGE_SIZE,
        MAX_USER_ANALYTICS_PAGE_SIZE,
      ),
      sortBy: normalizeUserAnalyticsSortBy(sortBy),
      search: normalizeSearchTerm(search),
    };
  }

  function getSummary({ rangeDays } = {}) {
    const normalizedRangeDays = normalizeRangeDays(rangeDays);
    const cacheKey = summaryCacheKey(normalizedRangeDays);
    return getOrCompute(cacheKey, () => computeSummary(normalizedRangeDays));
  }

  function getUsers(params = {}) {
    const normalizedParams = normalizeUsersParams(params);
    const cacheKey = usersCacheKey(normalizedParams);
    return getOrCompute(cacheKey, () => computeUsers(normalizedParams));
  }

  function refreshOnce() {
    if (refreshAllRunning) return;
    refreshAllRunning = true;
    try {
      for (const rangeDays of warmRangeDays.map(normalizeRangeDays)) {
        writeCache(summaryCacheKey(rangeDays), computeSummary(rangeDays));
        const usersParams = normalizeUsersParams({ rangeDays });
        writeCache(usersCacheKey(usersParams), computeUsers(usersParams));
      }
    } catch (error) {
      logger?.warn?.('[Admin Analytics Cache] Scheduled refresh failed', {
        error: error?.message,
      });
    } finally {
      refreshAllRunning = false;
    }
  }

  function start() {
    if (interval) return;
    startupTimer = setTimeout(() => {
      startupTimer = null;
      refreshOnce();
    }, 0);
    interval = setIntervalFn(refreshOnce, refreshIntervalMs);
    interval?.unref?.();
  }

  function stop() {
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    if (!interval) return;
    clearIntervalFn(interval);
    interval = null;
  }

  return {
    getSummary,
    getUsers,
    refreshOnce,
    start,
    stop,
  };
}

export const adminAnalyticsCacheService = createAdminAnalyticsCacheService();
