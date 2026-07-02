import { db as defaultDb } from '../database/db.js';

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

function buildRange(rangeDays) {
  const generatedAt = new Date();
  const since = new Date(generatedAt.getTime() - rangeDays * 24 * 60 * 60 * 1000);
  return {
    days: rangeDays,
    since: since.toISOString(),
    generatedAt: generatedAt.toISOString(),
  };
}

function emptyRetention() {
  return {
    cohortSize: 0,
    retained: 0,
    rate: null,
  };
}

function emptyOverall() {
  return {
    totalUsers: 0,
    activeUsers: 0,
    everActiveUsers: 0,
    totalTenants: 0,
    activeTenants: 0,
    totalWorkspaces: 0,
    activeWorkspaces: 0,
    totalSessionCount: 0,
    totalMessageCount: 0,
    userMessageCount: 0,
    systemMessageCount: 0,
    assistantMessageCount: 0,
    totalTokens: 0,
    tokenTrackedMessages: 0,
    tokenTrackingEnabled: false,
    totalErrorCount: 0,
    failedRuntimeCount: 0,
    failedSessionCount: 0,
    highRiskSqlCount: 0,
    assistantReplyCount: 0,
    answerReturnRate: null,
    averageMessagesPerSession: null,
    averageUserMessagesPerSession: null,
    messageUserCount: 0,
  };
}

function emptyKpis() {
  return {
    totalUsers: 0,
    activeUsers: 0,
    totalTenants: 0,
    activeTenants: 0,
    loginDau: 0,
    loginMau: 0,
    questionDau: 0,
    questionMau: 0,
    newLoginUsers: 0,
    newQuestionUsers: 0,
    churnedQuestionUsers: 0,
    questionCount: 0,
    sessionCount: 0,
    assistantReplyCount: 0,
    answerReturnRate: null,
    sqlGeneratedCount: 0,
    sqlGenerationRate: null,
    dataOpsSubmissionCount: null,
    dataOpsExecutionSuccessRate: null,
    endToEndSuccessRate: null,
    failedRuntimeCount: 0,
    noAssistantReplyCount: 0,
    highRiskSqlCount: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    tokenTrackedMessages: 0,
    tokenTrackingEnabled: false,
    retentionD1: null,
    retentionD7: null,
    retentionD30: null,
  };
}

function buildEmptySummary(rangeDays) {
  return {
    range: buildRange(rangeDays),
    cache: {
      updatedAt: null,
      intervalMinutes: REFRESH_INTERVAL_MINUTES,
      nextRefreshAt: null,
      unavailableReason: 'analytics_refresh_disabled',
    },
    overall: emptyOverall(),
    kpis: emptyKpis(),
    funnel: [],
    tenantDistribution: [],
    activeTenants: [],
    topUsers: [],
    highFrequencyQueries: [],
    highFailureQueries: [],
    failureReasons: [],
    retention: {
      d1: emptyRetention(),
      d7: emptyRetention(),
      d30: emptyRetention(),
    },
    dailyTrend: [],
    providerUsage: [],
    coverage: {
      loginHistory: 'disabled',
      questionEvents: false,
      sqlDetection: 'disabled',
      dataOpsEvents: false,
      tokenUsage: false,
    },
  };
}

function buildEmptyUsers({
  rangeDays,
  page,
  pageSize,
  sortBy,
  search,
}) {
  return {
    range: buildRange(rangeDays),
    cache: {
      updatedAt: null,
      intervalMinutes: REFRESH_INTERVAL_MINUTES,
      nextRefreshAt: null,
      unavailableReason: 'analytics_refresh_disabled',
    },
    users: [],
    pagination: {
      page,
      pageSize,
      total: 0,
      totalPages: 1,
      sortBy,
      sortDirection: 'desc',
      search,
    },
  };
}

export function createAdminAnalyticsCacheService({
  database = defaultDb,
  refreshIntervalMinutes = REFRESH_INTERVAL_MINUTES,
  warmRangeDays = WARM_RANGE_DAYS,
  logger = console,
} = {}) {
  database.exec(CACHE_TABLE_SQL);

  const refreshIntervalMs = refreshIntervalMinutes * 60 * 1000;

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

  function getCachedOrFallback(cacheKey, fallbackPayload) {
    const cached = readCache(cacheKey);
    if (cached) {
      const payload = withCacheMetadata(cached.payload, cached.row);
      if (isRowStale(cached.row.updated_at)) {
        return {
          ...payload,
          cache: {
            ...payload.cache,
            stale: true,
          },
        };
      }
      return payload;
    }

    return fallbackPayload;
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
    return getCachedOrFallback(cacheKey, buildEmptySummary(normalizedRangeDays));
  }

  function getUsers(params = {}) {
    const normalizedParams = normalizeUsersParams(params);
    const cacheKey = usersCacheKey(normalizedParams);
    return getCachedOrFallback(cacheKey, buildEmptyUsers(normalizedParams));
  }

  function refreshOnce() {
    logger?.warn?.('[Admin Analytics Cache] Refresh skipped because in-process analytics refresh is disabled', {
      warmRangeDays,
    });
  }

  function start() {
    logger?.info?.('[Admin Analytics Cache] In-process analytics refresh is disabled; serving cached data only');
  }

  function stop() {
    // No-op while in-process analytics refresh is disabled.
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
