import { db } from '../database/db.js';

const DEFAULT_DAYS = 30;
const ALLOWED_DAY_WINDOWS = new Set([7, 30, 90]);
const MAX_TENANT_FILTERS = 100;

const TOKEN_USAGE_SQL = `
  CAST(COALESCE(
    json_extract(normalized_json, '$.usage.total_tokens'),
    json_extract(normalized_json, '$.usage.totalTokens'),
    json_extract(normalized_json, '$.usage.total_tokens_used'),
    (
      COALESCE(json_extract(normalized_json, '$.message.usage.input_tokens'), 0) +
      COALESCE(json_extract(normalized_json, '$.message.usage.output_tokens'), 0) +
      COALESCE(json_extract(normalized_json, '$.message.usage.cache_read_input_tokens'), 0) +
      COALESCE(json_extract(normalized_json, '$.message.usage.cache_creation_input_tokens'), 0) +
      COALESCE(json_extract(normalized_json, '$.data.message.usage.input_tokens'), 0) +
      COALESCE(json_extract(normalized_json, '$.data.message.usage.output_tokens'), 0) +
      COALESCE(json_extract(normalized_json, '$.data.message.usage.cache_read_input_tokens'), 0) +
      COALESCE(json_extract(normalized_json, '$.data.message.usage.cache_creation_input_tokens'), 0) +
      COALESCE(json_extract(normalized_json, '$.usage.input_tokens'), 0) +
      COALESCE(json_extract(normalized_json, '$.usage.output_tokens'), 0) +
      COALESCE(json_extract(normalized_json, '$.usage.cache_read_input_tokens'), 0) +
      COALESCE(json_extract(normalized_json, '$.usage.cache_creation_input_tokens'), 0)
    ),
    0
  ) AS INTEGER)
`;

function toInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeDays(days) {
  const parsed = Number(days);
  return ALLOWED_DAY_WINDOWS.has(parsed) ? parsed : DEFAULT_DAYS;
}

function normalizeTenantIds(value) {
  const input = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  const ids = [];
  const seen = new Set();

  for (const item of input) {
    const id = Number(item);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_TENANT_FILTERS) break;
  }

  return ids;
}

function dateWindowModifier(days) {
  return `-${Math.max(0, days - 1)} days`;
}

function tenantFilter(tenantIds, column = 'tenant_id') {
  if (!tenantIds.length) return { sql: '', params: [] };
  return {
    sql: ` AND ${column} IN (${tenantIds.map(() => '?').join(', ')})`,
    params: tenantIds,
  };
}

function userTenantJoin(tenantIds) {
  if (!tenantIds.length) return { join: '', where: '', params: [] };
  return {
    join: 'JOIN tenant_users tu_filter ON tu_filter.user_id = u.id',
    where: ` AND tu_filter.status = 'active' AND tu_filter.tenant_id IN (${tenantIds.map(() => '?').join(', ')})`,
    params: tenantIds,
  };
}

function countUsers(database, tenantIds, condition = '1 = 1') {
  const filter = userTenantJoin(tenantIds);
  return database.prepare(`
    SELECT COUNT(DISTINCT u.id) AS count
    FROM users u
    ${filter.join}
    WHERE ${condition}
      ${filter.where}
  `).get(...filter.params).count;
}

function createTenantOptions(database) {
  return database.prepare(`
    SELECT id AS tenantId, code, name, status
    FROM tenants
    ORDER BY code COLLATE NOCASE ASC
  `).all();
}

function scalar(database, sql, params = []) {
  return database.prepare(sql).get(...params)?.value ?? 0;
}

function createOverview(database, days, tenantIds) {
  const sessionFilter = tenantFilter(tenantIds, 'tenant_id');
  const messageFilter = tenantFilter(tenantIds, 'tenant_id');
  const runtimeFilter = tenantFilter(tenantIds, 'tenant_id');
  const workspaceFilter = tenantFilter(tenantIds, 'tenant_id');
  const tenantTableFilter = tenantFilter(tenantIds, 'id');
  const windowParam = `-${days} days`;

  const totalUsers = countUsers(database, tenantIds);
  const activeUsers = countUsers(database, tenantIds, 'u.is_active = 1');

  return {
    totalUsers,
    activeUsers,
    inactiveUsers: countUsers(database, tenantIds, 'u.is_active != 1'),
    systemAdmins: countUsers(database, tenantIds, 'u.is_system_admin = 1'),
    usersWithLogin: countUsers(database, tenantIds, 'u.last_login IS NOT NULL'),
    activeUsers7d: countUsers(database, tenantIds, "u.last_login >= datetime('now', '-7 days')"),
    activeUsers30d: countUsers(database, tenantIds, "u.last_login >= datetime('now', '-30 days')"),
    pendingInvites: countUsers(database, tenantIds, `u.is_active != 1 AND EXISTS (
      SELECT 1
      FROM user_invitations ui
      WHERE ui.user_id = u.id
        AND ui.accepted_at IS NULL
        AND ui.revoked_at IS NULL
        AND ui.expires_at > CURRENT_TIMESTAMP
    )`),
    expiredInvites: countUsers(database, tenantIds, `u.is_active != 1 AND EXISTS (
      SELECT 1
      FROM user_invitations ui
      WHERE ui.user_id = u.id
        AND ui.accepted_at IS NULL
        AND ui.revoked_at IS NULL
        AND ui.expires_at <= CURRENT_TIMESTAMP
    )`),
    totalTenants: scalar(database, `SELECT COUNT(*) AS value FROM tenants WHERE 1 = 1${tenantTableFilter.sql}`, tenantTableFilter.params),
    activeTenants: scalar(database, `SELECT COUNT(*) AS value FROM tenants WHERE status = 'active'${tenantTableFilter.sql}`, tenantTableFilter.params),
    activeMemberships: scalar(database, `SELECT COUNT(*) AS value FROM tenant_users WHERE status = 'active'${tenantFilter(tenantIds, 'tenant_id').sql}`, tenantIds),
    activeWorkspaces: scalar(database, `SELECT COUNT(*) AS value FROM workspaces WHERE status = 'active'${workspaceFilter.sql}`, workspaceFilter.params),
    totalWorkspaces: scalar(database, `SELECT COUNT(*) AS value FROM workspaces WHERE status != 'deleted'${workspaceFilter.sql}`, workspaceFilter.params),
    totalSessions: scalar(database, `SELECT COUNT(*) AS value FROM session_index WHERE status != 'deleted'${sessionFilter.sql}`, sessionFilter.params),
    sessions7d: scalar(database, `SELECT COUNT(*) AS value FROM session_index WHERE status != 'deleted' AND created_at >= datetime('now', '-7 days')${sessionFilter.sql}`, sessionFilter.params),
    sessions30d: scalar(database, `SELECT COUNT(*) AS value FROM session_index WHERE status != 'deleted' AND created_at >= datetime('now', '-30 days')${sessionFilter.sql}`, sessionFilter.params),
    sessionsInWindow: scalar(database, `SELECT COUNT(*) AS value FROM session_index WHERE status != 'deleted' AND created_at >= datetime('now', ?)${sessionFilter.sql}`, [windowParam, ...sessionFilter.params]),
    totalMessages: scalar(database, `SELECT COUNT(*) AS value FROM agent_session_messages WHERE 1 = 1${messageFilter.sql}`, messageFilter.params),
    messages7d: scalar(database, `SELECT COUNT(*) AS value FROM agent_session_messages WHERE created_at >= datetime('now', '-7 days')${messageFilter.sql}`, messageFilter.params),
    messages30d: scalar(database, `SELECT COUNT(*) AS value FROM agent_session_messages WHERE created_at >= datetime('now', '-30 days')${messageFilter.sql}`, messageFilter.params),
    messagesInWindow: scalar(database, `SELECT COUNT(*) AS value FROM agent_session_messages WHERE created_at >= datetime('now', ?)${messageFilter.sql}`, [windowParam, ...messageFilter.params]),
    userMessagesInWindow: scalar(database, `SELECT COUNT(*) AS value FROM agent_session_messages WHERE role = 'user' AND created_at >= datetime('now', ?)${messageFilter.sql}`, [windowParam, ...messageFilter.params]),
    assistantMessagesInWindow: scalar(database, `SELECT COUNT(*) AS value FROM agent_session_messages WHERE role = 'assistant' AND created_at >= datetime('now', ?)${messageFilter.sql}`, [windowParam, ...messageFilter.params]),
    systemMessagesInWindow: scalar(database, `SELECT COUNT(*) AS value FROM agent_session_messages WHERE role IS NULL AND created_at >= datetime('now', ?)${messageFilter.sql}`, [windowParam, ...messageFilter.params]),
    tokenCountInWindow: scalar(database, `SELECT COALESCE(SUM(${TOKEN_USAGE_SQL}), 0) AS value FROM agent_session_messages WHERE role = 'assistant' AND created_at >= datetime('now', ?)${messageFilter.sql}`, [windowParam, ...messageFilter.params]),
    activeDaysInWindow: scalar(database, `
      SELECT COUNT(DISTINCT day) AS value
      FROM (
        SELECT date(created_at) AS day
        FROM session_index
        WHERE status != 'deleted' AND created_at >= datetime('now', ?)${sessionFilter.sql}
        UNION
        SELECT date(created_at) AS day
        FROM agent_session_messages
        WHERE created_at >= datetime('now', ?)${messageFilter.sql}
      )
    `, [windowParam, ...sessionFilter.params, windowParam, ...messageFilter.params]),
    totalRuntimes: scalar(database, `SELECT COUNT(*) AS value FROM agent_session_runtime WHERE status != 'deleted'${runtimeFilter.sql}`, runtimeFilter.params),
    liveRuntimes: scalar(database, `SELECT COUNT(*) AS value FROM agent_session_runtime WHERE status IN ('active', 'idle', 'pending')${runtimeFilter.sql}`, runtimeFilter.params),
    failedRuntimes: scalar(database, `SELECT COUNT(*) AS value FROM agent_session_runtime WHERE status = 'failed'${runtimeFilter.sql}`, runtimeFilter.params),
    lastActivityAt: database.prepare(`
      SELECT MAX(activity_at) AS value
      FROM (
        SELECT MAX(updated_at) AS activity_at FROM session_index WHERE status != 'deleted'${sessionFilter.sql}
        UNION ALL
        SELECT MAX(created_at) AS activity_at FROM agent_session_messages WHERE 1 = 1${messageFilter.sql}
        UNION ALL
        SELECT MAX(last_used_at) AS activity_at FROM agent_session_runtime WHERE status != 'deleted'${runtimeFilter.sql}
      )
    `).get(...sessionFilter.params, ...messageFilter.params, ...runtimeFilter.params)?.value ?? null,
    activationRate: totalUsers > 0 ? activeUsers / totalUsers : 0,
  };
}

function createDailyActivity(database, days, tenantIds) {
  const sessionFilter = tenantFilter(tenantIds, 'tenant_id');
  const messageFilter = tenantFilter(tenantIds, 'tenant_id');

  return database.prepare(`
    WITH RECURSIVE days(day, step) AS (
      SELECT date('now', ?), 1
      UNION ALL
      SELECT date(day, '+1 day'), step + 1
      FROM days
      WHERE step < ?
    )
    SELECT
      day,
      (
        SELECT COUNT(DISTINCT u.id)
        FROM users u
        ${tenantIds.length ? 'JOIN tenant_users tu ON tu.user_id = u.id' : ''}
        WHERE date(u.created_at) = day
        ${tenantIds.length ? `AND tu.status = 'active' AND tu.tenant_id IN (${tenantIds.map(() => '?').join(', ')})` : ''}
      ) AS newUsers,
      (SELECT COUNT(*) FROM session_index WHERE status != 'deleted' AND date(created_at) = day${sessionFilter.sql}) AS sessions,
      (SELECT COUNT(*) FROM agent_session_messages WHERE date(created_at) = day${messageFilter.sql}) AS messages,
      (SELECT COUNT(*) FROM agent_session_messages WHERE role = 'user' AND date(created_at) = day${messageFilter.sql}) AS userMessages,
      (SELECT COUNT(*) FROM agent_session_messages WHERE role = 'assistant' AND date(created_at) = day${messageFilter.sql}) AS assistantMessages,
      (SELECT COUNT(*) FROM agent_session_messages WHERE role IS NULL AND date(created_at) = day${messageFilter.sql}) AS systemMessages,
      (SELECT COALESCE(SUM(${TOKEN_USAGE_SQL}), 0) FROM agent_session_messages WHERE role = 'assistant' AND date(created_at) = day${messageFilter.sql}) AS tokenCount,
      (SELECT COUNT(DISTINCT user_id) FROM session_index WHERE status != 'deleted' AND date(created_at) = day${sessionFilter.sql}) AS activeUsers
    FROM days
    ORDER BY day ASC
  `).all(
    dateWindowModifier(days),
    days,
    ...tenantIds,
    ...sessionFilter.params,
    ...messageFilter.params,
    ...messageFilter.params,
    ...messageFilter.params,
    ...messageFilter.params,
    ...messageFilter.params,
    ...sessionFilter.params,
  );
}

function createTopUsers(database, tenantIds) {
  const filter = userTenantJoin(tenantIds);
  const messageFilter = tenantFilter(tenantIds, 'asm.tenant_id');
  const sessionFilter = tenantFilter(tenantIds, 'si.tenant_id');
  const runtimeFilter = tenantFilter(tenantIds, 'r.tenant_id');
  const workspaceFilter = tenantFilter(tenantIds, 'w.tenant_id');

  return database.prepare(`
    SELECT
      u.id AS userId,
      u.username,
      u.is_active AS isActive,
      u.last_login AS lastLogin,
      (SELECT COUNT(*) FROM tenant_users tu WHERE tu.user_id = u.id AND tu.status = 'active') AS tenants,
      (SELECT COUNT(*) FROM workspaces w WHERE w.owner_user_id = u.id AND w.status != 'deleted'${workspaceFilter.sql}) AS ownedWorkspaces,
      (SELECT COUNT(*) FROM session_index si WHERE si.user_id = u.id AND si.status != 'deleted'${sessionFilter.sql}) AS sessions,
      (SELECT COUNT(*) FROM agent_session_messages asm WHERE asm.user_id = u.id${messageFilter.sql}) AS messages,
      (SELECT COUNT(*) FROM agent_session_messages asm WHERE asm.user_id = u.id AND asm.role = 'user'${messageFilter.sql}) AS userMessages,
      (SELECT COUNT(*) FROM agent_session_messages asm WHERE asm.user_id = u.id AND asm.role = 'assistant'${messageFilter.sql}) AS assistantMessages,
      (SELECT COUNT(*) FROM agent_session_messages asm WHERE asm.user_id = u.id AND asm.role IS NULL${messageFilter.sql}) AS systemMessages,
      (SELECT COALESCE(SUM(${TOKEN_USAGE_SQL}), 0) FROM agent_session_messages asm WHERE asm.user_id = u.id AND asm.role = 'assistant'${messageFilter.sql}) AS tokenCount,
      (
        SELECT COUNT(DISTINCT day)
        FROM (
          SELECT date(si.created_at) AS day FROM session_index si WHERE si.user_id = u.id AND si.status != 'deleted'${sessionFilter.sql}
          UNION
          SELECT date(asm.created_at) AS day FROM agent_session_messages asm WHERE asm.user_id = u.id${messageFilter.sql}
        )
      ) AS activeDays,
      (
        SELECT MAX(activity_at)
        FROM (
          SELECT MAX(si.updated_at) AS activity_at FROM session_index si WHERE si.user_id = u.id AND si.status != 'deleted'${sessionFilter.sql}
          UNION ALL
          SELECT MAX(asm.created_at) AS activity_at FROM agent_session_messages asm WHERE asm.user_id = u.id${messageFilter.sql}
          UNION ALL
          SELECT MAX(r.last_used_at) AS activity_at FROM agent_session_runtime r WHERE r.user_id = u.id AND r.status != 'deleted'${runtimeFilter.sql}
        )
      ) AS lastActivityAt
    FROM users u
    ${filter.join}
    WHERE 1 = 1
      ${filter.where}
    GROUP BY u.id
    ORDER BY tokenCount DESC, messages DESC, sessions DESC, lastActivityAt DESC, u.username COLLATE NOCASE ASC
    LIMIT 20
  `).all(
    ...workspaceFilter.params,
    ...sessionFilter.params,
    ...messageFilter.params,
    ...messageFilter.params,
    ...messageFilter.params,
    ...messageFilter.params,
    ...messageFilter.params,
    ...sessionFilter.params,
    ...messageFilter.params,
    ...sessionFilter.params,
    ...messageFilter.params,
    ...runtimeFilter.params,
    ...filter.params,
  );
}

function createTenantUsage(database, tenantIds) {
  const filter = tenantFilter(tenantIds, 't.id');

  return database.prepare(`
    SELECT
      t.id AS tenantId,
      t.code,
      t.name,
      t.status,
      (SELECT COUNT(*) FROM tenant_users tu WHERE tu.tenant_id = t.id AND tu.status = 'active') AS users,
      (SELECT COUNT(*) FROM workspaces w WHERE w.tenant_id = t.id AND w.status != 'deleted') AS workspaces,
      (SELECT COUNT(*) FROM session_index si WHERE si.tenant_id = t.id AND si.status != 'deleted') AS sessions,
      (SELECT COUNT(*) FROM agent_session_messages asm WHERE asm.tenant_id = t.id) AS messages,
      (SELECT COUNT(*) FROM agent_session_messages asm WHERE asm.tenant_id = t.id AND asm.role = 'user') AS userMessages,
      (SELECT COUNT(*) FROM agent_session_messages asm WHERE asm.tenant_id = t.id AND asm.role = 'assistant') AS assistantMessages,
      (SELECT COUNT(*) FROM agent_session_messages asm WHERE asm.tenant_id = t.id AND asm.role IS NULL) AS systemMessages,
      (SELECT COALESCE(SUM(${TOKEN_USAGE_SQL}), 0) FROM agent_session_messages asm WHERE asm.tenant_id = t.id AND asm.role = 'assistant') AS tokenCount,
      (
        SELECT COUNT(DISTINCT day)
        FROM (
          SELECT date(si.created_at) AS day FROM session_index si WHERE si.tenant_id = t.id AND si.status != 'deleted'
          UNION
          SELECT date(asm.created_at) AS day FROM agent_session_messages asm WHERE asm.tenant_id = t.id
        )
      ) AS activeDays,
      (SELECT COUNT(*) FROM agent_session_runtime r WHERE r.tenant_id = t.id AND r.status IN ('active', 'idle', 'pending')) AS liveRuntimes,
      (
        SELECT MAX(activity_at)
        FROM (
          SELECT MAX(si.updated_at) AS activity_at FROM session_index si WHERE si.tenant_id = t.id AND si.status != 'deleted'
          UNION ALL
          SELECT MAX(asm.created_at) AS activity_at FROM agent_session_messages asm WHERE asm.tenant_id = t.id
          UNION ALL
          SELECT MAX(r.last_used_at) AS activity_at FROM agent_session_runtime r WHERE r.tenant_id = t.id AND r.status != 'deleted'
        )
      ) AS lastActivityAt
    FROM tenants t
    WHERE 1 = 1${filter.sql}
    ORDER BY tokenCount DESC, messages DESC, sessions DESC, users DESC, t.code COLLATE NOCASE ASC
  `).all(...filter.params);
}

export function createPlatformAnalyticsService(database = db) {
  return {
    normalizeDays,
    normalizeTenantIds,

    getOverview: ({ days = DEFAULT_DAYS, tenantIds = [] } = {}) => {
      const normalizedDays = normalizeDays(days);
      const normalizedTenantIds = normalizeTenantIds(tenantIds);

      return {
        days: normalizedDays,
        selectedTenantIds: normalizedTenantIds,
        generatedAt: new Date().toISOString(),
        overview: createOverview(database, normalizedDays, normalizedTenantIds),
        tenantOptions: createTenantOptions(database),
        dailyActivity: createDailyActivity(database, normalizedDays, normalizedTenantIds),
        topUsers: createTopUsers(database, normalizedTenantIds),
        tenantUsage: createTenantUsage(database, normalizedTenantIds),
      };
    },
  };
}

export const platformAnalyticsService = createPlatformAnalyticsService(db);
