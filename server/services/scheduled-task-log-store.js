import { db } from '../database/db.js';

const VALID_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const VALID_PROVIDERS = new Set(['claude', 'codex', 'cursor', 'gemini']);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_ROWS = 10_000;
const DEFAULT_CLEANUP_EVERY = 100;

function parseConfiguredInteger(value, fallback, { min, max }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function createFilterError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function parseOptionalPositiveInteger(value, name) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createFilterError(`${name} must be a positive integer`);
  }
  return parsed;
}

function parsePaginationInteger(value, fallback, { name, min, max }) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw createFilterError(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseOptionalEnum(value, validValues, name) {
  if (value == null || value === '') return null;
  const parsed = String(value).trim().toLowerCase();
  if (!validValues.has(parsed)) {
    throw createFilterError(`Invalid ${name}`);
  }
  return parsed;
}

function parseOptionalText(value, name, maxLength) {
  if (value == null || value === '') return null;
  const parsed = String(value).trim();
  if (!parsed || parsed.length > maxLength) {
    throw createFilterError(`${name} must be at most ${maxLength} characters`);
  }
  return parsed;
}

function parseOptionalDate(value, name) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createFilterError(`${name} must be a valid date`);
  }
  return date.toISOString();
}

function parseDetails(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function normalizeFilters(filters = {}) {
  const from = parseOptionalDate(filters.from, 'from');
  const to = parseOptionalDate(filters.to, 'to');
  if (from && to && from > to) {
    throw createFilterError('from must be earlier than or equal to to');
  }

  return {
    level: parseOptionalEnum(filters.level, VALID_LEVELS, 'level'),
    provider: parseOptionalEnum(filters.provider, VALID_PROVIDERS, 'provider'),
    event: parseOptionalText(filters.event, 'event', 100),
    q: parseOptionalText(filters.q, 'q', 200),
    taskId: parseOptionalPositiveInteger(filters.taskId, 'taskId'),
    tenantId: parseOptionalPositiveInteger(filters.tenantId, 'tenantId'),
    workspaceId: parseOptionalPositiveInteger(filters.workspaceId, 'workspaceId'),
    userId: parseOptionalPositiveInteger(filters.userId, 'userId'),
    from,
    to,
    limit: parsePaginationInteger(filters.limit, DEFAULT_LIMIT, {
      name: 'limit',
      min: 1,
      max: MAX_LIMIT,
    }),
    offset: parsePaginationInteger(filters.offset, 0, {
      name: 'offset',
      min: 0,
      max: 1_000_000,
    }),
  };
}

function buildWhereClause(filters) {
  const clauses = [];
  const params = [];
  const add = (clause, value) => {
    clauses.push(clause);
    params.push(value);
  };

  if (filters.level) add('l.level = ?', filters.level);
  if (filters.provider) add('l.provider = ?', filters.provider);
  if (filters.event) add('l.event = ?', filters.event);
  if (filters.taskId) add('l.task_id = ?', filters.taskId);
  if (filters.tenantId) add('l.tenant_id = ?', filters.tenantId);
  if (filters.workspaceId) add('l.workspace_id = ?', filters.workspaceId);
  if (filters.userId) add('l.user_id = ?', filters.userId);
  if (filters.from) add('l.timestamp >= ?', filters.from);
  if (filters.to) add('l.timestamp <= ?', filters.to);
  if (filters.q) {
    const search = `%${filters.q}%`;
    clauses.push(`(
      l.event LIKE ?
      OR l.tick_id LIKE ?
      OR l.run_id LIKE ?
      OR l.details_json LIKE ?
      OR t.name LIKE ?
      OR tn.code LIKE ?
      OR tn.name LIKE ?
      OR u.username LIKE ?
      OR w.slug LIKE ?
      OR w.display_name LIKE ?
    )`);
    params.push(...Array(10).fill(search));
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function mapRow(row) {
  return {
    id: row.id,
    timestamp: row.timestamp,
    level: row.level,
    event: row.event,
    processId: row.process_id,
    taskId: row.task_id,
    taskName: row.task_name || null,
    tenantId: row.tenant_id,
    tenantCode: row.tenant_code || null,
    tenantName: row.tenant_name || null,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name || null,
    workspaceSlug: row.workspace_slug || null,
    userId: row.user_id,
    username: row.username || null,
    provider: row.provider,
    tickId: row.tick_id,
    runId: row.run_id,
    details: parseDetails(row.details_json),
  };
}

export function createScheduledTaskLogStore({
  database = db,
  retentionDays = process.env.SCHEDULED_TASK_LOG_RETENTION_DAYS,
  maxRows = process.env.SCHEDULED_TASK_LOG_MAX_ROWS,
  cleanupEvery = DEFAULT_CLEANUP_EVERY,
  now = () => new Date(),
} = {}) {
  const configuredRetentionDays = parseConfiguredInteger(retentionDays, DEFAULT_RETENTION_DAYS, {
    min: 1,
    max: 365,
  });
  const configuredMaxRows = parseConfiguredInteger(maxRows, DEFAULT_MAX_ROWS, {
    min: 100,
    max: 1_000_000,
  });
  const configuredCleanupEvery = parseConfiguredInteger(cleanupEvery, DEFAULT_CLEANUP_EVERY, {
    min: 1,
    max: 10_000,
  });
  let writesSinceCleanup = configuredCleanupEvery;

  function cleanup() {
    const cutoff = new Date(now().getTime() - configuredRetentionDays * 24 * 60 * 60 * 1_000).toISOString();
    const expired = database.prepare('DELETE FROM scheduled_task_logs WHERE timestamp < ?').run(cutoff).changes;
    const boundary = database.prepare(`
      SELECT id
      FROM scheduled_task_logs
      ORDER BY id DESC
      LIMIT 1 OFFSET ?
    `).get(configuredMaxRows - 1);
    const overflow = boundary
      ? database.prepare('DELETE FROM scheduled_task_logs WHERE id < ?').run(boundary.id).changes
      : 0;
    writesSinceCleanup = 0;
    return { expired, overflow };
  }

  return {
    append(entry) {
      database.prepare(`
        INSERT INTO scheduled_task_logs (
          timestamp,
          level,
          event,
          process_id,
          task_id,
          tenant_id,
          workspace_id,
          user_id,
          provider,
          tick_id,
          run_id,
          details_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.timestamp,
        entry.level,
        entry.event,
        entry.processId ?? null,
        entry.taskId ?? null,
        entry.tenantId ?? null,
        entry.workspaceId ?? null,
        entry.userId ?? null,
        entry.provider ?? null,
        entry.tickId ?? null,
        entry.runId ?? null,
        JSON.stringify(entry),
      );
      writesSinceCleanup += 1;
      if (writesSinceCleanup >= configuredCleanupEvery) cleanup();
    },

    list(rawFilters = {}) {
      const filters = normalizeFilters(rawFilters);
      const where = buildWhereClause(filters);
      const joins = `
        LEFT JOIN scheduled_session_tasks t ON t.id = l.task_id
        LEFT JOIN tenants tn ON tn.id = l.tenant_id
        LEFT JOIN users u ON u.id = l.user_id
        LEFT JOIN workspaces w ON w.id = l.workspace_id
      `;
      const rows = database.prepare(`
        SELECT
          l.*,
          t.name AS task_name,
          tn.code AS tenant_code,
          tn.name AS tenant_name,
          u.username,
          w.display_name AS workspace_name,
          w.slug AS workspace_slug
        FROM scheduled_task_logs l
        ${joins}
        ${where.sql}
        ORDER BY l.id DESC
        LIMIT ? OFFSET ?
      `).all(...where.params, filters.limit, filters.offset).map(mapRow);
      const total = database.prepare(`
        SELECT COUNT(*) AS count
        FROM scheduled_task_logs l
        ${joins}
        ${where.sql}
      `).get(...where.params).count;
      const levelRows = database.prepare(`
        SELECT l.level, COUNT(*) AS count
        FROM scheduled_task_logs l
        ${joins}
        ${where.sql}
        GROUP BY l.level
      `).all(...where.params);
      const byLevel = Object.fromEntries(levelRows.map((row) => [row.level, row.count]));

      return {
        rows,
        total,
        limit: filters.limit,
        offset: filters.offset,
        summary: {
          total,
          debug: byLevel.debug || 0,
          info: byLevel.info || 0,
          warn: byLevel.warn || 0,
          error: byLevel.error || 0,
        },
        retention: {
          days: configuredRetentionDays,
          maxRows: configuredMaxRows,
        },
      };
    },

    cleanup,
  };
}

export const scheduledTaskLogStore = createScheduledTaskLogStore();
