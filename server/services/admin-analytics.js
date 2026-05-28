import { db as defaultDb } from '../database/db.js';

const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 365;
const DEFAULT_USER_ANALYTICS_PAGE_SIZE = 20;
const MAX_USER_ANALYTICS_PAGE_SIZE = 100;
const USER_ANALYTICS_SORT_COLUMNS = {
  sessionCount: 'sessionCount',
  userMessageCount: 'userMessageCount',
};
const SQL_LIKE_FILTER = `
  (
    lower(COALESCE(content_text, '')) LIKE '%select %'
    OR lower(COALESCE(content_text, '')) LIKE '%with %'
    OR lower(COALESCE(content_text, '')) LIKE '%\`\`\`sql%'
  )
`;
const HIGH_RISK_SQL_FILTER = `
  (
    lower(COALESCE(content_text, '')) LIKE '% delete %'
    OR lower(COALESCE(content_text, '')) LIKE 'delete %'
    OR lower(COALESCE(content_text, '')) LIKE '% drop %'
    OR lower(COALESCE(content_text, '')) LIKE 'drop %'
    OR lower(COALESCE(content_text, '')) LIKE '% update %'
    OR lower(COALESCE(content_text, '')) LIKE 'update %'
    OR lower(COALESCE(content_text, '')) LIKE '%select *%'
  )
`;

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
  return Object.hasOwn(USER_ANALYTICS_SORT_COLUMNS, value)
    ? value
    : 'sessionCount';
}

function normalizeSearchTerm(value) {
  const normalized = String(value ?? '').trim();
  return normalized.length > 128 ? normalized.slice(0, 128) : normalized;
}

function readCount(database, sql, params = []) {
  const row = database.prepare(sql).get(...params);
  return Number(row?.count || 0);
}

function round(value, precision = 1) {
  if (value == null || !Number.isFinite(value)) return null;
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

function percentage(part, total) {
  if (!total) return null;
  return round((part / total) * 100, 1);
}

function toIsoDateKey(value) {
  if (typeof value !== 'string' || !value) return null;
  return value.slice(0, 10);
}

function shiftDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildDateBuckets(todayKey, days) {
  return Array.from({ length: days }, (_, index) => shiftDateKey(todayKey, index - days + 1));
}

function indexRowsByDay(rows, fieldName) {
  const indexed = new Map();
  for (const row of rows) {
    indexed.set(row.day, Number(row[fieldName] || 0));
  }
  return indexed;
}

function readDailyTrend(database, rangeDays, todayKey) {
  const chartModifier = `-${Math.max(rangeDays - 1, 0)} days`;
  const questionRows = database.prepare(`
    SELECT
      date(created_at) AS day,
      COUNT(*) AS question_count,
      COUNT(DISTINCT user_id) AS question_users
    FROM agent_session_messages
    WHERE role = 'user'
      AND COALESCE(content_text, '') != ''
      AND date(created_at) >= date('now', ?)
    GROUP BY date(created_at)
  `).all(chartModifier);
  const loginRows = database.prepare(`
    SELECT date(last_login) AS day, COUNT(DISTINCT id) AS login_users
    FROM users
    WHERE last_login IS NOT NULL
      AND date(last_login) >= date('now', ?)
    GROUP BY date(last_login)
  `).all(chartModifier);
  const sqlRows = database.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS sql_count
    FROM agent_session_messages
    WHERE role = 'assistant'
      AND date(created_at) >= date('now', ?)
      AND ${SQL_LIKE_FILTER}
    GROUP BY date(created_at)
  `).all(chartModifier);
  const sessionRows = database.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS session_count
    FROM session_index
    WHERE status != 'deleted'
      AND date(created_at) >= date('now', ?)
    GROUP BY date(created_at)
  `).all(chartModifier);

  const questionCounts = indexRowsByDay(questionRows, 'question_count');
  const questionUsers = indexRowsByDay(questionRows, 'question_users');
  const loginUsers = indexRowsByDay(loginRows, 'login_users');
  const sqlCounts = indexRowsByDay(sqlRows, 'sql_count');
  const sessionCounts = indexRowsByDay(sessionRows, 'session_count');

  return buildDateBuckets(todayKey, rangeDays).map((day) => ({
    day,
    loginUsers: loginUsers.get(day) || 0,
    questionUsers: questionUsers.get(day) || 0,
    questionCount: questionCounts.get(day) || 0,
    sqlGeneratedCount: sqlCounts.get(day) || 0,
    sessionCount: sessionCounts.get(day) || 0,
  }));
}

function readQuestionRetention(database, rangeDays, todayKey) {
  const rows = database.prepare(`
    SELECT user_id, date(created_at) AS day
    FROM agent_session_messages
    WHERE role = 'user'
      AND COALESCE(content_text, '') != ''
    GROUP BY user_id, date(created_at)
  `).all();

  const activityByUser = new Map();
  for (const row of rows) {
    if (!activityByUser.has(row.user_id)) {
      activityByUser.set(row.user_id, new Set());
    }
    activityByUser.get(row.user_id).add(row.day);
  }

  const firstDayByUser = new Map();
  for (const [userId, days] of activityByUser.entries()) {
    firstDayByUser.set(userId, Array.from(days).sort()[0]);
  }

  const buildRetention = (daysAfterFirstQuestion) => {
    const cohortStart = shiftDateKey(todayKey, -(rangeDays + daysAfterFirstQuestion));
    const cohortEnd = shiftDateKey(todayKey, -daysAfterFirstQuestion);
    let cohortSize = 0;
    let retained = 0;

    for (const [userId, firstDay] of firstDayByUser.entries()) {
      if (firstDay < cohortStart || firstDay > cohortEnd) {
        continue;
      }

      cohortSize += 1;
      if (activityByUser.get(userId)?.has(shiftDateKey(firstDay, daysAfterFirstQuestion))) {
        retained += 1;
      }
    }

    return {
      cohortSize,
      retained,
      rate: percentage(retained, cohortSize),
    };
  };

  return {
    d1: buildRetention(1),
    d7: buildRetention(7),
    d30: buildRetention(30),
  };
}

function readQuestionChurn(database, rangeDays) {
  const currentModifier = `-${rangeDays} days`;
  const previousModifier = `-${rangeDays * 2} days`;
  const currentRows = database.prepare(`
    SELECT DISTINCT user_id
    FROM agent_session_messages
    WHERE role = 'user'
      AND COALESCE(content_text, '') != ''
      AND created_at >= datetime('now', ?)
  `).all(currentModifier);
  const previousRows = database.prepare(`
    SELECT DISTINCT user_id
    FROM agent_session_messages
    WHERE role = 'user'
      AND COALESCE(content_text, '') != ''
      AND created_at >= datetime('now', ?)
      AND created_at < datetime('now', ?)
  `).all(previousModifier, currentModifier);
  const currentUsers = new Set(currentRows.map((row) => row.user_id));
  return previousRows.filter((row) => !currentUsers.has(row.user_id)).length;
}

function extractUsageFromMessage(message) {
  const usage = message?.usage || message?.message?.usage || message?.tokenUsage;
  if (usage && typeof usage === 'object') {
    const inputTokens = Number(
      usage.input_tokens
        ?? usage.inputTokens
        ?? usage.prompt_tokens
        ?? usage.promptTokens
        ?? 0,
    ) || 0;
    const outputTokens = Number(
      usage.output_tokens
        ?? usage.outputTokens
        ?? usage.completion_tokens
        ?? usage.completionTokens
        ?? 0,
    ) || 0;
    const cacheTokens = Number(
      usage.cache_read_input_tokens
        ?? usage.cacheReadTokens
        ?? 0,
    ) + Number(
      usage.cache_creation_input_tokens
        ?? usage.cacheCreationTokens
        ?? 0,
    );
    const totalTokens = Number(
      usage.total_tokens
        ?? usage.totalTokens
        ?? usage.used
        ?? 0,
    ) || inputTokens + outputTokens + (Number.isFinite(cacheTokens) ? cacheTokens : 0);
    const cumulativeTotalTokens = Number(
      usage.cumulativeTotalTokens
        ?? usage.cumulative_total_tokens
        ?? usage.cumulativeUsed
        ?? 0,
    ) || 0;

    if (totalTokens === 0 && cumulativeTotalTokens > 0) {
      return {
        source: 'budget',
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        totalTokens: cumulativeTotalTokens,
      };
    }
    if (totalTokens === 0) {
      return null;
    }

    return {
      source: 'usage',
      inputTokens,
      outputTokens,
      cacheTokens: Number.isFinite(cacheTokens) ? cacheTokens : 0,
      totalTokens,
    };
  }

  const budget = message?.tokenBudget;
  if (budget && typeof budget === 'object') {
    const totalTokens = Number(
      budget.used
        ?? budget.totalUsed
        ?? budget.total_tokens
        ?? budget.totalTokens
        ?? 0,
    ) || 0;

    if (totalTokens > 0) {
      return {
        source: 'budget',
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        totalTokens,
      };
    }
  }

  return null;
}

function readTokenUsage(database, rangeModifier) {
  const dateFilter = rangeModifier ? 'created_at >= datetime(\'now\', ?) AND' : '';
  const params = rangeModifier ? [rangeModifier] : [];
  const rows = database.prepare(`
    SELECT
      runtime_id,
      provider,
      provider_session_id,
      normalized_json
    FROM agent_session_messages
    WHERE ${dateFilter}
      (
        normalized_json LIKE '%usage%'
        OR normalized_json LIKE '%tokenUsage%'
        OR normalized_json LIKE '%tokenBudget%'
      )
  `).all(...params);
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    trackedMessages: 0,
  };
  const budgetOnlyBySession = new Map();

  for (const row of rows) {
    try {
      const usage = extractUsageFromMessage(JSON.parse(row.normalized_json));
      if (!usage) continue;
      if (usage.source === 'budget') {
        const key = `${row.provider}:${row.provider_session_id || row.runtime_id}`;
        const previous = budgetOnlyBySession.get(key) || 0;
        budgetOnlyBySession.set(key, Math.max(previous, usage.totalTokens));
      } else {
        totals.inputTokens += usage.inputTokens;
        totals.outputTokens += usage.outputTokens;
        totals.cacheTokens += usage.cacheTokens;
        totals.totalTokens += usage.totalTokens;
        totals.trackedMessages += 1;
      }
    } catch {
      // Ignore malformed historical rows.
    }
  }

  for (const totalTokens of budgetOnlyBySession.values()) {
    totals.totalTokens += totalTokens;
    totals.trackedMessages += 1;
  }

  if (totals.totalTokens === 0) {
    totals.totalTokens = totals.inputTokens + totals.outputTokens + totals.cacheTokens;
  }
  return {
    ...totals,
    isTracked: totals.trackedMessages > 0,
  };
}

function readTenantDistribution(database, rangeModifier) {
  return database.prepare(`
    SELECT
      t.id AS tenantId,
      t.code AS tenantCode,
      t.name AS tenantName,
      t.status AS status,
      (
        SELECT COUNT(DISTINCT tu.user_id)
        FROM tenant_users tu
        WHERE tu.tenant_id = t.id
          AND tu.status = 'active'
      ) AS totalUsers,
      (
        SELECT COUNT(DISTINCT tu.user_id)
        FROM tenant_users tu
        JOIN users u ON u.id = tu.user_id
        WHERE tu.tenant_id = t.id
          AND tu.status = 'active'
          AND u.is_active = 1
      ) AS activeUsers,
      (
        SELECT COUNT(DISTINCT m.user_id)
        FROM agent_session_messages m
        WHERE m.tenant_id = t.id
          AND m.role = 'user'
          AND COALESCE(m.content_text, '') != ''
          AND m.created_at >= datetime('now', ?)
      ) AS questionUsers,
      (
        SELECT COUNT(*)
        FROM agent_session_messages m
        WHERE m.tenant_id = t.id
          AND m.role = 'user'
          AND COALESCE(m.content_text, '') != ''
          AND m.created_at >= datetime('now', ?)
      ) AS questionCount,
      (
        SELECT COUNT(*)
        FROM session_index si
        WHERE si.tenant_id = t.id
          AND si.status != 'deleted'
          AND si.created_at >= datetime('now', ?)
      ) AS sessionCount
    FROM tenants t
    ORDER BY questionCount DESC, activeUsers DESC, t.name COLLATE NOCASE ASC
  `).all(rangeModifier, rangeModifier, rangeModifier).map((row) => ({
    ...row,
    totalUsers: Number(row.totalUsers || 0),
    activeUsers: Number(row.activeUsers || 0),
    questionUsers: Number(row.questionUsers || 0),
    questionCount: Number(row.questionCount || 0),
    sessionCount: Number(row.sessionCount || 0),
  }));
}

function readTopUsers(database, rangeModifier) {
  return database.prepare(`
    SELECT
      u.id AS userId,
      u.username,
      u.last_login AS lastLoginAt,
      (
        SELECT COUNT(*)
        FROM agent_session_messages m
        WHERE m.user_id = u.id
          AND m.role = 'user'
          AND COALESCE(m.content_text, '') != ''
          AND m.created_at >= datetime('now', ?)
      ) AS questionCount,
      (
        SELECT COUNT(*)
        FROM session_index si
        WHERE si.user_id = u.id
          AND si.status != 'deleted'
          AND si.created_at >= datetime('now', ?)
      ) AS sessionCount,
      (
        SELECT MAX(m.created_at)
        FROM agent_session_messages m
        WHERE m.user_id = u.id
          AND m.role = 'user'
          AND COALESCE(m.content_text, '') != ''
      ) AS lastQuestionAt,
      (
        SELECT GROUP_CONCAT(t.name, ', ')
        FROM tenant_users tu
        JOIN tenants t ON t.id = tu.tenant_id
        WHERE tu.user_id = u.id
          AND tu.status = 'active'
      ) AS tenantNames
    FROM users u
    ORDER BY questionCount DESC, sessionCount DESC, u.username COLLATE NOCASE ASC
    LIMIT 10
  `).all(rangeModifier, rangeModifier).map((row) => ({
    ...row,
    questionCount: Number(row.questionCount || 0),
    sessionCount: Number(row.sessionCount || 0),
  }));
}

function readTokenUsageByUser(database, rangeModifier, userIds) {
  if (!userIds.length) {
    return new Map();
  }

  const placeholders = userIds.map(() => '?').join(', ');
  const rows = database.prepare(`
    SELECT
      user_id,
      runtime_id,
      provider,
      provider_session_id,
      normalized_json
    FROM agent_session_messages
    WHERE user_id IN (${placeholders})
      AND created_at >= datetime('now', ?)
      AND (
        normalized_json LIKE '%usage%'
        OR normalized_json LIKE '%tokenUsage%'
        OR normalized_json LIKE '%tokenBudget%'
      )
  `).all(...userIds, rangeModifier);
  const totalsByUser = new Map();
  const budgetOnlyBySession = new Map();

  const ensureTotals = (userId) => {
    const normalizedUserId = Number(userId);
    if (!totalsByUser.has(normalizedUserId)) {
      totalsByUser.set(normalizedUserId, {
        totalTokens: 0,
        trackedMessages: 0,
      });
    }
    return totalsByUser.get(normalizedUserId);
  };

  for (const row of rows) {
    try {
      const usage = extractUsageFromMessage(JSON.parse(row.normalized_json));
      if (!usage) continue;

      const userId = Number(row.user_id);
      if (usage.source === 'budget') {
        const key = `${userId}:${row.provider}:${row.provider_session_id || row.runtime_id}`;
        const previous = budgetOnlyBySession.get(key);
        if (!previous || usage.totalTokens > previous.totalTokens) {
          budgetOnlyBySession.set(key, {
            userId,
            totalTokens: usage.totalTokens,
          });
        }
        continue;
      }

      const totals = ensureTotals(userId);
      totals.totalTokens += usage.totalTokens;
      totals.trackedMessages += 1;
    } catch {
      // Ignore malformed historical rows.
    }
  }

  for (const entry of budgetOnlyBySession.values()) {
    const totals = ensureTotals(entry.userId);
    totals.totalTokens += entry.totalTokens;
    totals.trackedMessages += 1;
  }

  return totalsByUser;
}

function buildUserSearchFilter(search) {
  if (!search) {
    return {
      sql: '',
      params: [],
    };
  }

  const likeSearch = `%${search.toLowerCase()}%`;
  return {
    sql: `
      WHERE (
        lower(u.username) LIKE ?
        OR CAST(u.id AS TEXT) LIKE ?
      )
    `,
    params: [likeSearch, likeSearch],
  };
}

function readAnalyticsUsers(database, {
  rangeModifier,
  page,
  pageSize,
  search,
  sortBy,
}) {
  const searchFilter = buildUserSearchFilter(search);
  const total = readCount(database, `
    SELECT COUNT(*) AS count
    FROM users u
    ${searchFilter.sql}
  `, searchFilter.params);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;
  const sortColumn = USER_ANALYTICS_SORT_COLUMNS[sortBy];
  const secondarySortColumn = sortBy === 'sessionCount'
    ? USER_ANALYTICS_SORT_COLUMNS.userMessageCount
    : USER_ANALYTICS_SORT_COLUMNS.sessionCount;

  const rows = database.prepare(`
    WITH message_stats AS (
      SELECT
        user_id,
        COUNT(*) AS totalMessageCount,
        SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS userMessageCount,
        SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS assistantMessageCount,
        SUM(CASE WHEN role = 'system' OR role IS NULL THEN 1 ELSE 0 END) AS systemMessageCount
      FROM agent_session_messages
      WHERE created_at >= datetime('now', ?)
      GROUP BY user_id
    ),
    session_stats AS (
      SELECT
        user_id,
        COUNT(*) AS sessionCount
      FROM session_index
      WHERE status != 'deleted'
        AND created_at >= datetime('now', ?)
      GROUP BY user_id
    ),
    message_bounds AS (
      SELECT
        user_id,
        MIN(created_at) AS firstMessageAt,
        MAX(created_at) AS lastMessageAt
      FROM agent_session_messages
      GROUP BY user_id
    ),
    session_bounds AS (
      SELECT
        user_id,
        MIN(created_at) AS firstSessionAt,
        MAX(created_at) AS lastSessionAt
      FROM session_index
      WHERE status != 'deleted'
      GROUP BY user_id
    ),
    active_day_inputs AS (
      SELECT user_id, date(created_at) AS day
      FROM agent_session_messages
      WHERE created_at >= datetime('now', ?)
      UNION
      SELECT user_id, date(created_at) AS day
      FROM session_index
      WHERE status != 'deleted'
        AND created_at >= datetime('now', ?)
    ),
    active_days AS (
      SELECT user_id, COUNT(DISTINCT day) AS activeDays
      FROM active_day_inputs
      GROUP BY user_id
    )
    SELECT
      u.id AS userId,
      u.username,
      u.created_at AS userCreatedAt,
      u.last_login AS lastLoginAt,
      COALESCE(ss.sessionCount, 0) AS sessionCount,
      COALESCE(ms.totalMessageCount, 0) AS totalMessageCount,
      COALESCE(ms.userMessageCount, 0) AS userMessageCount,
      COALESCE(ms.systemMessageCount, 0) AS systemMessageCount,
      COALESCE(ms.assistantMessageCount, 0) AS assistantMessageCount,
      COALESCE(ad.activeDays, 0) AS activeDays,
      CASE
        WHEN mb.firstMessageAt IS NULL THEN sb.firstSessionAt
        WHEN sb.firstSessionAt IS NULL THEN mb.firstMessageAt
        WHEN mb.firstMessageAt <= sb.firstSessionAt THEN mb.firstMessageAt
        ELSE sb.firstSessionAt
      END AS firstUsedAt,
      CASE
        WHEN mb.lastMessageAt IS NULL THEN sb.lastSessionAt
        WHEN sb.lastSessionAt IS NULL THEN mb.lastMessageAt
        WHEN mb.lastMessageAt >= sb.lastSessionAt THEN mb.lastMessageAt
        ELSE sb.lastSessionAt
      END AS lastUsedAt,
      (
        SELECT GROUP_CONCAT(t.name, ', ')
        FROM tenant_users tu
        JOIN tenants t ON t.id = tu.tenant_id
        WHERE tu.user_id = u.id
          AND tu.status = 'active'
      ) AS tenantNames
    FROM users u
    LEFT JOIN message_stats ms ON ms.user_id = u.id
    LEFT JOIN session_stats ss ON ss.user_id = u.id
    LEFT JOIN message_bounds mb ON mb.user_id = u.id
    LEFT JOIN session_bounds sb ON sb.user_id = u.id
    LEFT JOIN active_days ad ON ad.user_id = u.id
    ${searchFilter.sql}
    ORDER BY ${sortColumn} DESC,
      ${secondarySortColumn} DESC,
      totalMessageCount DESC,
      u.username COLLATE NOCASE ASC
    LIMIT ? OFFSET ?
  `).all(
    rangeModifier,
    rangeModifier,
    rangeModifier,
    rangeModifier,
    ...searchFilter.params,
    pageSize,
    offset,
  );
  const tokenUsageByUser = readTokenUsageByUser(
    database,
    rangeModifier,
    rows.map((row) => Number(row.userId)),
  );

  return {
    rows: rows.map((row) => {
      const tokenUsage = tokenUsageByUser.get(Number(row.userId));
      return {
        ...row,
        userId: Number(row.userId),
        sessionCount: Number(row.sessionCount || 0),
        totalMessageCount: Number(row.totalMessageCount || 0),
        userMessageCount: Number(row.userMessageCount || 0),
        systemMessageCount: Number(row.systemMessageCount || 0),
        assistantMessageCount: Number(row.assistantMessageCount || 0),
        tokenCount: Number(tokenUsage?.totalTokens || 0),
        tokenTrackedMessages: Number(tokenUsage?.trackedMessages || 0),
        activeDays: Number(row.activeDays || 0),
      };
    }),
    page: safePage,
    pageSize,
    total,
    totalPages,
  };
}

function readHighFrequencyQueries(database, rangeModifier) {
  return database.prepare(`
    SELECT
      lower(trim(content_text)) AS queryKey,
      MIN(content_text) AS query,
      COUNT(*) AS count,
      COUNT(DISTINCT user_id) AS users,
      MAX(created_at) AS lastAskedAt
    FROM agent_session_messages
    WHERE role = 'user'
      AND COALESCE(content_text, '') != ''
      AND created_at >= datetime('now', ?)
    GROUP BY lower(trim(content_text))
    ORDER BY count DESC, users DESC, lastAskedAt DESC
    LIMIT 10
  `).all(rangeModifier).map((row) => ({
    queryKey: row.queryKey,
    query: row.query,
    count: Number(row.count || 0),
    users: Number(row.users || 0),
    lastAskedAt: row.lastAskedAt,
  }));
}

function readHighFailureQueries(database, rangeModifier) {
  return database.prepare(`
    SELECT
      lower(trim(m.content_text)) AS queryKey,
      MIN(m.content_text) AS query,
      COUNT(*) AS count,
      COUNT(DISTINCT m.user_id) AS users,
      MAX(m.created_at) AS lastFailedAt,
      'runtime_failed' AS reason
    FROM agent_session_messages m
    JOIN agent_session_runtime r ON r.runtime_id = m.runtime_id
    WHERE m.role = 'user'
      AND COALESCE(m.content_text, '') != ''
      AND m.created_at >= datetime('now', ?)
      AND r.status = 'failed'
    GROUP BY lower(trim(m.content_text))
    ORDER BY count DESC, users DESC, lastFailedAt DESC
    LIMIT 10
  `).all(rangeModifier).map((row) => ({
    queryKey: row.queryKey,
    query: row.query,
    count: Number(row.count || 0),
    users: Number(row.users || 0),
    lastFailedAt: row.lastFailedAt,
    reason: row.reason,
  }));
}

function readProviderUsage(database, rangeModifier) {
  const sessionRows = database.prepare(`
    SELECT provider, COUNT(*) AS session_count, COUNT(DISTINCT user_id) AS users
    FROM session_index
    WHERE status != 'deleted'
      AND created_at >= datetime('now', ?)
    GROUP BY provider
  `).all(rangeModifier);
  const questionRows = database.prepare(`
    SELECT provider, COUNT(*) AS question_count
    FROM agent_session_messages
    WHERE role = 'user'
      AND COALESCE(content_text, '') != ''
      AND created_at >= datetime('now', ?)
    GROUP BY provider
  `).all(rangeModifier);
  const byProvider = new Map();

  for (const row of sessionRows) {
    byProvider.set(row.provider, {
      provider: row.provider,
      sessionCount: Number(row.session_count || 0),
      questionCount: 0,
      users: Number(row.users || 0),
    });
  }
  for (const row of questionRows) {
    const entry = byProvider.get(row.provider) || {
      provider: row.provider,
      sessionCount: 0,
      questionCount: 0,
      users: 0,
    };
    entry.questionCount = Number(row.question_count || 0);
    byProvider.set(row.provider, entry);
  }

  return Array.from(byProvider.values()).sort((left, right) => (
    right.questionCount - left.questionCount || right.sessionCount - left.sessionCount
  ));
}

function readFirstQuestionUsers(database, rangeModifier) {
  return readCount(database, `
    SELECT COUNT(*) AS count
    FROM (
      SELECT user_id, MIN(created_at) AS first_question_at
      FROM agent_session_messages
      WHERE role = 'user'
        AND COALESCE(content_text, '') != ''
      GROUP BY user_id
    ) first_questions
    WHERE first_question_at >= datetime('now', ?)
  `, [rangeModifier]);
}

function readAssistantReplyCount(database, rangeModifier = null) {
  const dateFilter = rangeModifier ? 'AND user_message.created_at >= datetime(\'now\', ?)' : '';
  const params = rangeModifier ? [rangeModifier] : [];
  return readCount(database, `
    SELECT COUNT(*) AS count
    FROM agent_session_messages user_message
    WHERE user_message.role = 'user'
      AND COALESCE(user_message.content_text, '') != ''
      ${dateFilter}
      AND EXISTS (
        SELECT 1
        FROM agent_session_messages assistant_message
        WHERE assistant_message.runtime_id = user_message.runtime_id
          AND assistant_message.role = 'assistant'
          AND assistant_message.sequence > user_message.sequence
        LIMIT 1
      )
  `, params);
}

function readOverallMetrics(database) {
  const messageStats = database.prepare(`
    SELECT
      COUNT(*) AS totalMessageCount,
      SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS userMessageCount,
      SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS assistantMessageCount,
      SUM(CASE WHEN role = 'system' OR role IS NULL THEN 1 ELSE 0 END) AS systemMessageCount,
      COUNT(DISTINCT user_id) AS messageUserCount
    FROM agent_session_messages
  `).get();
  const totalSessionCount = readCount(database, `
    SELECT COUNT(*) AS count
    FROM session_index
    WHERE status != 'deleted'
  `);
  const totalUserMessageCount = Number(messageStats?.userMessageCount || 0);
  const questionLikeMessageCount = readCount(database, `
    SELECT COUNT(*) AS count
    FROM agent_session_messages
    WHERE role = 'user'
      AND COALESCE(content_text, '') != ''
  `);
  const assistantReplyCount = readAssistantReplyCount(database);
  const failedRuntimeCount = readCount(database, `
    SELECT COUNT(*) AS count
    FROM agent_session_runtime
    WHERE status = 'failed'
  `);
  const failedSessionCount = readCount(database, `
    SELECT COUNT(*) AS count
    FROM session_index
    WHERE status IN ('failed', 'aborted')
  `);
  const tokenUsage = readTokenUsage(database);
  const totalMessageCount = Number(messageStats?.totalMessageCount || 0);

  return {
    totalUsers: readCount(database, 'SELECT COUNT(*) AS count FROM users'),
    activeUsers: readCount(database, 'SELECT COUNT(*) AS count FROM users WHERE is_active = 1'),
    everActiveUsers: readCount(database, `
      SELECT COUNT(DISTINCT user_id) AS count
      FROM (
        SELECT user_id FROM agent_session_messages
        UNION
        SELECT user_id FROM session_index WHERE status != 'deleted'
      )
    `),
    totalTenants: readCount(database, 'SELECT COUNT(*) AS count FROM tenants'),
    activeTenants: readCount(database, "SELECT COUNT(*) AS count FROM tenants WHERE status = 'active'"),
    totalWorkspaces: readCount(database, "SELECT COUNT(*) AS count FROM workspaces WHERE status != 'deleted'"),
    activeWorkspaces: readCount(database, "SELECT COUNT(*) AS count FROM workspaces WHERE status = 'active'"),
    totalSessionCount,
    totalMessageCount,
    userMessageCount: totalUserMessageCount,
    systemMessageCount: Number(messageStats?.systemMessageCount || 0),
    assistantMessageCount: Number(messageStats?.assistantMessageCount || 0),
    totalTokens: tokenUsage.totalTokens,
    tokenTrackedMessages: tokenUsage.trackedMessages,
    tokenTrackingEnabled: tokenUsage.isTracked,
    totalErrorCount: failedRuntimeCount + failedSessionCount,
    failedRuntimeCount,
    failedSessionCount,
    highRiskSqlCount: readCount(database, `
      SELECT COUNT(*) AS count
      FROM agent_session_messages
      WHERE role = 'assistant'
        AND ${HIGH_RISK_SQL_FILTER}
    `),
    assistantReplyCount,
    answerReturnRate: percentage(assistantReplyCount, questionLikeMessageCount),
    averageMessagesPerSession: totalSessionCount ? round(totalMessageCount / totalSessionCount, 1) : null,
    averageUserMessagesPerSession: totalSessionCount ? round(totalUserMessageCount / totalSessionCount, 1) : null,
    messageUserCount: Number(messageStats?.messageUserCount || 0),
  };
}

export function buildAdminAnalyticsUsers({
  database = defaultDb,
  rangeDays: rawRangeDays = DEFAULT_RANGE_DAYS,
  page: rawPage = 1,
  pageSize: rawPageSize = DEFAULT_USER_ANALYTICS_PAGE_SIZE,
  sortBy: rawSortBy = 'sessionCount',
  search: rawSearch = '',
} = {}) {
  const rangeDays = normalizeRangeDays(rawRangeDays);
  const rangeModifier = `-${rangeDays} days`;
  const page = normalizePositiveInteger(rawPage, 1);
  const pageSize = normalizePositiveInteger(
    rawPageSize,
    DEFAULT_USER_ANALYTICS_PAGE_SIZE,
    MAX_USER_ANALYTICS_PAGE_SIZE,
  );
  const sortBy = normalizeUserAnalyticsSortBy(rawSortBy);
  const search = normalizeSearchTerm(rawSearch);
  const meta = database.prepare(`
    SELECT
      datetime('now') AS generatedAt,
      datetime('now', ?) AS since
  `).get(rangeModifier);
  const result = readAnalyticsUsers(database, {
    rangeModifier,
    page,
    pageSize,
    search,
    sortBy,
  });

  return {
    range: {
      days: rangeDays,
      since: meta.since,
      generatedAt: meta.generatedAt,
    },
    users: result.rows,
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
      sortBy,
      sortDirection: 'desc',
      search,
    },
  };
}

export function buildAdminAnalyticsSummary({
  database = defaultDb,
  rangeDays: rawRangeDays = DEFAULT_RANGE_DAYS,
} = {}) {
  const rangeDays = normalizeRangeDays(rawRangeDays);
  const rangeModifier = `-${rangeDays} days`;
  const meta = database.prepare(`
    SELECT
      datetime('now') AS generatedAt,
      datetime('now', ?) AS since,
      date('now') AS today
  `).get(rangeModifier);
  const questionCount = readCount(database, `
    SELECT COUNT(*) AS count
    FROM agent_session_messages
    WHERE role = 'user'
      AND COALESCE(content_text, '') != ''
      AND created_at >= datetime('now', ?)
  `, [rangeModifier]);
  const assistantReplyCount = readAssistantReplyCount(database, rangeModifier);
  const sqlGeneratedCount = readCount(database, `
    SELECT COUNT(*) AS count
    FROM agent_session_messages
    WHERE role = 'assistant'
      AND created_at >= datetime('now', ?)
      AND ${SQL_LIKE_FILTER}
  `, [rangeModifier]);
  const highRiskSqlCount = readCount(database, `
    SELECT COUNT(*) AS count
    FROM agent_session_messages
    WHERE role = 'assistant'
      AND created_at >= datetime('now', ?)
      AND ${HIGH_RISK_SQL_FILTER}
  `, [rangeModifier]);
  const failedRuntimeCount = readCount(database, `
    SELECT COUNT(*) AS count
    FROM agent_session_runtime
    WHERE status = 'failed'
      AND updated_at >= datetime('now', ?)
  `, [rangeModifier]);
  const noAssistantReplyCount = Math.max(0, questionCount - assistantReplyCount);
  const tokenUsage = readTokenUsage(database, rangeModifier);
  const retention = readQuestionRetention(database, rangeDays, meta.today);
  const tenantDistribution = readTenantDistribution(database, rangeModifier);
  const dataOpsTracked = false;

  return {
    range: {
      days: rangeDays,
      since: meta.since,
      generatedAt: meta.generatedAt,
    },
    overall: readOverallMetrics(database),
    kpis: {
      totalUsers: readCount(database, 'SELECT COUNT(*) AS count FROM users'),
      activeUsers: readCount(database, 'SELECT COUNT(*) AS count FROM users WHERE is_active = 1'),
      totalTenants: readCount(database, 'SELECT COUNT(*) AS count FROM tenants'),
      activeTenants: readCount(database, "SELECT COUNT(*) AS count FROM tenants WHERE status = 'active'"),
      loginDau: readCount(database, `
        SELECT COUNT(DISTINCT id) AS count
        FROM users
        WHERE last_login >= datetime('now', 'start of day')
      `),
      loginMau: readCount(database, `
        SELECT COUNT(DISTINCT id) AS count
        FROM users
        WHERE last_login >= datetime('now', ?)
      `, [rangeModifier]),
      questionDau: readCount(database, `
        SELECT COUNT(DISTINCT user_id) AS count
        FROM agent_session_messages
        WHERE role = 'user'
          AND COALESCE(content_text, '') != ''
          AND created_at >= datetime('now', 'start of day')
      `),
      questionMau: readCount(database, `
        SELECT COUNT(DISTINCT user_id) AS count
        FROM agent_session_messages
        WHERE role = 'user'
          AND COALESCE(content_text, '') != ''
          AND created_at >= datetime('now', ?)
      `, [rangeModifier]),
      newLoginUsers: readCount(database, `
        SELECT COUNT(*) AS count
        FROM users
        WHERE created_at >= datetime('now', ?)
      `, [rangeModifier]),
      newQuestionUsers: readFirstQuestionUsers(database, rangeModifier),
      churnedQuestionUsers: readQuestionChurn(database, rangeDays),
      questionCount,
      sessionCount: readCount(database, `
        SELECT COUNT(*) AS count
        FROM session_index
        WHERE status != 'deleted'
          AND created_at >= datetime('now', ?)
      `, [rangeModifier]),
      assistantReplyCount,
      answerReturnRate: percentage(assistantReplyCount, questionCount),
      sqlGeneratedCount,
      sqlGenerationRate: percentage(sqlGeneratedCount, questionCount),
      dataOpsSubmissionCount: null,
      dataOpsExecutionSuccessRate: null,
      endToEndSuccessRate: null,
      failedRuntimeCount,
      noAssistantReplyCount,
      highRiskSqlCount,
      totalTokens: tokenUsage.totalTokens,
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      cacheTokens: tokenUsage.cacheTokens,
      tokenTrackedMessages: tokenUsage.trackedMessages,
      tokenTrackingEnabled: tokenUsage.isTracked,
      retentionD1: retention.d1.rate,
      retentionD7: retention.d7.rate,
      retentionD30: retention.d30.rate,
    },
    funnel: [
      {
        key: 'questions',
        label: 'Questions submitted',
        count: questionCount,
        rateFromPrevious: 100,
        tracked: true,
      },
      {
        key: 'assistant_replies',
        label: 'Assistant replies returned',
        count: assistantReplyCount,
        rateFromPrevious: percentage(assistantReplyCount, questionCount),
        tracked: true,
      },
      {
        key: 'sql_generated',
        label: 'SQL-like answers generated',
        count: sqlGeneratedCount,
        rateFromPrevious: percentage(sqlGeneratedCount, assistantReplyCount),
        tracked: true,
      },
      {
        key: 'dataops_submitted',
        label: 'Submitted to DataOps',
        count: null,
        rateFromPrevious: null,
        tracked: dataOpsTracked,
      },
      {
        key: 'dataops_succeeded',
        label: 'DataOps succeeded',
        count: null,
        rateFromPrevious: null,
        tracked: dataOpsTracked,
      },
    ],
    tenantDistribution,
    activeTenants: tenantDistribution.slice(0, 10),
    topUsers: readTopUsers(database, rangeModifier),
    highFrequencyQueries: readHighFrequencyQueries(database, rangeModifier),
    highFailureQueries: readHighFailureQueries(database, rangeModifier),
    failureReasons: [
      ...(noAssistantReplyCount > 0 ? [{
        reason: 'no_assistant_reply',
        label: 'No assistant reply',
        count: noAssistantReplyCount,
      }] : []),
      ...(failedRuntimeCount > 0 ? [{
        reason: 'runtime_failed',
        label: 'Runtime failed',
        count: failedRuntimeCount,
      }] : []),
    ],
    retention,
    dailyTrend: readDailyTrend(database, rangeDays, meta.today),
    providerUsage: readProviderUsage(database, rangeModifier),
    coverage: {
      loginHistory: 'last_login_only',
      questionEvents: true,
      sqlDetection: 'heuristic',
      dataOpsEvents: dataOpsTracked,
      tokenUsage: tokenUsage.isTracked,
    },
  };
}
