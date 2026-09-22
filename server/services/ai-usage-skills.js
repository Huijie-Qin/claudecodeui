import crypto from 'node:crypto';

import { getAiUsageCaptureDatabase } from './ai-usage-turns.js';

function positiveId(value) {
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

// Only the platform's confirmed create -> publish chain counts as a first
// publication. Current market state and importedAt cannot prove that history.
export function createAiUsageSkillRecorder({ database, getDatabase = getAiUsageCaptureDatabase,
  logger = console, now = () => new Date().toISOString() } = {}) {
  function safely(operation, input, callback) {
    const tenantId = positiveId(input?.tenantId);
    const userId = positiveId(input?.userId);
    const workspaceId = positiveId(input?.workspaceId);
    if (!tenantId || !userId || !workspaceId) return null;
    try {
      const connection = database || getDatabase();
      if (!connection) throw new Error('Usage database has not been configured');
      return connection.transaction(() => callback(connection, { tenantId, userId, workspaceId }))();
    } catch (error) {
      try { logger.warn(`[AiUsage] Skill ${operation} requires reconciliation (${input.operationId || 'binding'}): ${error?.message || error}`); } catch { /* Best effort diagnostics. */ }
      return null;
    }
  }

  return {
    beginPublishEvent(input) {
      return safely('publish event start', input, (connection, scope) => {
        if (!['create', 'update'].includes(input.publishKind)) throw new Error('Invalid publish kind');
        const id = input.operationId || crypto.randomUUID();
        connection.prepare(`INSERT INTO ai_skill_publish_events
          (id,tenant_id,user_id,workspace_id,skill_name,publish_kind,status,requested_at)
          VALUES(?,?,?,?,?,?,'requested',?) ON CONFLICT(id) DO NOTHING`).run(
          id, scope.tenantId, scope.userId, scope.workspaceId, String(input.skillName || '').slice(0, 200),
          input.publishKind, now(),
        );
        return { ...scope, operationId: id };
      });
    },

    identifyPublishEvent(input) {
      return safely('publish event identity', input, (connection, scope) => connection.prepare(`UPDATE ai_skill_publish_events
        SET skill_id=? WHERE id=? AND tenant_id=? AND user_id=? AND workspace_id=? AND status='requested'`).run(
        String(input.skillId), input.operationId, scope.tenantId, scope.userId, scope.workspaceId,
      ).changes > 0);
    },

    succeedPublishEvent(input) {
      return safely('publish event success', input, (connection, scope) => {
        if (!input.skillId || !Number.isFinite(Date.parse(input.publishedAt))) throw new Error('Publication identity and time are required');
        return connection.prepare(`UPDATE ai_skill_publish_events
          SET skill_id=?,status='succeeded',published_at=?,finished_at=?,published_version=?,failure_code=NULL
          WHERE id=? AND tenant_id=? AND user_id=? AND workspace_id=? AND status IN ('requested','unknown')`).run(
          String(input.skillId), new Date(input.publishedAt).toISOString(), now(),
          Number.isSafeInteger(input.publishedVersion) ? input.publishedVersion : null,
          input.operationId, scope.tenantId, scope.userId, scope.workspaceId,
        ).changes > 0;
      });
    },

    failPublishEvent(input) {
      return safely('publish event failure', input, (connection, scope) => connection.prepare(`UPDATE ai_skill_publish_events
        SET status=?,finished_at=?,failure_code=?
        WHERE id=? AND tenant_id=? AND user_id=? AND workspace_id=? AND status='requested'`).run(
        input.uncertain ? 'unknown' : 'failed', now(), input.uncertain ? 'PUBLISH_UNCONFIRMED' : 'PUBLISH_REJECTED',
        input.operationId, scope.tenantId, scope.userId, scope.workspaceId,
      ).changes > 0);
    },

    beginPublication(input) {
      return safely('publication start', input, (connection, scope) => {
        const operationId = input.operationId || crypto.randomUUID();
        connection.prepare(`INSERT INTO ai_skill_publications
          (operation_id,tenant_id,user_id,skill_name,status,created_at,updated_at)
          VALUES (?,?,?,?,'pending',?,?) ON CONFLICT(operation_id) DO NOTHING`).run(
          operationId, scope.tenantId, scope.userId, input.skillName || null, now(), now(),
        );
        return { ...scope, operationId };
      });
    },

    saved(input) {
      return safely('save confirmation', input, (connection, scope) => connection.prepare(`UPDATE ai_skill_publications
        SET skill_id=?,status='saved_pending_publish',updated_at=?
        WHERE operation_id=? AND tenant_id=? AND user_id=? AND status='pending'`).run(
        String(input.skillId), now(), input.operationId, scope.tenantId, scope.userId,
      ).changes > 0);
    },

    confirmed(input) {
      return safely('publish confirmation', input, (connection, scope) => {
        if (!input.skillId || !Number.isFinite(Date.parse(input.firstPublishedAt))) throw new Error('Publication identity and time are required');
        const changed = connection.prepare(`UPDATE ai_skill_publications SET skill_id=?,first_published_at=?,
          status='confirmed',updated_at=? WHERE operation_id=? AND tenant_id=? AND user_id=?
          AND status IN ('pending','saved_pending_publish','reconciliation_required')`).run(
          String(input.skillId), new Date(input.firstPublishedAt).toISOString(), now(),
          input.operationId, scope.tenantId, scope.userId,
        ).changes > 0;
        return changed || Boolean(connection.prepare(`SELECT 1 FROM ai_skill_publications
          WHERE operation_id=? AND tenant_id=? AND user_id=? AND status='confirmed' AND skill_id=?`).get(
          input.operationId, scope.tenantId, scope.userId, String(input.skillId),
        ));
      });
    },

    reconciliationRequired(input) {
      return safely('uncertain publication', input, (connection, scope) => connection.prepare(`UPDATE ai_skill_publications
        SET status='reconciliation_required',updated_at=?
        WHERE operation_id=? AND tenant_id=? AND user_id=? AND status<>'confirmed'`).run(
        now(), input.operationId, scope.tenantId, scope.userId,
      ).changes > 0);
    },

    syncBindings(input) {
      return safely('binding history', input, (connection, scope) => {
        const at = new Date(input.at || now()).toISOString();
        const bindings = Object.entries(input.bindings || {}).flatMap(([localName, entry]) => {
          const remoteSkillId = String(entry?.id || entry?.skillId || '').trim();
          if (!remoteSkillId) return [];
          const publisherAccountId = entry.createUserId == null ? null : String(entry.createUserId);
          const publisherUserId = publisherAccountId && input.accountId != null
            && publisherAccountId === String(input.accountId) ? scope.userId : null;
          return [{ localName, remoteSkillId, publisherAccountId, publisherUserId }];
        });
        const current = connection.prepare(`SELECT * FROM ai_skill_binding_history
          WHERE tenant_id=? AND workspace_id=? AND valid_to IS NULL`).all(scope.tenantId, scope.workspaceId);
        for (const row of current) {
          const binding = bindings.find((entry) => entry.localName === row.local_name);
          if (!binding || binding.remoteSkillId !== row.remote_skill_id
            || binding.publisherAccountId !== row.publisher_account_id) {
            connection.prepare('UPDATE ai_skill_binding_history SET valid_to=? WHERE id=? AND valid_to IS NULL').run(at, row.id);
          }
        }
        for (const binding of bindings) {
          if (current.some((row) => row.local_name === binding.localName && row.remote_skill_id === binding.remoteSkillId
            && row.publisher_account_id === binding.publisherAccountId)) continue;
          connection.prepare(`INSERT INTO ai_skill_binding_history
            (tenant_id,workspace_id,local_name,remote_skill_id,publisher_user_id,publisher_account_id,valid_from,evidence)
            VALUES (?,?,?,?,?,?,?,?)`).run(scope.tenantId, scope.workspaceId, binding.localName, binding.remoteSkillId,
            binding.publisherUserId, binding.publisherAccountId, at, input.evidence || 'market_binding_commit');
        }
        return true;
      });
    },

    closeBinding(input) {
      return safely('binding removal', input, (connection, scope) => connection.prepare(`UPDATE ai_skill_binding_history
        SET valid_to=? WHERE tenant_id=? AND workspace_id=? AND local_name=? AND valid_to IS NULL`).run(
        new Date(input.at || now()).toISOString(), scope.tenantId, scope.workspaceId, input.localName,
      ).changes > 0);
    },
  };
}

export const aiUsageSkillRecorder = createAiUsageSkillRecorder();
