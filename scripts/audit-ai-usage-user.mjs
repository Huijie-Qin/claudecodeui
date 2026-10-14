#!/usr/bin/env node
// Read-only recomputation from original main-session history and assistant messages.
// Never import database/db.js: importing it opens/migrates the application database.
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import Database from 'better-sqlite3';

import { localInstant, normalizeTimestamp, shiftDate } from '../server/services/ai-usage-config.js';
import { logicalSessionKey } from '../server/services/ai-usage-parser.js';
import { parseSqlGeneration, sqlMessageExclusion } from '../server/services/ai-usage-sql.js';
import { createTranscriptDurationTracker, transcriptTurnRows } from '../server/services/ai-usage-transcript-duration.js';
import { readTranscriptCompletionMarkers } from '../server/services/ai-usage-transcript-markers.js';

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_ISSUES = 100;
const MAX_DETAILS = 1000;
const scopeColumns = 'tenant_id,workspace_id,user_id,provider,provider_session_id';

function dateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error('日期必须是有效的 YYYY-MM-DD');
  }
  return value;
}

function readSnapshot(databasePath, tenantId, userId) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    db.pragma('query_only = ON');
    // Release the SQLite read transaction before any potentially slow filesystem scan.
    return db.transaction(() => {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
      for (const table of ['tenants', 'users', 'workspaces']) {
        if (!tables.has(table)) throw new Error(`缺少业务表 ${table}，请确认 --db 指向多租户服务的业务数据库`);
      }
      if (!db.prepare('SELECT id FROM tenants WHERE id=?').get(tenantId)) throw new Error(`租户不存在：${tenantId}`);
      const user = db.prepare('SELECT id,username FROM users WHERE id=?').get(userId);
      if (!user) throw new Error(`用户不存在：${userId}`);
      const scoped = (table, columns, extra = '') => tables.has(table)
        ? db.prepare(`SELECT ${columns} FROM ${table} WHERE tenant_id=? AND user_id=? ${extra}`).all(tenantId, userId) : [];
      return {
        tables, user,
        workspaces: db.prepare('SELECT id,tenant_id FROM workspaces').all(),
        // Only ownership metadata from other tenants is needed to detect ambiguous sessions.
        sessions: tables.has('session_index') ? db.prepare(`SELECT ${scopeColumns} FROM session_index WHERE user_id=?`).all(userId) : [],
        turns: scoped('ai_usage_turn_facts', 'terminal_status'),
        runtimes: scoped('agent_session_runtime', `${scopeColumns},runtime_home_path`, "AND provider='claude' ORDER BY id"),
        messages: scoped('agent_session_messages', `${scopeColumns},id,message_id,normalized_json,provider_timestamp,created_at`, 'ORDER BY id'),
        suppressed: tables.has('ai_usage_suppressed_rows') ? db.prepare(`SELECT row_key FROM ai_usage_suppressed_rows
          WHERE tenant_id=? AND dataset IN ('sql_generations','hook_records')`).all(tenantId).map(row => row.row_key) : [],
      };
    })();
  } finally { db.close(); }
}

/** Both dates are inclusive in timeZone. No database writes, migrations or scheduler imports. */
export async function auditUserUsage({ databasePath, tenantId, userId, from, to, timeZone = 'Asia/Shanghai' }) {
  for (const [key, value] of Object.entries({ tenantId, userId })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} 必须是正整数 ID`);
  }
  if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath)) throw new Error('--db 必须是现有数据库的绝对路径');
  dateKey(from); dateKey(to);
  if (from > to) throw new Error('--from 不能晚于 --to');
  const fromInclusive = localInstant(from, '00:00', timeZone);
  const toExclusive = localInstant(shiftDate(to, 1), '00:00', timeZone);
  const observedAt = new Date().toISOString();
  const snapshot = readSnapshot(databasePath, tenantId, userId);
  const result = {
    tenantId, userId, userName: snapshot.user.username,
    range: { from, to, timeZone, fromInclusive, toExclusive }, observedAt,
    metrics: { aiActiveDurationMs: null,
      aiActiveDurationSeconds: null, generatedSqlLines: null },
    daily: [], coverage: { duration: 'unavailable', sql: 'unavailable', durationReason: 'no_readable_main_history' },
    auditVersion: 3, sources: [], sourcesTruncated: false,
    sqlRecords: [], sqlRecordsTruncated: false, sqlDiagnostics: {},
    durationRecords: [], durationRecordsTruncated: false, durationDiagnostics: {},
    scanned: { turnRecords: snapshot.turns.length,
      capturedCompletedTurns: snapshot.turns.filter(turn => turn.terminal_status === 'completed').length,
      historyTurns: 0, completedHistoryTurns: 0, durationFiles: 0, nativeFiles: 0, databaseMessages: snapshot.messages.length },
    skipped: {}, issues: [], issuesTruncated: false,
    notes: [
      'AI 时长从历史主会话逐轮恢复：真实用户消息到最后主助手消息，只有明确完成证据才计入，按时区分日；不同会话并行分别累加，子代理不重复计时。',
      '代码生成量包含 AI 正文、思考内容、工具调用参数中的 SQL 物理行数；同一回复跨内容块去重，继承消息与工具返回排除，原生文件优先。',
      '只读当前保留的原始会话，不读取看板汇总值；ai_usage_turn_facts 仅作实时捕获诊断，不贡献时长。',
      'coverage=partial 表示不能保证历史完整；0 表示已读取主会话但未累计到有效完成轮次；没有可读主会话时时长为 null。',
      'sources 列出原生文件读取量和时长证据；sqlRecords 与 durationRecords 各最多 1000 条无正文样本，相应 Diagnostics 为全量最终状态计数。',
      '数据库与文件不构成同一事务快照；运行期间新写入的数据可能留到下次核算。',
    ],
  };
  const skip = (reason, metadata = {}, diagnostic = true) => {
    result.skipped[reason] = (result.skipped[reason] || 0) + 1;
    if (!diagnostic) return;
    if (result.issues.length < MAX_ISSUES) result.issues.push({ reason, ...metadata });
    else result.issuesTruncated = true;
  };
  const daily = new Map();
  const day = date => {
    if (!daily.has(date)) daily.set(date, { date, aiActiveDurationMs: 0, generatedSqlLines: 0 });
    return daily.get(date);
  };
  const workspaces = new Map(snapshot.workspaces.map(row => [row.id, row.tenant_id]));
  const bindings = new Map();
  for (const row of snapshot.sessions) {
    const key = JSON.stringify([row.provider, row.provider_session_id]);
    if (!bindings.has(key)) bindings.set(key, []);
    bindings.get(key).push(row);
  }
  function validScope(scope) {
    const sessionId = scope.provider_session_id || scope.session_key;
    if (scope.tenant_id !== tenantId || scope.user_id !== userId || !scope.provider || !sessionId
      || !Number.isSafeInteger(scope.workspace_id) || scope.workspace_id <= 0) {
      skip('invalid_session_scope'); return false;
    }
    const metadata = { sessionKey: logicalSessionKey(scope) };
    if (workspaces.has(scope.workspace_id) && workspaces.get(scope.workspace_id) !== tenantId) {
      skip('SESSION_SUMMARY_WORKSPACE_SCOPE_CONFLICT', metadata); return false;
    }
    const originals = bindings.get(JSON.stringify([scope.provider, sessionId])) || [];
    if (originals.length > 1 || originals.some(row => row.tenant_id !== tenantId || row.workspace_id !== scope.workspace_id)) {
      skip('SESSION_SUMMARY_SOURCE_SCOPE_CONFLICT', metadata); return false;
    }
    return true;
  }

  const durationTurnWinners = new Map();
  function traceDuration(scope, source, turn, row, recordStatus) {
    const record = { path: source.path, sessionKey: logicalSessionKey(scope), turnKey: turn.turnKey,
      date: row?.stat_date || null, requestStartedAt: turn.requestStartedAt || null,
      responseCompletedAt: turn.responseCompletedAt || null, completionEvidence: turn.completionEvidence || null,
      durationMs: row?.value?.durationMs ?? null, countedDurationMs: 0, status: recordStatus };
    result.durationDiagnostics[recordStatus] = (result.durationDiagnostics[recordStatus] || 0) + 1;
    if (result.durationRecords.length < MAX_DETAILS) result.durationRecords.push(record);
    else result.durationRecordsTruncated = true;
    return record;
  }
  function durationStatus(record, next) {
    if (record.status === next) return;
    result.durationDiagnostics[record.status]--;
    if (!result.durationDiagnostics[record.status]) delete result.durationDiagnostics[record.status];
    record.status = next;
    result.durationDiagnostics[next] = (result.durationDiagnostics[next] || 0) + 1;
  }
  function mergeDuration(scope, source, turns, sourceKey) {
    source.historyTurns = turns.size;
    source.completedHistoryTurns = [...turns.values()].filter(({ turn }) => turn.status === 'completed').length;
    result.scanned.historyTurns += source.historyTurns;
    result.scanned.completedHistoryTurns += source.completedHistoryTurns;
    for (const { turn, rows } of turns.values()) {
      const records = rows.map(row => traceDuration(scope, source, turn, row, 'pending'));
      const prior = durationTurnWinners.get(turn.turnKey);
      // Choose one complete source version before looking at status or dates.
      // A failed or shortened revision must replace every older date slice.
      if (!prior || sourceKey < prior.sourceKey) {
        if (prior) for (const record of prior.records) durationStatus(record, 'duplicate_source');
        durationTurnWinners.set(turn.turnKey, { turn, rows, records, source, sourceKey });
      } else for (const record of records) durationStatus(record, 'duplicate_source');
    }
  }

  const winners = new Map(), nativeSessions = new Set(), suppressed = new Set(snapshot.suppressed);
  function traceSql(scope, metadata, value = {}) {
    const record = { ...metadata, sessionKey: logicalSessionKey(scope), messageId: null,
      date: null, generatedSqlLines: null, sqlBlockCount: null, ...value };
    result.sqlDiagnostics[record.status] = (result.sqlDiagnostics[record.status] || 0) + 1;
    if (result.sqlRecords.length < MAX_DETAILS) result.sqlRecords.push(record);
    else result.sqlRecordsTruncated = true;
    return record;
  }
  function status(record, next) {
    if (record.status === next) return;
    result.sqlDiagnostics[record.status]--;
    if (!result.sqlDiagnostics[record.status]) delete result.sqlDiagnostics[record.status];
    record.status = next;
    result.sqlDiagnostics[next] = (result.sqlDiagnostics[next] || 0) + 1;
  }
  function mergeSource(rows, sourceKey, priority) {
    for (const row of rows.values()) {
      if (row.stat_date < from || row.stat_date > to) { status(row.audit, 'out_of_range'); continue; }
      if (suppressed.has(row.row_key)) { status(row.audit, 'suppressed'); skip('sql_suppressed', {}, false); continue; }
      // Production deduplication partitions by date, then row_key, then source priority/key.
      const key = `${row.stat_date}/${row.row_key}`, prior = winners.get(key);
      if (!prior || priority > prior.priority || (priority === prior.priority && sourceKey < prior.sourceKey)) {
        if (prior) status(prior.row.audit, 'duplicate_source');
        status(row.audit, 'counted');
        winners.set(key, { row, sourceKey, priority });
      } else status(row.audit, 'duplicate_source');
    }
  }
  function parseMessage(scope, raw, options, rows, metadata, source = null) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { skip('invalid_message', metadata); return; }
    const message = raw.type === 'claude-response' ? raw.data : raw;
    const exclusion = sqlMessageExclusion(raw);
    if (exclusion === 'non_assistant') return;
    if (exclusion === 'invalid_message') { skip('invalid_message', metadata); return; }
    if (source) source.assistantMessages++;
    const identity = { messageId: message.uuid || message.id || options.fallbackId || null };
    if (exclusion) { traceSql(scope, metadata, { ...identity, status: exclusion }); return; }
    try {
      const parsed = parseSqlGeneration(scope, raw, { timeZone, ...options });
      if (!parsed.length) {
        skip('missing_sql_identity_or_time', metadata);
        traceSql(scope, metadata, { ...identity, status: 'missing_identity_or_time' });
      }
      for (const row of parsed) {
        if (!Number.isSafeInteger(row.value.generatedLines) || row.value.generatedLines < 0) {
          skip('invalid_sql_lines', metadata);
          traceSql(scope, metadata, { ...identity, status: 'invalid_message' }); continue;
        }
        if (source && row.value.generatedLines > 0) source.sqlMessages++;
        const audit = traceSql(scope, metadata, { messageId: row.value.messageId, date: row.stat_date,
          generatedSqlLines: row.value.generatedLines, sqlBlockCount: row.value.sqlBlockCount,
          status: row.value.generatedLines ? 'pending' : 'no_sql' });
        // Parse the entire source before date filtering: later revisions can move or remove a reply.
        const previous = rows.get(row.row_key);
        if (previous) status(previous.audit, 'superseded');
        if (row.value.generatedLines === 0) rows.delete(row.row_key);
        else rows.set(row.row_key, { ...row, audit, source });
      }
    } catch {
      skip('invalid_sql_message', metadata);
      traceSql(scope, metadata, { ...identity, status: 'invalid_message' });
    }
  }
  async function entries(directory, optional = false) {
    try { return (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0); }
    catch (error) {
      if (!optional || error.code !== 'ENOENT') skip('unreadable_directory', { path: directory, code: error.code });
      return [];
    }
  }
  async function scanNative(file, scope, subagentId) {
    let handle;
    const rows = new Map(), historyTurns = new Map();
    let durationTracker = null;
    const source = { path: file, sessionKey: logicalSessionKey(scope), subagentId, status: 'unreadable',
      bytesRead: 0, linesRead: 0, parsedRecords: 0, assistantMessages: 0, sqlMessages: 0, countedSqlLines: 0,
      durationStatus: subagentId ? 'subagent_excluded' : 'unreadable', completionMarkersStatus: null,
      historyTurns: 0, completedHistoryTurns: 0, durationAnomalies: 0, countedDurationMs: 0 };
    if (result.sources.length < MAX_DETAILS) result.sources.push(source);
    else result.sourcesTruncated = true;
    try {
      handle = await open(file, 'r');
      const before = await handle.stat();
      if (!before.isFile()) throw Object.assign(new Error('Not a file'), { code: 'NOT_FILE' });
      if (!subagentId) {
        const markers = await readTranscriptCompletionMarkers(file);
        source.completionMarkersStatus = markers.status;
        if (markers.status === 'unreadable') skip('unreadable_completion_markers', { path: file });
        durationTracker = createTranscriptDurationTracker(scope, { timeZone, completedReplyUuids: markers.completedReplyUuids,
          onTurn: turn => historyTurns.set(turn.turnKey, { turn, rows: transcriptTurnRows(scope, turn, timeZone) }),
          onAnomaly: anomaly => {
            source.durationAnomalies++;
            skip('history_duration_anomaly', { path: file, turnKey: anomaly.turnKey,
              sessionKey: anomaly.sessionKey, anomalyReason: anomaly.reason });
          },
        });
      }
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0, pending = Buffer.alloc(0), oversized = false, line = 0;
      const consume = bytes => {
        line++;
        source.linesRead++;
        const metadata = { path: file, line };
        if (oversized) { skip('oversized_jsonl_line', metadata); durationTracker?.invalidate('oversized_jsonl_line'); return; }
        const text = bytes.toString('utf8').trim();
        if (!text) return;
        let raw;
        try { raw = JSON.parse(text); source.parsedRecords++; }
        catch { skip('malformed_jsonl', metadata); durationTracker?.invalidate('malformed_jsonl'); return; }
        if (!subagentId && raw?.sessionId && raw.sessionId !== scope.provider_session_id) {
          skip('native_session_mismatch', metadata); return;
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) durationTracker?.invalidate('invalid_history_message');
        else durationTracker?.observe(raw);
        parseMessage(scope, raw, { subagentId }, rows, metadata, source);
      };
      // Read a bounded initial prefix; an unterminated tail is still being written and is excluded.
      while (position < before.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (!bytesRead) throw Object.assign(new Error('Truncated'), { code: 'FILE_CHANGED' });
        position += bytesRead;
        source.bytesRead += bytesRead;
        let offset = 0;
        for (let index = 0; index < bytesRead; index++) {
          if (buffer[index] !== 10) continue;
          const piece = buffer.subarray(offset, index);
          if (pending.length + piece.length > MAX_LINE_BYTES) oversized = true;
          consume(oversized ? Buffer.alloc(0) : Buffer.concat([pending, piece]));
          pending = Buffer.alloc(0); oversized = false; offset = index + 1;
        }
        const rest = buffer.subarray(offset, bytesRead);
        if (pending.length + rest.length > MAX_LINE_BYTES) oversized = true;
        pending = oversized ? Buffer.alloc(0) : Buffer.concat([pending, rest]);
      }
      if (pending.length || oversized) {
        skip('unterminated_jsonl_tail', { path: file, line: line + 1 });
      }
      durationTracker?.flush();
      const after = await stat(file);
      // Discard a replaced/rewritten source atomically. Normal appends are outside the bounded snapshot.
      if (before.ino !== after.ino || before.dev !== after.dev || after.size < before.size
        || (after.size === before.size && after.mtimeMs !== before.mtimeMs)) {
        throw Object.assign(new Error('Changed'), { code: 'FILE_CHANGED' });
      }
      if (after.size > before.size) skip('native_appended_after_snapshot', { path: file });
      source.status = 'read';
      result.scanned.nativeFiles++;
      const sourceKey = `jsonl:${logicalSessionKey(scope)}:${file}`;
      if (durationTracker) {
        source.durationStatus = 'read';
        result.scanned.durationFiles++;
        mergeDuration(scope, source, historyTurns, sourceKey);
      }
      mergeSource(rows, sourceKey, 30);
      return true;
    } catch (error) {
      // Only source I/O failures make a file unreadable; parser/system errors must surface.
      if (!['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'EBADF', 'EMFILE', 'ENFILE',
        'EIO', 'ESTALE', 'ELOOP', 'ENAMETOOLONG', 'FILE_CHANGED', 'NOT_FILE'].includes(error.code)) throw error;
      source.status = 'unreadable';
      if (!subagentId) source.durationStatus = 'unreadable';
      for (const row of rows.values()) status(row.audit, 'source_unreadable');
      skip('unreadable_native_file', { path: file, code: error.code || 'READ_ERROR' }); return false;
    }
    finally { await handle?.close(); }
  }

  if (snapshot.tables.has('agent_session_runtime') && snapshot.tables.has('session_index')) {
    const sessions = new Set(snapshot.sessions.filter(row => row.tenant_id === tenantId && row.provider === 'claude').map(logicalSessionKey));
    for (const runtime of snapshot.runtimes) if (runtime.provider_session_id) sessions.add(logicalSessionKey(runtime));
    const homes = new Map(snapshot.runtimes.map(runtime => [JSON.stringify([
      runtime.tenant_id, runtime.workspace_id, runtime.user_id, runtime.runtime_home_path,
    ]), runtime]));
    const seen = new Set();
    for (const [, runtime] of [...homes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (!runtime.runtime_home_path || !path.isAbsolute(runtime.runtime_home_path)) {
        skip('invalid_runtime_home', { workspaceId: runtime.workspace_id }); continue;
      }
      const root = path.join(runtime.runtime_home_path, '.claude', 'projects');
      for (const project of await entries(root)) {
        if (!project.isDirectory()) continue;
        const directory = path.join(root, project.name);
        for (const entry of await entries(directory)) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          const sessionId = entry.name.slice(0, -6), scope = { ...runtime, provider_session_id: sessionId };
          const key = logicalSessionKey(scope), file = path.join(directory, entry.name);
          if (!sessions.has(key) || seen.has(`${key}/${file}`)) continue;
          seen.add(`${key}/${file}`);
          if (!validScope(scope)) continue;
          if (await scanNative(file, scope, null)) nativeSessions.add(key);
          for (const sub of await entries(path.join(directory, sessionId, 'subagents'), true)) {
            if (sub.isFile() && sub.name.endsWith('.jsonl')) {
              await scanNative(path.join(directory, sessionId, 'subagents', sub.name), scope, sub.name.slice(0, -6).replace(/^agent-/, ''));
            }
          }
        }
      }
    }
  }
  for (const message of snapshot.messages) {
    if (!validScope(message)) continue;
    if (nativeSessions.has(logicalSessionKey(message))) {
      skip('database_copy_native_preferred', {}, false);
      traceSql(message, { databaseMessageId: message.id }, { messageId: message.message_id, status: 'native_preferred' });
      continue;
    }
    const metadata = { databaseMessageId: message.id };
    // Match sourceRows' original source-validity gate. created_at is only checked
    // here; it must never replace the reply's business timestamp in the parser.
    if (!normalizeTimestamp(message.provider_timestamp || message.created_at)) {
      skip('invalid_database_source_time', metadata);
      traceSql(message, metadata, { messageId: message.message_id, status: 'invalid_message', reason: 'invalid_database_source_time' });
      continue;
    }
    let raw;
    try { raw = JSON.parse(message.normalized_json); }
    catch {
      skip('malformed_database_message', metadata);
      traceSql(message, metadata, { messageId: message.message_id, status: 'invalid_message', reason: 'malformed_database_message' });
      continue;
    }
    const rows = new Map();
    parseMessage(message, raw, { fallbackId: message.message_id, fallbackTime: message.provider_timestamp }, rows, metadata);
    mergeSource(rows, `message:${message.id}`, 0);
  }
  const durationAvailable = result.scanned.durationFiles > 0;
  result.coverage.duration = durationAvailable ? 'partial' : 'unavailable';
  result.coverage.durationReason = durationAvailable ? 'readable_main_history_only' : 'no_readable_main_history';
  result.metrics.aiActiveDurationMs = durationAvailable ? 0 : null;
  for (const { turn, rows, records, source } of durationTurnWinners.values()) {
    if (turn.status !== 'completed') {
      for (const record of records) durationStatus(record, turn.status || 'incomplete');
      continue;
    }
    for (const [index, row] of rows.entries()) {
      const record = records[index], duration = row.value.durationMs;
      if (row.stat_date < from || row.stat_date > to) { durationStatus(record, 'out_of_range'); continue; }
      if (!Number.isSafeInteger(duration) || duration < 0) {
        durationStatus(record, 'invalid_duration');
        skip('invalid_history_duration', { path: source.path, turnKey: turn.turnKey }); continue;
      }
      if (!Number.isSafeInteger(result.metrics.aiActiveDurationMs + duration)
        || !Number.isSafeInteger((daily.get(row.stat_date)?.aiActiveDurationMs || 0) + duration)) {
        durationStatus(record, 'overflow');
        skip('duration_overflow', { turnKey: record.turnKey }); continue;
      }
      durationStatus(record, 'counted');
      result.metrics.aiActiveDurationMs += duration;
      source.countedDurationMs += duration;
      record.countedDurationMs = duration;
      day(row.stat_date).aiActiveDurationMs += duration;
    }
  }
  result.metrics.aiActiveDurationSeconds = result.metrics.aiActiveDurationMs === null ? null : result.metrics.aiActiveDurationMs / 1000;
  const sqlAvailable = snapshot.tables.has('agent_session_messages') || result.scanned.nativeFiles > 0;
  result.coverage.sql = sqlAvailable ? 'partial' : 'unavailable';
  result.metrics.generatedSqlLines = sqlAvailable ? 0 : null;
  for (const { row } of winners.values()) {
    const lines = row.value.generatedLines;
    if (!Number.isSafeInteger(result.metrics.generatedSqlLines + lines)
      || !Number.isSafeInteger((daily.get(row.stat_date)?.generatedSqlLines || 0) + lines)) {
      status(row.audit, 'overflow');
      skip('sql_total_overflow', { rowKey: row.row_key }); continue;
    }
    result.metrics.generatedSqlLines += lines;
    if (row.source) row.source.countedSqlLines += lines;
    day(row.stat_date).generatedSqlLines += lines;
  }
  result.daily = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!sqlAvailable) for (const row of result.daily) row.generatedSqlLines = null;
  if (!durationAvailable) for (const row of result.daily) row.aiActiveDurationMs = null;
  return result;
}

const help = `单用户 AI 用量核算（只读；在项目目录运行，需要已安装服务依赖）

node scripts/audit-ai-usage-user.mjs --db /absolute/auth.db --tenant-id 1 --user-id 7 --from 2026-10-01 --to 2026-10-13

必填：--db 数据库绝对路径；--tenant-id 租户数字 ID；--user-id 用户数字 ID
      --from / --to 统计日期 YYYY-MM-DD（包含两端日期）
可选：--time-zone Asia/Shanghai（默认 AI_USAGE_TIMEZONE 或 Asia/Shanghai）
      --json 输出完整 JSON，含逐日结果、文件读取量、SQL 与历史时长证据及异常位置

请在能读取 runtime_home_path 所指向历史文件的服务主机/容器中运行。
AI 时长按主会话历史逐轮恢复用户发起到主助手完成的区间；实时请求表仅作诊断。
缺来源显示“不可用”，坏记录跳过；此脚本不回写看板，不以整段会话首尾跨度估算时长。
`;

async function main() {
  const { values } = parseArgs({ options: {
    db: { type: 'string' }, 'tenant-id': { type: 'string' }, 'user-id': { type: 'string' },
    from: { type: 'string' }, to: { type: 'string' }, 'time-zone': { type: 'string' },
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log(help); return; }
  for (const key of ['db', 'tenant-id', 'user-id', 'from', 'to']) {
    if (!values[key]) throw new Error(`缺少 --${key}；使用 --help 查看示例`);
  }
  const result = await auditUserUsage({ databasePath: values.db, tenantId: Number(values['tenant-id']),
    userId: Number(values['user-id']), from: values.from, to: values.to,
    timeZone: values['time-zone'] || process.env.AI_USAGE_TIMEZONE || 'Asia/Shanghai' });
  if (values.json) { console.log(JSON.stringify(result, null, 2)); return; }
  const seconds = result.metrics.aiActiveDurationSeconds;
  console.log(`租户 ${result.tenantId} / 用户 ${result.userId}（${result.userName}）`);
  console.log(`日期 ${result.range.from} 至 ${result.range.to}（${result.range.timeZone}，含首尾日期）`);
  console.log(`AI 活跃时长：${seconds === null ? '不可用' : `${seconds} 秒（${(seconds / 3600).toFixed(4)} 小时）`}`);
  console.log(`代码生成量：${result.metrics.generatedSqlLines === null ? '不可用' : `${result.metrics.generatedSqlLines} 行 SQL`}`);
  console.log(`来源：${result.scanned.durationFiles} 个主历史文件，${result.scanned.historyTurns} 个历史轮次（${result.scanned.completedHistoryTurns} 个完成）；${result.scanned.turnRecords} 条实时请求记录仅作诊断，${result.scanned.databaseMessages} 条数据库消息`);
  if (!result.scanned.durationFiles) console.log('时长不可用：未找到该租户、该用户可读取且归属明确的主会话历史。');
  for (const source of result.sources.slice(0, 20)) {
    console.log(`历史文件：${source.path} [${source.status}]，${source.linesRead} 行，${source.assistantMessages} 条 AI 回复，${source.sqlMessages} 条含 SQL，最终计入 ${source.countedSqlLines} 行 SQL、${source.countedDurationMs / 1000} 秒；历史轮次 ${source.historyTurns}，完成 ${source.completedHistoryTurns} [${source.durationStatus}]`);
  }
  console.log(`SQL 计入/排除：${JSON.stringify(result.sqlDiagnostics)}`);
  console.log(`历史时长计入/排除：${JSON.stringify(result.durationDiagnostics)}`);
  console.log(`跳过情况：${JSON.stringify(result.skipped)}`);
  console.log('仅统计现存可读来源；使用 --json 查看 SQL 文件行号、历史轮次起止与完成证据及计入/排除原因，不包含正文。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`核算失败：${error.message}`); process.exitCode = 1; });
}
