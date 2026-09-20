import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';

import { normalizeTimestamp } from './ai-usage-config.js';
import { SESSION_REPORT_VERSION, sessionScope, sessionReportRows } from './ai-usage-session-report.js';
import { createSessionTokenAccumulator } from './ai-session-tokens.js';

const json = value => { try { return JSON.parse(value); } catch { return null; } };
const hash = value => createHash('sha256').update(value).digest('hex');
const exists = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));

export function scopeValidator(db) {
  // provider_session_id alone is not globally unique. Resolve the original
  // session using the SAME owner/provider identity as session_index's key.
  const session = exists(db, 'session_index') ? db.prepare(`SELECT tenant_id,workspace_id
    FROM session_index WHERE provider=? AND provider_session_id=? AND user_id=? LIMIT 2`) : null;
  const workspace = exists(db, 'workspaces') ? db.prepare('SELECT tenant_id FROM workspaces WHERE id=?') : null;
  return row => {
    const originals = session?.all(row.provider, row.session_id, row.user_id) || [];
    if (originals.length > 1 || originals.some(original => original.tenant_id !== row.tenant_id
      || original.workspace_id !== row.workspace_id)) throw new Error('SESSION_SUMMARY_SOURCE_SCOPE_CONFLICT');
    const originalWorkspace = workspace?.get(row.workspace_id);
    if (originalWorkspace && originalWorkspace.tenant_id !== row.tenant_id) throw new Error('SESSION_SUMMARY_WORKSPACE_SCOPE_CONFLICT');
    // Older sessions may only have trusted captured facts/runtime bindings.
    // Missing metadata must not be invented or silently used to reassign them.
  };
}

// Read only files already associated with this tenant/session by the trusted
// nightly indexer. Never search the host's global personal history directories.
async function readIndexedTranscript(source, scope, accumulator, checkWindow) {
  const state = json(source.state_json);
  if (!state?.readable) { accumulator.invalidate(); return; }
  const prefix = `jsonl:${state.sessionKey}:`;
  if (!source.source_key.startsWith(prefix)) { accumulator.invalidate(); return; }
  let handle;
  try { handle = await open(source.source_key.slice(prefix.length), 'r'); }
  catch { accumulator.invalidate(); return; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || `${stat.dev}:${stat.ino}` !== source.identity || stat.size < source.offset
      || (stat.size === source.size && stat.mtimeMs !== source.mtime_ms)) {
      accumulator.invalidate(); return;
    }
    const first = Buffer.alloc(Math.min(4096, source.offset));
    if (first.length) await handle.read(first, 0, first.length, 0);
    if (source.fingerprint && hash(first) !== source.fingerprint) { accumulator.invalidate(); return; }
    let offset = 0;
    let carry = Buffer.alloc(0);
    let oversized = false;
    while (offset < source.offset) {
      checkWindow();
      const buffer = Buffer.alloc(Math.min(256 * 1024, source.offset - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) { accumulator.invalidate(); break; }
      offset += bytesRead;
      const chunk = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      let start = 0;
      for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
        if (!oversized && end - start <= 2 * 1024 * 1024) {
          const line = chunk.subarray(start, end).toString('utf8').trim();
          if (line) {
            const raw = json(line);
            if (!raw) accumulator.invalidate();
            else if (!state.isMain || !raw.sessionId || raw.sessionId === scope.session_id) {
              accumulator.observe(raw, { isMain: Boolean(state.isMain) });
            }
          }
        } else accumulator.invalidate();
        oversized = false;
        start = end + 1;
      }
      carry = chunk.subarray(start);
      if (carry.length > 2 * 1024 * 1024) {
        carry = Buffer.alloc(0); oversized = true; accumulator.invalidate();
      }
      await yieldEventLoop();
    }
    // Indexer offsets cover complete lines only. Do not accept a truncated tail.
    if (carry.length || oversized) accumulator.invalidate();
    const after = await handle.stat();
    if (after.size < stat.size || (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)) accumulator.invalidate();
  } finally { await handle.close(); }
}

/** Enrich the ORIGINAL report, before deriving any consumer projection. */
export async function collectReportSessionUsage({ database: db, tenantId, through, batchId, checkWindow = () => {} }) {
  through = normalizeTimestamp(through);
  if (!through) throw new Error('SESSION_SUMMARY_CUTOFF_REQUIRED');
  const sessions = new Map();
  for (const row of sessionReportRows(db, tenantId, batchId)) {
    checkWindow();
    if (row.dataset !== 'interactions') continue;
    const time = normalizeTimestamp(row.occurred_at);
    if (!time || time >= through) continue;
    const scope = sessionScope(row.session_key, tenantId);
    if (!scope) continue;
    if (scope.user_id !== row.user_id || scope.workspace_id !== row.workspace_id) throw new Error('SESSION_SUMMARY_FACT_SCOPE_CONFLICT');
    const previous = sessions.get(row.session_key);
    if (!previous || time < previous.start) sessions.set(row.session_key, {
      ...scope, key: row.session_key, start: time, date: row.stat_date,
    });
  }
  const sources = new Map();
  for (const source of db.prepare("SELECT * FROM ai_usage_source_states WHERE tenant_id=? AND source_key LIKE 'jsonl:%'").all(tenantId)) {
    const state = json(source.state_json);
    if (!state?.sessionKey || state.isDisplayCommands) continue;
    if (!sources.has(state.sessionKey)) sources.set(state.sessionKey, []);
    sources.get(state.sessionKey).push(source);
  }
  const user = exists(db, 'users') ? db.prepare('SELECT username FROM users WHERE id=?') : null;
  const deletedSession = exists(db, 'session_index')
    && db.prepare('PRAGMA table_info(session_index)').all().some(column => column.name === 'status')
    ? db.prepare(`SELECT 1 FROM session_index WHERE tenant_id=? AND workspace_id=? AND user_id=?
      AND provider=? AND provider_session_id=? AND status='deleted'`) : null;
  const messages = exists(db, 'agent_session_messages') ? db.prepare(`SELECT id,normalized_json,provider_timestamp
    FROM agent_session_messages WHERE tenant_id=? AND workspace_id=? AND user_id=? AND provider=?
      AND provider_session_id=? AND id>? ORDER BY id LIMIT 500`) : null;
  const rows = [];
  const validateScope = scopeValidator(db);
  for (const session of sessions.values()) {
    checkWindow();
    if (!session.start) continue;
    const identity = [tenantId, session.workspace_id, session.user_id, session.provider, session.session_id];
    const deleted = Boolean(deletedSession?.get(...identity));
    validateScope(session);
    const tokens = createSessionTokenAccumulator(session.provider, through);
    const native = sources.get(session.key) || [];
    if (deleted) {
      tokens.invalidate();
    } else if (native.length) {
      if (!native.some(source => json(source.state_json)?.isMain)) tokens.invalidate();
      // Do not add database copies on top of authoritative native histories.
      for (const source of native) await readIndexedTranscript(source, session, tokens, checkWindow);
    } else if (messages) {
      let cursor = 0;
      while (true) {
        checkWindow();
        const page = messages.all(...identity, cursor);
        if (!page.length) break;
        for (const message of page) {
          const raw = json(message.normalized_json);
          if (raw) tokens.observe(raw, { fallbackTime: message.provider_timestamp });
        }
        cursor = page.at(-1).id;
        await yieldEventLoop();
      }
    }
    const result = tokens.result();
    rows.push({
      tenant_id: tenantId, dataset: 'session_usage', row_key: session.id, stat_date: session.date,
      user_id: session.user_id, workspace_id: session.workspace_id, subject_id: null,
      session_key: session.key, occurred_at: session.start,
      value_json: JSON.stringify({ version: SESSION_REPORT_VERSION, through, deleted,
        provider: session.provider, providerSessionId: session.session_id,
        userName: user?.get(session.user_id)?.username ?? null,
        totalTokens: result.total, responseCompletedAt: result.end }),
    });
    await yieldEventLoop();
  }
  return rows.sort((a, b) => a.row_key.localeCompare(b.row_key));
}

// Replace only this report dataset, never other report metrics or consumer rows.
export function replaceReportSessionUsage(db, tenantId, rows, batchId) {
  const table = batchId ? 'ai_usage_report_staging' : 'ai_usage_report_rows';
  db.prepare(`DELETE FROM ${table} WHERE tenant_id=? AND dataset='session_usage' ${batchId ? 'AND batch_id=?' : ''}`)
    .run(tenantId, ...(batchId ? [batchId] : []));
  const columns = 'tenant_id,dataset,row_key,stat_date,user_id,workspace_id,subject_id,session_key,occurred_at,value_json';
  const insert = db.prepare(`INSERT INTO ${table}(${batchId ? 'batch_id,' : ''}${columns})
    VALUES(${batchId ? '@batch_id,' : ''}${columns.split(',').map(c => '@' + c).join(',')})`);
  for (const row of rows) {
    if (row.tenant_id !== tenantId || row.dataset !== 'session_usage') throw new Error('SESSION_REPORT_SCOPE_CONFLICT');
    insert.run({ ...row, ...(batchId ? { batch_id: batchId } : {}) });
  }
}

export async function buildReportSessionUsageCandidate({ store, batch, progress, checkpoint, checkWindow }) {
  const rows = await collectReportSessionUsage({ database: store.database, tenantId: batch.tenant_id,
    through: batch.target_through, batchId: batch.id, checkWindow });
  checkWindow();
  store.transaction(() => {
    store.assertLease(batch);
    replaceReportSessionUsage(store.database, batch.tenant_id, rows, batch.id);
  });
  progress.reportSessionUsage = { ready: true, version: SESSION_REPORT_VERSION };
  delete progress.sessionSummary;
  await checkpoint();
}

// Revalidate original ownership at the source-report publication boundary.
export function validateReportSessionUsageCandidate(db, batch) {
  const validate = scopeValidator(db);
  for (const row of sessionReportRows(db, batch.tenant_id, batch.id)) {
    if (row.dataset !== 'session_usage') continue;
    const scope = sessionScope(row.session_key, batch.tenant_id);
    if (!scope) throw new Error('SESSION_REPORT_SCOPE_CONFLICT');
    validate(scope);
  }
}
