import { localParts, normalizeTimestamp } from './ai-usage-config.js';
import { reconcileSkillEvidence } from './ai-usage-skill-evidence.js';

const json = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };

// Persist small source references, not bodies or an ever-growing JSON progress
// payload. Correlation is atomic per request (or unassociated tool), never per
// entire conversation. A long conversation resumes at its next metadata page.
export function createAiUsageSkillIndexer({ store, config, batch, checkpoint, checkWindow, enrich }) {
  const db = store.database;
  const tenantId = batch.tenant_id;
  const addItem = db.prepare(`INSERT OR IGNORE INTO ai_usage_skill_work_items
    (batch_id,session_key,group_key,kind,item_key,source_key) VALUES(?,?,?,?,?,?)`);
  const toolContext = db.prepare(`SELECT * FROM ai_usage_skill_context WHERE
    tenant_id=? AND workspace_id=? AND user_id=? AND provider=? AND session_id=?
    AND context_kind='tool' AND context_id=?`);

  function resolveEvidence(row, scope) {
    let value = json(row.value_json);
    const tool = value.kind === 'tool' ? toolContext.get(...scope, value.toolUseId) : null;
    if (!tool && value.kind === 'tool' && row.source_key.startsWith('message:')) {
      const boundary = db.prepare(`SELECT value_json FROM ai_usage_fact_rows
        WHERE tenant_id=? AND session_key=? AND dataset='skill_evidence'
        AND json_extract(value_json,'$.kind')='boundary'
        AND (occurred_at<? OR (occurred_at=? AND json_extract(value_json,'$.sourceRuntimeId')=?
          AND json_extract(value_json,'$.sourceSequence')<=?))
        ORDER BY occurred_at DESC,json_extract(value_json,'$.sourceSequence') DESC LIMIT 1`)
        .get(tenantId, row.session_key, row.occurred_at, row.occurred_at, value.sourceRuntimeId, value.sourceSequence);
      if (boundary) {
        const context = json(boundary.value_json);
        value = { ...value, requestId: context.requestId, origin: context.origin };
      }
    }
    return { value, tool };
  }

  function groupForEvidence(row, scope) {
    const { value, tool } = resolveEvidence(row, scope);
    if (value.kind === 'boundary') return null;
    // A trusted unknown request is intentionally not guessed from file order.
    const requestId = tool ? tool.request_id : value.requestId;
    if (requestId) return `request:${requestId}`;
    if (value.kind === 'tool' && value.toolUseId) return `tool:${value.toolUseId}`;
    return null;
  }

  function displayEvidence(row, sessionKey, scope) {
    row.value = resolveEvidence(row, scope).value;
    if (row.value.kind !== 'display_command') return row;
    const request = db.prepare(`SELECT occurred_at FROM ai_usage_fact_rows
      WHERE tenant_id=? AND dataset='interactions' AND session_key=? AND row_key=?
      ORDER BY priority DESC,source_key LIMIT 1`)
      .get(tenantId, sessionKey, `${sessionKey}:message:${row.value.requestId}`);
    const time = normalizeTimestamp(request?.occurred_at);
    if (!time) return null;
    return { ...row, occurred_at: time, stat_date: localParts(time, config.timeZone).date,
      value: { ...row.value, kind: 'slash' } };
  }

  return async function skills(progress) {
    while (true) {
      checkWindow();
      if (!progress.skillSession) {
        const dirty = db.prepare(`SELECT * FROM ai_usage_dirty_skill_sessions
          WHERE tenant_id=? AND session_key>? ORDER BY session_key LIMIT 1`).get(tenantId, progress.skillCursor || '');
        if (!dirty) return;
        progress.skillSession = { key: dirty.session_key, generation: dirty.generation, phase: 'previous', cursor: '' };
        await checkpoint(progress);
      }
      const current = progress.skillSession;
      const scope = json(current.key, []);
      if (scope.length !== 5 || scope[0] !== tenantId) throw new Error('Invalid Skill statistics scope');
      while (current.phase !== 'groups') {
        checkWindow();
        let page;
        if (current.phase === 'previous') {
          page = db.prepare(`SELECT group_key FROM ai_usage_skill_groups WHERE tenant_id=? AND session_key=?
            AND group_key>? ORDER BY group_key LIMIT ?`).all(tenantId, current.key, current.cursor, config.batchSize);
        } else if (current.phase === 'evidence') {
          page = db.prepare(`SELECT * FROM ai_usage_fact_rows WHERE tenant_id=? AND dataset='skill_evidence'
            AND session_key=? AND (row_key,source_key)>(?,?) ORDER BY row_key,source_key LIMIT ?`)
            .all(tenantId, current.key, ...current.cursor, config.batchSize);
        } else {
          page = db.prepare(`SELECT * FROM ai_usage_skill_context WHERE
            tenant_id=? AND workspace_id=? AND user_id=? AND provider=? AND session_id=?
            AND (context_kind='tool' OR (context_kind='request' AND skill_name IS NOT NULL))
            AND (context_kind,context_id)>(?,?) ORDER BY context_kind,context_id LIMIT ?`)
            .all(...scope, ...current.cursor, config.batchSize);
        }
        store.transaction(() => {
          store.assertLease(batch);
          for (const row of page) {
            if (current.phase === 'previous') addItem.run(batch.id, current.key, row.group_key, 'previous', '', '');
            else if (current.phase === 'evidence') {
              const group = groupForEvidence(row, scope);
              if (group) addItem.run(batch.id, current.key, group, 'fact', row.row_key, row.source_key);
            } else {
              const group = row.context_kind === 'request' ? `request:${row.request_id || row.context_id}`
                : row.request_id ? `request:${row.request_id}` : `tool:${row.context_id}`;
              addItem.run(batch.id, current.key, group, row.context_kind, row.context_id, '');
            }
          }
          if (page.length) {
            const last = page.at(-1);
            current.cursor = current.phase === 'previous' ? last.group_key
              : current.phase === 'evidence' ? [last.row_key, last.source_key] : [last.context_kind, last.context_id];
          } else {
            current.phase = current.phase === 'previous' ? 'evidence' : current.phase === 'evidence' ? 'contexts' : 'groups';
            current.cursor = current.phase === 'groups' ? '' : ['', ''];
          }
          store.checkpoint(batch, progress, config);
        });
        await checkpoint(progress);
      }

      while (true) {
        checkWindow();
        const next = db.prepare(`SELECT group_key FROM ai_usage_skill_work_items
          WHERE batch_id=? AND session_key=? AND group_key>? ORDER BY group_key LIMIT 1`)
          .get(batch.id, current.key, current.cursor);
        if (!next) break;
        const group = next.group_key;
        const evidence = db.prepare(`SELECT f.* FROM ai_usage_skill_work_items i JOIN ai_usage_fact_rows f
          ON f.tenant_id=? AND f.source_key=i.source_key AND f.row_key=i.item_key AND f.dataset='skill_evidence'
          WHERE i.batch_id=? AND i.session_key=? AND i.group_key=? AND i.kind='fact'`)
          .all(tenantId, batch.id, current.key, group).map((row) => displayEvidence(row, current.key, scope)).filter(Boolean);
        const contexts = db.prepare(`SELECT c.* FROM ai_usage_skill_work_items i JOIN ai_usage_skill_context c
          ON c.tenant_id=? AND c.workspace_id=? AND c.user_id=? AND c.provider=? AND c.session_id=?
          AND c.context_kind=i.kind AND c.context_id=i.item_key
          WHERE i.batch_id=? AND i.session_key=? AND i.group_key=? AND i.kind IN ('request','tool')`)
          .all(...scope, batch.id, current.key, group);
        // Include the owning request even when it was not a slash candidate,
        // and every trusted session/branch source marker for exclusion.
        contexts.push(...db.prepare(`SELECT * FROM ai_usage_skill_context WHERE
          tenant_id=? AND workspace_id=? AND user_id=? AND provider=? AND session_id=?
          AND (context_kind='session' OR (context_kind='request' AND context_id=?))`)
          .all(...scope, group.startsWith('request:') ? group.slice(8) : ''));
        const bindings = db.prepare('SELECT * FROM ai_skill_binding_history WHERE tenant_id=? AND workspace_id=?')
          .all(tenantId, scope[1]);
        const rows = reconcileSkillEvidence({ evidence, contexts, bindings, timeZone: config.timeZone }).map(enrich);
        checkWindow();
        store.transaction(() => {
          store.assertLease(batch);
          store.put(tenantId, `skill-group:${current.key}:${group}`, rows, { replace: true, priority: 40 });
          if (rows.length) db.prepare('INSERT OR IGNORE INTO ai_usage_skill_groups VALUES(?,?,?)').run(tenantId, current.key, group);
          else db.prepare('DELETE FROM ai_usage_skill_groups WHERE tenant_id=? AND session_key=? AND group_key=?')
            .run(tenantId, current.key, group);
          db.prepare('DELETE FROM ai_usage_skill_work_items WHERE batch_id=? AND session_key=? AND group_key=?')
            .run(batch.id, current.key, group);
          current.cursor = group;
          store.checkpoint(batch, progress, config);
        });
        await checkpoint(progress);
      }
      store.transaction(() => {
        store.assertLease(batch);
        db.prepare('DELETE FROM ai_usage_dirty_skill_sessions WHERE tenant_id=? AND session_key=? AND generation=?')
          .run(tenantId, current.key, current.generation);
        progress.skillCursor = current.key;
        delete progress.skillSession;
        store.checkpoint(batch, progress, config);
      });
      await checkpoint(progress);
    }
  };
}
