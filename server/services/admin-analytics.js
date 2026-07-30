import { db as defaultDb } from '../database/db.js';

const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 90;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizePositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function normalizeRangeDays(value) {
  const normalized = normalizePositiveInteger(value, DEFAULT_RANGE_DAYS, MAX_RANGE_DAYS);
  return [7, 30, 90].includes(normalized) ? normalized : DEFAULT_RANGE_DAYS;
}

function normalizeSearch(value) {
  return typeof value === 'string' ? value.trim().slice(0, 100) : '';
}

function normalizeNow(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (value != null) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function toSqliteTimestamp(value) {
  return value.toISOString().slice(0, 19).replace('T', ' ');
}

function toShanghaiDateKey(value) {
  return new Date(value.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function shiftDateKey(dateKey, days) {
  const shifted = new Date(`${dateKey}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function getShanghaiWindow(now, rangeDays) {
  const shiftedNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const todayStart = new Date(Date.UTC(
    shiftedNow.getUTCFullYear(),
    shiftedNow.getUTCMonth(),
    shiftedNow.getUTCDate(),
  ) - SHANGHAI_OFFSET_MS);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
  const mauStart = new Date(tomorrowStart.getTime() - (30 * DAY_MS));
  const trendStart = new Date(tomorrowStart.getTime() - (rangeDays * DAY_MS));

  return {
    todayKey: toShanghaiDateKey(todayStart),
    todayStart,
    tomorrowStart,
    mauStart,
    trendStart,
  };
}

function readCount(database, sql, params = []) {
  return Number(database.prepare(sql).get(...params)?.count || 0);
}

function buildDailyNewUsers(database, { rangeDays, trendStart, tomorrowStart, todayKey }) {
  const rows = database.prepare(`
    SELECT date(created_at, '+8 hours') AS day, COUNT(*) AS count
    FROM users
    WHERE created_at >= ?
      AND created_at < ?
    GROUP BY date(created_at, '+8 hours')
  `).all(toSqliteTimestamp(trendStart), toSqliteTimestamp(tomorrowStart));
  const counts = new Map(rows.map((row) => [row.day, Number(row.count || 0)]));
  const firstDay = shiftDateKey(todayKey, -(rangeDays - 1));

  return Array.from({ length: rangeDays }, (_, index) => {
    const day = shiftDateKey(firstDay, index);
    return {
      day,
      count: counts.get(day) || 0,
    };
  });
}

function readTenantSessionRanking(database) {
  return database.prepare(`
    SELECT
      t.id AS tenantId,
      t.code AS tenantCode,
      t.name AS tenantName,
      t.status,
      (
        SELECT COUNT(DISTINCT tu.user_id)
        FROM tenant_users tu
        WHERE tu.tenant_id = t.id
          AND tu.status = 'active'
      ) AS userCount,
      (
        SELECT COUNT(*)
        FROM session_index si
        WHERE si.tenant_id = t.id
          AND si.status != 'deleted'
      ) AS sessionCount,
      (
        SELECT MAX(si.updated_at)
        FROM session_index si
        WHERE si.tenant_id = t.id
          AND si.status != 'deleted'
      ) AS lastActivityAt
    FROM tenants t
    ORDER BY sessionCount DESC,
      COALESCE(lastActivityAt, '') DESC,
      t.name COLLATE NOCASE ASC
    LIMIT 20
  `).all().map((row) => ({
    ...row,
    tenantId: Number(row.tenantId),
    userCount: Number(row.userCount || 0),
    sessionCount: Number(row.sessionCount || 0),
  }));
}

export function buildAdminAnalyticsSummary({
  database = defaultDb,
  rangeDays: rawRangeDays = DEFAULT_RANGE_DAYS,
  now: rawNow = null,
} = {}) {
  const rangeDays = normalizeRangeDays(rawRangeDays);
  const now = normalizeNow(rawNow);
  const window = getShanghaiWindow(now, rangeDays);
  const todayStart = toSqliteTimestamp(window.todayStart);
  const tomorrowStart = toSqliteTimestamp(window.tomorrowStart);
  const totalUsers = readCount(database, 'SELECT COUNT(*) AS count FROM users');
  const activeUsers = readCount(database, 'SELECT COUNT(*) AS count FROM users WHERE is_active = 1');
  const newUsersToday = readCount(database, `
    SELECT COUNT(*) AS count
    FROM users
    WHERE created_at >= ? AND created_at < ?
  `, [todayStart, tomorrowStart]);
  const dau = readCount(database, `
    SELECT COUNT(DISTINCT user_id) AS count
    FROM session_index
    WHERE status != 'deleted'
      AND updated_at >= ?
      AND updated_at < ?
  `, [todayStart, tomorrowStart]);
  const mau = readCount(database, `
    SELECT COUNT(DISTINCT user_id) AS count
    FROM session_index
    WHERE status != 'deleted'
      AND updated_at >= ?
      AND updated_at < ?
  `, [toSqliteTimestamp(window.mauStart), tomorrowStart]);
  const totalSessions = readCount(database, `
    SELECT COUNT(*) AS count
    FROM session_index
    WHERE status != 'deleted'
  `);
  const newSessionsToday = readCount(database, `
    SELECT COUNT(*) AS count
    FROM session_index
    WHERE status != 'deleted'
      AND created_at >= ?
      AND created_at < ?
  `, [todayStart, tomorrowStart]);

  return {
    range: {
      days: rangeDays,
      since: toSqliteTimestamp(window.trendStart),
      generatedAt: now.toISOString(),
      timeZone: 'Asia/Shanghai',
    },
    metrics: {
      totalUsers,
      activeUsers,
      newUsersToday,
      dau,
      mau,
      totalSessions,
      newSessionsToday,
    },
    dailyNewUsers: buildDailyNewUsers(database, {
      rangeDays,
      trendStart: window.trendStart,
      tomorrowStart: window.tomorrowStart,
      todayKey: window.todayKey,
    }),
    tenantSessionRanking: readTenantSessionRanking(database),
  };
}

export function buildAdminAnalyticsUsers({
  database = defaultDb,
  page: rawPage = 1,
  pageSize: rawPageSize = DEFAULT_PAGE_SIZE,
  search: rawSearch = '',
  now: rawNow = null,
} = {}) {
  const page = normalizePositiveInteger(rawPage, 1);
  const pageSize = normalizePositiveInteger(rawPageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const search = normalizeSearch(rawSearch);
  const searchLike = `%${search.toLowerCase()}%`;
  const searchSql = search
    ? `WHERE lower(u.username) LIKE ?
      OR EXISTS (
        SELECT 1
        FROM tenant_users tu_search
        JOIN tenants t_search ON t_search.id = tu_search.tenant_id
        WHERE tu_search.user_id = u.id
          AND lower(t_search.name) LIKE ?
      )`
    : '';
  const searchParams = search ? [searchLike, searchLike] : [];
  const total = readCount(database, `
    SELECT COUNT(*) AS count
    FROM users u
    ${searchSql}
  `, searchParams);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;
  const rows = database.prepare(`
    WITH session_stats AS (
      SELECT
        user_id,
        COUNT(*) AS sessionCount,
        MIN(created_at) AS firstSessionAt,
        MAX(created_at) AS lastSessionAt,
        MAX(updated_at) AS lastActivityAt
      FROM session_index
      WHERE status != 'deleted'
      GROUP BY user_id
    )
    SELECT
      u.id AS userId,
      u.username,
      u.is_active AS isActive,
      u.created_at AS userCreatedAt,
      u.last_login AS lastLoginAt,
      COALESCE(ss.sessionCount, 0) AS sessionCount,
      ss.firstSessionAt,
      ss.lastSessionAt,
      ss.lastActivityAt,
      (
        SELECT GROUP_CONCAT(t.name, ', ')
        FROM tenant_users tu
        JOIN tenants t ON t.id = tu.tenant_id
        WHERE tu.user_id = u.id
          AND tu.status = 'active'
      ) AS tenantNames
    FROM users u
    LEFT JOIN session_stats ss ON ss.user_id = u.id
    ${searchSql}
    ORDER BY sessionCount DESC,
      COALESCE(lastActivityAt, '') DESC,
      u.username COLLATE NOCASE ASC
    LIMIT ? OFFSET ?
  `).all(...searchParams, pageSize, offset).map((row) => ({
    ...row,
    userId: Number(row.userId),
    isActive: Boolean(row.isActive),
    sessionCount: Number(row.sessionCount || 0),
  }));
  const now = normalizeNow(rawNow);

  return {
    range: {
      scope: 'all_time',
      generatedAt: now.toISOString(),
      timeZone: 'Asia/Shanghai',
    },
    users: rows,
    pagination: {
      page: safePage,
      pageSize,
      total,
      totalPages,
      sortBy: 'sessionCount',
      sortDirection: 'desc',
      search,
    },
  };
}
