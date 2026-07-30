import { db as defaultDb } from '../database/db.js';

const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 365;
const VALID_PROVIDERS = new Set(['claude', 'codex', 'cursor', 'gemini']);

function normalizeRangeDays(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_RANGE_DAYS), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_RANGE_DAYS;
  }
  return Math.min(parsed, MAX_RANGE_DAYS);
}

function normalizeProvider(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (VALID_PROVIDERS.has(normalized)) return normalized;

  const error = new Error('provider must be one of: claude, codex, cursor, gemini');
  error.statusCode = 400;
  throw error;
}

function safeParseJson(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function readObjectName(value) {
  if (typeof value === 'string') return normalizeString(value);
  if (!value || typeof value !== 'object') return '';

  const record = value;
  return normalizeString(record.name)
    || normalizeString(record.serverName)
    || normalizeString(record.server_name)
    || normalizeString(record.id);
}

function extractServerName(message) {
  return readObjectName(message?.server)
    || readObjectName(message?.mcpServer)
    || readObjectName(message?.mcp_server);
}

function extractRawToolName(message) {
  return normalizeString(message?.toolName)
    || normalizeString(message?.tool_name)
    || normalizeString(message?.tool)
    || normalizeString(message?.name)
    || 'unknown';
}

function extractMcpToolParts(message) {
  const rawToolName = extractRawToolName(message);
  let serverName = extractServerName(message);
  let toolName = rawToolName;

  const prefixedMatch = rawToolName.match(/^mcp__(.*?)__(.+)$/i);
  if (prefixedMatch) {
    serverName = serverName || prefixedMatch[1];
    toolName = prefixedMatch[2];
  }

  if (!serverName && rawToolName.toLowerCase() === 'mcp') {
    serverName = 'unknown';
  }

  if (!serverName) return null;

  return {
    serverName: serverName || 'unknown',
    toolName: toolName || 'unknown',
  };
}

function getCallStatus(message) {
  const status = normalizeString(message?.status).toLowerCase();
  const errorLikeStatus = new Set(['error', 'errored', 'failed', 'failure', 'cancelled', 'canceled']);

  if (
    message?.isError === true
    || Boolean(message?.error)
    || message?.result?.isError === true
    || Boolean(message?.result?.error)
    || errorLikeStatus.has(status)
  ) {
    return 'error';
  }

  if (status) return status;
  return 'success';
}

function incrementServer(map, call) {
  const key = call.serverName;
  const existing = map.get(key) || {
    serverName: call.serverName,
    callCount: 0,
    errorCount: 0,
    lastCalledAt: call.calledAt,
    toolNames: new Set(),
  };

  existing.callCount += 1;
  existing.errorCount += call.status === 'error' ? 1 : 0;
  existing.lastCalledAt = existing.lastCalledAt > call.calledAt ? existing.lastCalledAt : call.calledAt;
  existing.toolNames.add(call.toolName);
  map.set(key, existing);
}

function incrementTool(map, call) {
  const key = `${call.serverName}\u0000${call.toolName}`;
  const existing = map.get(key) || {
    serverName: call.serverName,
    toolName: call.toolName,
    callCount: 0,
    errorCount: 0,
    lastCalledAt: call.calledAt,
  };

  existing.callCount += 1;
  existing.errorCount += call.status === 'error' ? 1 : 0;
  existing.lastCalledAt = existing.lastCalledAt > call.calledAt ? existing.lastCalledAt : call.calledAt;
  map.set(key, existing);
}

function sortUsageRows(rows) {
  return rows.sort((a, b) => {
    if (b.callCount !== a.callCount) return b.callCount - a.callCount;
    return String(b.lastCalledAt || '').localeCompare(String(a.lastCalledAt || ''));
  });
}

function readToolUseRows(database, { rangeDays, provider }) {
  const filters = [
    'kind = ?',
    "created_at >= datetime('now', ?)",
  ];
  const params = ['tool_use', `-${rangeDays} days`];

  if (provider) {
    filters.push('provider = ?');
    params.push(provider);
  }

  return database.prepare(`
    SELECT
      id,
      tenant_id,
      workspace_id,
      user_id,
      runtime_id,
      provider,
      provider_session_id,
      message_id,
      normalized_json,
      provider_timestamp,
      created_at
    FROM agent_session_messages
    WHERE ${filters.join(' AND ')}
    ORDER BY created_at DESC, sequence DESC, id DESC
  `).all(...params);
}

export function buildMcpToolUsageSummary({
  rangeDays,
  provider,
  database = defaultDb,
} = {}) {
  const normalizedRangeDays = normalizeRangeDays(rangeDays);
  const normalizedProvider = normalizeProvider(provider);
  const rows = readToolUseRows(database, {
    rangeDays: normalizedRangeDays,
    provider: normalizedProvider,
  });

  const byServer = new Map();
  const byTool = new Map();
  const recentCalls = [];
  let callCount = 0;
  let errorCount = 0;

  rows.forEach((row) => {
    const message = safeParseJson(row.normalized_json);
    const mcpTool = extractMcpToolParts(message);
    if (!mcpTool) return;

    const calledAt = row.provider_timestamp || row.created_at;
    const status = getCallStatus(message);
    const call = {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      userId: row.user_id,
      runtimeId: row.runtime_id,
      sessionId: row.provider_session_id,
      messageId: row.message_id,
      provider: row.provider,
      serverName: mcpTool.serverName,
      toolName: mcpTool.toolName,
      status,
      calledAt,
    };

    callCount += 1;
    errorCount += status === 'error' ? 1 : 0;
    incrementServer(byServer, call);
    incrementTool(byTool, call);

    if (recentCalls.length < 50) {
      recentCalls.push(call);
    }
  });

  const serverRows = sortUsageRows(Array.from(byServer.values()).map((item) => ({
    serverName: item.serverName,
    callCount: item.callCount,
    errorCount: item.errorCount,
    toolCount: item.toolNames.size,
    lastCalledAt: item.lastCalledAt,
  })));
  const toolRows = sortUsageRows(Array.from(byTool.values()));

  return {
    range: {
      days: normalizedRangeDays,
      provider: normalizedProvider,
      generatedAt: new Date().toISOString(),
    },
    totals: {
      callCount,
      successCount: callCount - errorCount,
      errorCount,
      serverCount: serverRows.length,
      toolCount: toolRows.length,
    },
    byServer: serverRows,
    byTool: toolRows.slice(0, 50),
    recentCalls,
  };
}
