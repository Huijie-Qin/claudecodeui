import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { localParts, normalizeTimestamp, splitTurnByDate } from './ai-usage-config.js';
import { logicalSessionKey, parseUsageMessage, safeHookFields } from './ai-usage-parser.js';
import { isInheritedUsageMessage } from './ai-usage-inheritance.js';
import { collectSkillEvidence } from './ai-usage-skill-evidence.js';
import { createAiUsageSkillIndexer } from './ai-usage-skill-indexer.js';
import { createSkillPublisherResolver } from './ai-usage-skill-publishers.js';

const safeJson = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
const MAX_LINE_BYTES = 2 * 1024 * 1024;

export function createAiUsageIndexer({ store, config, batch, checkpoint, checkWindow }) {
  const db = store.database;
  const tenantId = batch.tenant_id;
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  const scopeNames = new Map();
  const resolvePublisher = createSkillPublisherResolver(db, tenantId);

  function enrich(row) {
    if (row.dataset === 'skill_evidence') return row;
    const scope = `${row.user_id}:${row.workspace_id}`;
    if (!scopeNames.has(scope)) {
      const user = db.prepare('SELECT username FROM users WHERE id=?').get(row.user_id);
      const workspace = db.prepare('SELECT display_name,status FROM workspaces WHERE id=? AND tenant_id=?').get(row.workspace_id, tenantId);
      const template = tables.has('workspace_agent_template_snapshots')
        ? db.prepare(`SELECT s.template_id,s.template_name,s.created_at FROM workspace_agent_template_snapshots s
          JOIN workspaces w ON w.id=s.workspace_id WHERE w.tenant_id=? AND s.workspace_id=?`).get(tenantId, row.workspace_id) : null;
      scopeNames.set(scope, { userName: user?.username ?? null, workspaceName: workspace?.display_name ?? null,
        workspaceStatus: workspace?.status ?? null, template });
    }
    const { template, ...names } = scopeNames.get(scope);
    const applicationTime = normalizeTimestamp(template?.created_at);
    const templateInfo = applicationTime && row.occurred_at >= applicationTime ? {
      templateId: template.template_id, templateName: template.template_name, templateAppliedAt: applicationTime,
    } : {};
    row.value = { ...names, ...templateInfo, ...row.value };
    if (row.dataset === 'skill_invocations') {
      const binding = db.prepare(`SELECT * FROM ai_skill_binding_history
        WHERE tenant_id=? AND workspace_id=? AND local_name=? AND valid_from<=?
        AND (valid_to IS NULL OR valid_to>?) ORDER BY valid_from DESC LIMIT 1`)
        .get(tenantId, row.workspace_id, row.value.skillName, row.occurred_at, row.occurred_at);
      if (binding) {
        const publisherUserId = resolvePublisher(binding, row.occurred_at);
        row.subject_id = binding.remote_skill_id;
        row.value = { ...row.value, skillId: binding.remote_skill_id,
          callerUserName: row.value.userName,
          userName: publisherUserId ? db.prepare('SELECT username FROM users WHERE id=?').get(publisherUserId)?.username ?? null : null,
          publisherUserId, attribution: publisherUserId ? 'confirmed' : 'unresolved' };
        // Contributions belong to the publisher. The caller remains a separate dimension.
        row.user_id = publisherUserId;
      } else row.user_id = null;
    }
    return row;
  }

  const bootstrapSources = [
    { table: 'agent_session_messages', type: 'message', key: 'id' },
    { table: 'ai_usage_turn_facts', type: 'turn', key: 'turn_key' },
    { table: 'hook_data_records', type: 'hook', key: 'id' },
    { table: 'hook_executions', type: 'hook_execution', key: 'id' },
    { table: 'workspace_agent_template_snapshots', type: 'template', key: 'workspace_id' },
    { table: 'ai_skill_publications', type: 'publication', key: 'operation_id' },
    { table: 'ai_mr_submissions', type: 'code_submission', key: 'id' },
    { table: 'ai_usage_skill_context', type: 'skill_session', key: 'json_array(tenant_id,workspace_id,user_id,provider,session_id)' },
  ];

  async function bootstrap(progress) {
    const state = db.prepare('SELECT * FROM ai_usage_tenant_state WHERE tenant_id=?').get(tenantId);
    if (state?.bootstrapped) return;
    const position = safeJson(state?.bootstrap_json || '{}');
    for (let index = position.index || 0; index < bootstrapSources.length; index++) {
      const source = bootstrapSources[index];
      if (!tables.has(source.table)) continue;
      let cursor = index === position.index ? position.cursor : null;
      while (true) {
        checkWindow();
        const filter = source.type === 'template'
          ? 'workspace_id IN (SELECT id FROM workspaces WHERE tenant_id=?)' : source.type === 'skill_session'
            ? "tenant_id=? AND session_id IS NOT NULL AND session_id<>''" : 'tenant_id=?';
        const records = db.prepare(`SELECT ${source.key} AS source_key FROM ${source.table}
          WHERE ${filter} ${cursor == null ? '' : `AND ${source.key}>?`} ORDER BY ${source.key} LIMIT ?`)
          .all(...(cursor == null ? [tenantId, config.batchSize] : [tenantId, cursor, config.batchSize]));
        if (!records.length) break;
        store.transaction(() => {
          store.assertLease(batch);
          for (const record of records) db.prepare(`INSERT OR IGNORE INTO ai_usage_source_changes(tenant_id,source_type,source_key)
            VALUES(?,?,?)`).run(tenantId, source.type, String(record.source_key));
          cursor = records.at(-1).source_key;
          db.prepare('UPDATE ai_usage_tenant_state SET bootstrap_json=? WHERE tenant_id=?')
            .run(JSON.stringify({ index, cursor }), tenantId);
        });
        await checkpoint(progress);
      }
      db.prepare('UPDATE ai_usage_tenant_state SET bootstrap_json=? WHERE tenant_id=?')
        .run(JSON.stringify({ index: index + 1 }), tenantId);
    }
    db.prepare('UPDATE ai_usage_tenant_state SET bootstrapped=1 WHERE tenant_id=?').run(tenantId);
  }

  function sourceRows(change) {
    if (change.source_type === 'skill_session' || change.source_type === 'skill_binding') return [];
    const source = bootstrapSources.find((entry) => entry.type === change.source_type);
    if (!source || !tables.has(source.table)) return [];
    const row = db.prepare(`SELECT * FROM ${source.table} WHERE ${source.key}=?`).get(change.source_key);
    if (!row) return [];
    if (source.type === 'template') {
      if (!db.prepare('SELECT 1 FROM workspaces WHERE id=? AND tenant_id=?').get(row.workspace_id, tenantId)) return [];
    } else if (row.tenant_id !== tenantId) return [];
    if (source.type === 'code_submission' && row.status !== 'merged') return [];
    const time = normalizeTimestamp(source.type === 'code_submission' ? row.merged_at : source.type === 'hook_execution' && row.started_at_ms != null
      ? row.started_at_ms : row.started_at || row.first_published_at || row.provider_timestamp || row.created_at);
    if (!time) return [];
    const base = { user_id: row.user_id ?? row.created_by_user_id ?? null, workspace_id: row.workspace_id ?? null,
      occurred_at: time, stat_date: localParts(time, config.timeZone).date, session_key: row.session_id || row.session_key || null };
    if (source.type === 'code_submission') {
      return [{ ...base, dataset: 'code_submissions', row_key: String(row.id), subject_id: String(row.id),
        value: { submittedLines: Number.isSafeInteger(row.additions) && row.additions >= 0 ? row.additions : null,
          repositoryUrl: row.repository_url, commitSha: row.commit_sha, mrId: row.mr_id ?? null, status: 'merged' } }];
    }
    if (source.type === 'message') {
      if (!row.provider_session_id) return [];
      // Native histories are authoritative for Claude. A legacy copy cannot add
      // a second population when its canonical transcript is readable.
      if (row.provider === 'claude' && db.prepare(`SELECT 1 FROM ai_usage_source_states WHERE tenant_id=?
        AND json_extract(state_json,'$.sessionKey')=? AND json_extract(state_json,'$.readable')=1
        AND json_extract(state_json,'$.isMain')=1 LIMIT 1`)
        .get(tenantId, logicalSessionKey(row))) return [];
      return messageRows(row, safeJson(row.normalized_json), {
        timeZone: config.timeZone, fallbackId: row.message_id,
        includeBoundaries: true,
        fallbackTime: row.provider_timestamp, // migration/import time is not business time
      }).map((fact) => fact.dataset === 'skill_evidence' ? { ...fact, value: { ...fact.value,
        sourceRuntimeId: row.runtime_id || null,
        sourceSequence: Number.isSafeInteger(row.sequence) && row.sequence > 0 ? row.sequence : null } } : fact);
    }
    if (source.type === 'turn') {
      if (!row.session_key) return [];
      const sessionKey = logicalSessionKey({ ...row, provider_session_id: row.session_key });
      const value = { provider: row.provider, turnKey: row.turn_key, status: row.terminal_status,
        requestStartedAt: row.started_at, responseCompletedAt: row.response_completed_at };
      const rows = [{ ...base, dataset: 'interactions', row_key: `${sessionKey}:request:${row.turn_key}`, session_key: sessionKey,
        value: { provider: row.provider, providerSessionId: row.session_key, source: row.source } }];
      if (row.terminal_status === 'completed' && row.response_completed_at) {
        for (const part of splitTurnByDate(row.started_at, row.response_completed_at, config.timeZone)) {
          checkWindow();
          rows.push({ ...base, dataset: 'turns', row_key: `${row.turn_key}:${part.date}`, stat_date: part.date,
            session_key: sessionKey, value: { ...value, durationMs: part.durationMs } });
        }
      } else rows.push({ ...base, dataset: 'turns', row_key: `${row.turn_key}:pending`, session_key: sessionKey,
        value: { ...value, durationMs: null } });
      return rows;
    }
    if (source.type === 'hook') {
      const hook = tables.has('hooks') ? db.prepare('SELECT name FROM hooks WHERE id=?').get(row.hook_id) : null;
      const published = row.hook_version != null && row.post_action_id && tables.has('hook_published_versions')
        ? db.prepare('SELECT config_json FROM hook_published_versions WHERE hook_id=? AND version=?').get(row.hook_id, row.hook_version) : null;
      const action = published ? safeJson(published.config_json).postActions?.find((entry) => entry.id === row.post_action_id
        && entry.type === 'write_record' && entry.config?.recordType === row.record_type) : null;
      return [{ ...base, dataset: 'hook_records', row_key: row.id, subject_id: row.hook_id,
        session_key: row.session_id ? JSON.stringify([tenantId, row.workspace_id, row.user_id, row.session_id]) : null,
        value: { hookId: row.hook_id, hookName: hook?.name || row.hook_id, postActionId: row.post_action_id || null,
          recordType: row.record_type, hookVersion: row.hook_version ?? null, recordSource: row.record_source || 'unknown',
          ...safeHookFields(row.record_type, safeJson(row.data_json), action?.config?.reportFields ?? null) } }];
    }
    if (source.type === 'hook_execution') {
      const hook = tables.has('hooks') ? db.prepare('SELECT name FROM hooks WHERE id=?').get(row.hook_id) : null;
      const durationMs = row.status !== 'running' && Number.isFinite(row.duration_ms) && row.duration_ms >= 0 ? row.duration_ms : null;
      return [{ ...base, dataset: 'hook_executions', row_key: row.id, subject_id: row.hook_id,
        session_key: row.session_id ? JSON.stringify([tenantId, row.workspace_id, row.user_id, row.session_id]) : null,
        value: { hookName: hook?.name || row.hook_id, hookVersion: row.hook_version, eventName: row.event_name,
          status: row.status, durationMs, completedAt: normalizeTimestamp(row.completed_at_ms ?? row.completed_at) } }];
    }
    if (source.type === 'template') return [{ ...base, dataset: 'template_applications', row_key: String(row.workspace_id),
      subject_id: String(row.template_id), value: { templateId: row.template_id, templateName: row.template_name,
        templateUpdatedAt: normalizeTimestamp(row.template_updated_at) } }];
    if (source.type === 'publication') {
      if (row.status !== 'confirmed' || !row.first_published_at || !row.skill_id) return [];
      return [{ ...base, dataset: 'skill_publications', row_key: row.skill_id, subject_id: row.skill_id,
        value: { skillId: row.skill_id, skillName: row.skill_name, publisherUserId: row.user_id } }];
    }
    return [];
  }

  function messageRows(scope, message, options) {
    // Native tool events are evidence, not final counts. Correlate them with
    // slash requests and trusted origins once per affected session at night.
    return [...parseUsageMessage(scope, message, { ...options, includeSkillTools: false }),
      ...collectSkillEvidence(scope, message, options)];
  }

  async function changedSources(progress) {
    while (true) {
      checkWindow();
      const cursor = progress.sourceCursor || ['', ''];
      const changes = db.prepare(`SELECT * FROM ai_usage_source_changes WHERE tenant_id=?
        AND (source_type,source_key)>(?,?) ORDER BY source_type,source_key LIMIT ?`).all(tenantId, ...cursor, config.batchSize);
      if (!changes.length) break;
      for (const change of changes) {
        checkWindow();
        const rows = sourceRows(change).map(enrich);
        store.transaction(() => {
          store.assertLease(batch);
          if (change.source_type === 'publication') {
            // Late confirmation/correction also affects calls in OTHER users'
            // workspaces. Queue metadata only; the next skills stage repairs
            // the historical partitions without rescanning message bodies.
            db.prepare(`INSERT INTO ai_usage_source_changes(tenant_id,source_type,source_key)
              SELECT DISTINCT tenant_id,'skill_binding',CAST(workspace_id AS TEXT)
              FROM ai_skill_binding_history WHERE tenant_id=? AND remote_skill_id IN (
                SELECT skill_id FROM ai_skill_publications WHERE tenant_id=? AND operation_id=?
                UNION SELECT subject_id FROM ai_usage_fact_rows WHERE tenant_id=? AND source_key=? AND dataset='skill_publications'
              ) ON CONFLICT(tenant_id,source_type,source_key) DO UPDATE SET generation=generation+1`)
              .run(tenantId, tenantId, change.source_key, tenantId, `publication:${change.source_key}`);
          }
          if (change.source_type === 'skill_session') db.prepare(`INSERT INTO ai_usage_dirty_skill_sessions(tenant_id,session_key)
            VALUES(?,?) ON CONFLICT(tenant_id,session_key) DO UPDATE SET generation=generation+1`).run(tenantId, change.source_key);
          if (change.source_type === 'skill_binding') {
            db.prepare(`INSERT INTO ai_usage_dirty_skill_sessions(tenant_id,session_key)
              SELECT DISTINCT tenant_id,session_key FROM ai_usage_fact_rows
              WHERE tenant_id=? AND dataset='skill_evidence' AND workspace_id=? AND session_key IS NOT NULL
              ON CONFLICT(tenant_id,session_key) DO UPDATE SET generation=generation+1`).run(tenantId, change.source_key);
            db.prepare(`INSERT INTO ai_usage_dirty_skill_sessions(tenant_id,session_key)
              SELECT DISTINCT tenant_id,json_array(tenant_id,workspace_id,user_id,provider,session_id)
              FROM ai_usage_skill_context WHERE tenant_id=? AND workspace_id=? AND session_id IS NOT NULL
              ON CONFLICT(tenant_id,session_key) DO UPDATE SET generation=generation+1`).run(tenantId, change.source_key);
          }
          store.put(tenantId, `${change.source_type}:${change.source_key}`, rows, { replace: true });
          db.prepare('DELETE FROM ai_usage_source_changes WHERE tenant_id=? AND source_type=? AND source_key=? AND generation=?')
            .run(tenantId, change.source_type, change.source_key, change.generation);
        });
        progress.sourceCursor = [change.source_type, change.source_key];
      }
      await checkpoint(progress);
    }
  }

  async function* filesIn(directory) {
    let handle;
    try { handle = await fs.opendir(directory); } catch (error) {
      if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) return;
      throw error;
    }
    for await (const entry of handle) { checkWindow(); yield entry; }
  }

  async function indexFile(file, scope, subagentId, progress, isDisplayCommands = false) {
    const sourceKey = `jsonl:${logicalSessionKey(scope)}:${file}`;
    const state = db.prepare('SELECT * FROM ai_usage_source_states WHERE tenant_id=? AND source_key=?').get(tenantId, sourceKey);
    let handle;
    try { handle = await fs.open(file, 'r'); } catch { return false; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return false;
      const identity = `${stat.dev}:${stat.ino}`;
      const previousState = safeJson(state?.state_json);
      if (state && previousState.readable && stat.size === state.size && stat.mtimeMs === state.mtime_ms
        && identity === state.identity && state.offset === stat.size) return true;
      let offset = state?.offset || 0;
      let skipLine = safeJson(state?.state_json).skipLine || false;
      let skillState = previousState.skillState || {};
      const prefix = Buffer.alloc(Math.min(4096, stat.size, Math.max(offset, 0)));
      if (prefix.length) await handle.read(prefix, 0, prefix.length, 0);
      const fingerprint = createHash('sha256').update(prefix).digest('hex');
      const reset = state && (!previousState.readable || identity !== state.identity || stat.size < offset
        || (state.fingerprint && prefix.length === Math.min(offset, 4096) && fingerprint !== state.fingerprint)
        || (stat.size === state.size && stat.mtimeMs !== state.mtime_ms && offset === stat.size));
      if (reset) {
        store.transaction(() => { store.assertLease(batch); store.put(tenantId, sourceKey, [], { replace: true }); });
        offset = 0; skipLine = false; skillState = {};
      }
      let length = 256 * 1024;
      do {
        checkWindow();
        const buffer = Buffer.alloc(Math.min(length, stat.size - offset));
        const { bytesRead } = buffer.length ? await handle.read(buffer, 0, buffer.length, offset) : { bytesRead: 0 };
        const bytes = buffer.subarray(0, bytesRead);
        let end = bytes.lastIndexOf(10);
        if (bytesRead && end < 0 && length < MAX_LINE_BYTES && offset + bytesRead < stat.size) {
          length = Math.min(length * 2, MAX_LINE_BYTES); continue;
        }
        const rows = [];
        let nextOffset = offset;
        if (end >= 0) {
          let start = 0;
          if (skipLine) { start = bytes.indexOf(10) + 1; skipLine = false; }
          const lines = bytes.subarray(start, end + 1).toString('utf8').split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            const message = safeJson(line, null);
            if (!message || isInheritedUsageMessage(message)
              || (message.sessionId && !subagentId && message.sessionId !== scope.provider_session_id)) continue;
            if (isDisplayCommands) {
              const command = typeof message.displayCommand === 'string'
                ? message.displayCommand.trim().match(/^\/([^\s/<>]+)(?:\s|$)/) : null;
              if (command && typeof message.messageId === 'string' && message.messageId) {
                const sessionKey = logicalSessionKey(scope);
                rows.push({ dataset: 'skill_evidence', row_key: `${sessionKey}:display:${message.messageId}`,
                  stat_date: '', user_id: scope.user_id, workspace_id: scope.workspace_id, session_key: sessionKey,
                  occurred_at: null, value: { kind: 'display_command', provider: scope.provider,
                    providerSessionId: scope.provider_session_id, requestId: message.messageId,
                    messageId: message.messageId, skillName: command[1].slice(0, 200), origin: 'user', subagentId: null } });
              }
            } else rows.push(...messageRows(scope, message, {
              timeZone: config.timeZone, subagentId, state: skillState,
            }).map(enrich));
          }
          nextOffset += end + 1;
        } else if (bytesRead >= MAX_LINE_BYTES) {
          nextOffset += bytesRead; skipLine = true;
        }
        const prefixLength = Math.min(nextOffset, 4096);
        const newPrefix = Buffer.alloc(prefixLength);
        if (prefixLength) await handle.read(newPrefix, 0, prefixLength, 0);
        const hash = createHash('sha256').update(newPrefix).digest('hex');
        store.transaction(() => {
          store.assertLease(batch);
          store.put(tenantId, sourceKey, rows, { priority: 30 });
          db.prepare(`INSERT INTO ai_usage_source_states(tenant_id,source_key,offset,size,mtime_ms,identity,fingerprint,state_json,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,source_key) DO UPDATE SET
            offset=excluded.offset,size=excluded.size,mtime_ms=excluded.mtime_ms,identity=excluded.identity,
            fingerprint=excluded.fingerprint,state_json=excluded.state_json,updated_at=excluded.updated_at`)
            .run(tenantId, sourceKey, nextOffset, stat.size, stat.mtimeMs, identity, hash,
              JSON.stringify({ sessionKey: logicalSessionKey(scope), readable: true,
                isMain: !subagentId && !isDisplayCommands, skipLine, skillState }), new Date().toISOString());
          // Reconcile already-indexed DB copies, not just future message writes.
          // Persist with the first readable state so a crash cannot lose this work.
          if (!subagentId && !isDisplayCommands && !previousState.readable && offset === 0 && tables.has('agent_session_messages')) {
            queueSessionMessages(logicalSessionKey(scope));
          }
        });
        await checkpoint(progress);
        if (nextOffset === offset) break; // leave a partial final line for the next night
        offset = nextOffset;
        length = 256 * 1024;
      } while (offset < stat.size);
      return true;
    } finally { await handle.close(); }
  }

  function queueSessionMessages(sessionKey) {
    const session = safeJson(sessionKey, []);
    if (tables.has('agent_session_messages') && session.length === 5) db.prepare(`INSERT INTO ai_usage_source_changes(tenant_id,source_type,source_key)
      SELECT tenant_id,'message',CAST(id AS TEXT) FROM agent_session_messages WHERE tenant_id=? AND workspace_id=? AND user_id=? AND provider=? AND provider_session_id=?
      ON CONFLICT(tenant_id,source_type,source_key) DO UPDATE SET generation=generation+1`).run(...session);
  }

  async function transcripts(progress) {
    if (!tables.has('agent_session_runtime') || !tables.has('session_index')) return;
    const runtimes = db.prepare("SELECT * FROM agent_session_runtime WHERE tenant_id=? AND provider='claude'").all(tenantId);
    const sessions = new Set(db.prepare("SELECT * FROM session_index WHERE tenant_id=? AND provider='claude'")
      .all(tenantId).map(logicalSessionKey));
    for (const runtime of runtimes) if (runtime.provider_session_id) sessions.add(logicalSessionKey(runtime));
    const homes = new Map(runtimes.map((runtime) => [JSON.stringify([
      runtime.tenant_id, runtime.workspace_id, runtime.user_id, runtime.runtime_home_path,
    ]), runtime]));
    const seen = new Set();
    const afterCursor = (position) => {
      const cursor = progress.fileCursor;
      if (!cursor) return true;
      for (let index = 0; index < position.length; index++) {
        if (position[index] !== cursor[index]) return position[index] > cursor[index];
      }
      return false;
    };
    async function visit(file, scope, subagentId, position, isDisplayCommands = false) {
      if (!afterCursor(position)) return;
      const sourceKey = `jsonl:${logicalSessionKey(scope)}:${file}`;
      const readable = await indexFile(file, scope, subagentId, progress, isDisplayCommands);
      store.transaction(() => {
        store.assertLease(batch);
        db.prepare('INSERT OR REPLACE INTO ai_usage_batch_files(batch_id,source_key,readable) VALUES(?,?,?)')
          .run(batch.id, sourceKey, readable ? 1 : 0);
        progress.fileCursor = position;
        store.checkpoint(batch, progress, config);
      });
      await checkpoint(progress);
    }
    async function sortedEntries(directory) {
      const entries = [];
      for await (const entry of filesIn(directory)) entries.push(entry);
      return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    }
    for (const [homeKey, runtime] of [...homes.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const root = path.join(runtime.runtime_home_path, '.claude', 'projects');
      for (const project of await sortedEntries(root)) {
        if (!project.isDirectory()) continue;
        const directory = path.join(root, project.name);
        for (const entry of await sortedEntries(directory)) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          const sessionId = entry.name.slice(0, -6);
          const scope = { ...runtime, provider_session_id: sessionId };
          if (!sessions.has(logicalSessionKey(scope))) continue;
          const file = path.join(directory, entry.name);
          const key = `jsonl:${logicalSessionKey(scope)}:${file}`;
          if (seen.has(key)) continue;
          seen.add(key);
          await visit(file, scope, null, [homeKey, project.name, entry.name, '0']);
          for (const sub of await sortedEntries(path.join(directory, sessionId, 'subagents'))) {
            if (sub.isFile() && sub.name.endsWith('.jsonl')) {
              await visit(path.join(directory, sessionId, 'subagents', sub.name), scope, sub.name.slice(0, -6).replace(/^agent-/, ''),
                [homeKey, project.name, entry.name, `1:${sub.name}`]);
            }
          }
          const displayCommands = path.join(directory, sessionId, 'display-commands.jsonl');
          // The existing UI sidecar supplies only the original command name.
          // Its file mtime is never used as a business timestamp.
          try {
            if ((await fs.stat(displayCommands)).isFile()) await visit(displayCommands, scope, null,
              [homeKey, project.name, entry.name, '2:display-commands'], true);
          } catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
        }
      }
    }
    // Discovery itself is checkpointed above. Only after it finishes may unseen
    // histories be marked missing; an interrupted traversal is not deletion.
    const missing = db.prepare(`SELECT * FROM ai_usage_source_states s WHERE s.tenant_id=?
      AND s.source_key LIKE 'jsonl:%' AND json_extract(s.state_json,'$.readable')=1
      AND NOT EXISTS(SELECT 1 FROM ai_usage_batch_files f WHERE f.batch_id=? AND f.source_key=s.source_key AND f.readable=1)`)
      .all(tenantId, batch.id);
    for (const state of missing) {
      checkWindow();
      store.transaction(() => {
        store.assertLease(batch);
        store.put(tenantId, state.source_key, [], { replace: true });
        db.prepare("UPDATE ai_usage_source_states SET state_json=json_set(state_json,'$.readable',0) WHERE tenant_id=? AND source_key=?")
          .run(tenantId, state.source_key);
        queueSessionMessages(safeJson(state.state_json).sessionKey);
      });
      await checkpoint(progress);
    }
  }

  const skills = createAiUsageSkillIndexer({ store, config, batch, checkpoint, checkWindow, enrich });

  function coverage() {
    const statuses = db.prepare(`SELECT terminal_status,COUNT(*) AS count FROM ai_usage_turn_facts
      WHERE tenant_id=? AND started_at<? GROUP BY terminal_status`).all(tenantId, batch.target_through);
    const counts = Object.fromEntries(statuses.map((row) => [row.terminal_status, row.count]));
    const publications = db.prepare("SELECT COUNT(*) AS count FROM ai_skill_publications WHERE tenant_id=? AND status='confirmed'").get(tenantId).count;
    // A malformed merged record must not make a successfully read source look
    // fully covered. Do not guess its business day or substitute created_at.
    const invalidMerged = tables.has('ai_mr_submissions') ? db.prepare(`SELECT COUNT(*) AS n FROM ai_mr_submissions
      WHERE tenant_id=? AND status='merged' AND (
        merged_at IS NULL OR julianday(merged_at) IS NULL OR
        (julianday(merged_at)<julianday(?) AND
          (additions IS NULL OR typeof(additions) NOT IN ('integer','real') OR additions<0
            OR additions>9007199254740991 OR additions!=CAST(additions AS INTEGER))))`).get(tenantId, batch.target_through).n : 0;
    return { sessions: 'partial', duration: counts.completed ? 'partial' : 'unavailable', skillPublications: publications ? 'partial' : 'unavailable',
      skillInvocations: 'partial', hooks: tables.has('hook_data_records') ? 'complete' : 'unavailable', hookExecutions: tables.has('hook_executions') ? 'complete' : 'unavailable',
      templates: tables.has('workspace_agent_template_snapshots') ? 'complete' : 'unavailable',
      codeSubmissions: tables.has('ai_mr_submissions') ? invalidMerged ? 'partial' : 'complete' : 'unavailable', pendingTurns: counts.pending || 0,
      incompleteTurns: counts.incomplete || 0, failedTurns: counts.failed || 0,
      cancelledTurns: (counts.cancelled || 0) + (counts.aborted || 0), unsupportedTurns: counts.unsupported || 0,
      reasons: [...(invalidMerged ? ['Merged MR records with missing/invalid merge times or additions limit code coverage.'] : []), 'Only retained, readable histories are included.',
        'Historical request boundaries and historical Skill publisher bindings may be unavailable.'] };
  }

  return { bootstrap, transcripts, changedSources, skills, coverage };
}
