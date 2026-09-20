import crypto from 'node:crypto';

import { isInheritedUsageMessage } from './ai-usage-inheritance.js';

let configuredDatabase = null;

// Application bootstrap supplies the already initialized business connection.
// Importing this module never opens or migrates a user's database.
export function configureAiUsageTurnDatabase(database) {
  configuredDatabase = database;
}

export function getAiUsageCaptureDatabase() { return configuredDatabase; }

function positiveId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function iso(value) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('Invalid usage timestamp');
  return new Date(timestamp).toISOString();
}

function identity(input) {
  const tenantId = positiveId(input.tenantId);
  const userId = positiveId(input.userId);
  const workspaceId = positiveId(input.workspaceId);
  if (!tenantId || !userId || !workspaceId) throw new Error('Trusted tenant, user and workspace are required');
  return { tenantId, userId, workspaceId, turnKey: String(input.turnKey || '') };
}

export function createAiUsageTurnRecorder({ database, getDatabase = () => configuredDatabase,
  now = () => new Date().toISOString(), logger = console } = {}) {
  const safely = (operation, input, callback) => {
    try {
      const scope = identity(input);
      const connection = database || getDatabase();
      if (!connection) throw new Error('Usage database has not been configured');
      return connection.transaction(() => {
        const result = callback(connection, scope);
        if (result?.changed) {
          connection.prepare(`INSERT INTO ai_usage_dirty_tenants(tenant_id,generation) VALUES (?,1)
            ON CONFLICT(tenant_id) DO UPDATE SET generation=generation+1`).run(scope.tenantId);
        }
        return result;
      })();
    } catch (error) {
      // Only metadata goes to diagnostics: never log prompts or Hook data.
      try { logger.warn(`[AiUsage] ${operation} failed: ${error?.message || error}`); } catch { /* Best effort diagnostics. */ }
      return null;
    }
  };

  return {
    start(input) {
      return safely('start turn', input, (connection, scope) => {
        const provider = String(input.provider || '').trim();
        if (!provider) throw new Error('Provider is required');
        const requestKey = String(input.requestKey || crypto.randomUUID());
        const turnKey = scope.turnKey || crypto.createHash('sha256')
          .update(JSON.stringify([provider, scope.tenantId, scope.userId, scope.workspaceId, requestKey])).digest('hex');
        const startedAt = iso(input.startedAt || now());
        const changed = connection.prepare(`INSERT INTO ai_usage_turn_facts
          (turn_key,tenant_id,user_id,workspace_id,session_key,provider,request_key,started_at,source,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(turn_key) DO NOTHING`).run(
          turnKey, scope.tenantId, scope.userId, scope.workspaceId, input.sessionKey || null,
          provider, requestKey, startedAt, input.source || 'server_request', iso(now()),
        ).changes > 0;
        const row = connection.prepare('SELECT * FROM ai_usage_turn_facts WHERE turn_key=?').get(turnKey);
        if (row.tenant_id !== scope.tenantId || row.user_id !== scope.userId
          || row.workspace_id !== scope.workspaceId || row.provider !== provider || row.request_key !== requestKey) {
          throw new Error('Usage turn identity conflict');
        }
        return { ...scope, turnKey, requestKey, startedAt: row.started_at, changed };
      });
    },

    bindSession(input) {
      return safely('bind session', input, (connection, scope) => {
        const sessionKey = String(input.sessionKey || '').trim();
        if (!sessionKey) return { changed: false };
        const changed = connection.prepare(`UPDATE ai_usage_turn_facts
          SET session_key=?,generation=generation+1,updated_at=?
          WHERE turn_key=? AND tenant_id=? AND user_id=? AND workspace_id=?
          AND (session_key IS NULL OR session_key LIKE 'pending:%') AND session_key IS NOT ?`).run(
          sessionKey, iso(now()), scope.turnKey, scope.tenantId, scope.userId, scope.workspaceId, sessionKey,
        ).changes > 0;
        return { changed };
      });
    },

    complete(input) {
      return safely('complete turn', input, (connection, scope) => {
        const completedAt = iso(input.responseCompletedAt);
        const terminalAt = iso(input.terminalAt || now());
        if (completedAt > terminalAt) throw new Error('Response completion is after terminal confirmation');
        const row = connection.prepare(`SELECT started_at FROM ai_usage_turn_facts
          WHERE turn_key=? AND tenant_id=? AND user_id=? AND workspace_id=?`).get(
          scope.turnKey, scope.tenantId, scope.userId, scope.workspaceId,
        );
        if (row && completedAt < row.started_at) throw new Error('Response completion is before request start');
        const changed = connection.prepare(`UPDATE ai_usage_turn_facts SET response_completed_at=?,
          terminal_at=?,terminal_status='completed',source=?,generation=generation+1,updated_at=?
          WHERE turn_key=? AND tenant_id=? AND user_id=? AND workspace_id=? AND terminal_status='pending'`).run(
          completedAt, terminalAt, input.source || 'server_response', iso(now()),
          scope.turnKey, scope.tenantId, scope.userId, scope.workspaceId,
        ).changes > 0;
        return { changed };
      });
    },

    terminal(input) {
      return safely('record terminal turn', input, (connection, scope) => {
        if (!['failed', 'aborted', 'cancelled', 'incomplete', 'unsupported'].includes(input.status)) {
          throw new Error('Unsupported terminal status');
        }
        const changed = connection.prepare(`UPDATE ai_usage_turn_facts SET terminal_at=?,terminal_status=?,
          generation=generation+1,updated_at=? WHERE turn_key=? AND tenant_id=? AND user_id=? AND workspace_id=?
          AND terminal_status='pending'`).run(iso(input.terminalAt || now()), input.status, iso(now()),
          scope.turnKey, scope.tenantId, scope.userId, scope.workspaceId).changes > 0;
        return { changed };
      });
    },
  };
}

export const aiUsageTurnRecorder = createAiUsageTurnRecorder();

// This tracker observes coarse SDK boundaries only. It never accumulates token
// timestamps or treats child agents/tool messages as additional user turns.
export function createClaudeUsageTurnCapture({ options = {}, clientMessageId, writerUserId,
  recorder = aiUsageTurnRecorder, now = () => new Date().toISOString() } = {}) {
  const scope = { tenantId: options.tenantId, userId: options.userId ?? writerUserId, workspaceId: options.workspaceId };
  const excluded = Boolean(options.hookRecovery) || !positiveId(scope.tenantId)
    || !positiveId(scope.userId) || !positiveId(scope.workspaceId);
  const resumed = !excluded && options.mcpLoopResume === true && options.aiUsageTurn
    ? options.aiUsageTurn : null;
  const fact = excluded ? null : recorder.start({
    ...scope, provider: 'claude', sessionKey: options.sessionId,
    // Runtime options (including logRequestId) can be inherited by an entirely
    // new queued turn. Only an explicit client identity or MCP resume is reused.
    requestKey: resumed?.requestKey || clientMessageId || crypto.randomUUID(),
    turnKey: resumed?.turnKey, startedAt: resumed?.startedAt || now(), source: 'claude:server_request',
  });
  let lastAssistantAt = null;
  let stopAt = null;
  let resultFailed = false;

  return {
    identity: fact,
    bindSession(sessionKey) { if (fact) recorder.bindSession({ ...fact, sessionKey }); },
    observe(message) {
      if (!fact || isInheritedUsageMessage(message)
        || message?.parent_tool_use_id || message?.parentToolUseId || message?.agent_id) return;
      if (message?.type === 'assistant') {
        const content = message.message?.content;
        if (Array.isArray(content) && content.some((block) => block?.type === 'tool_use')) {
          lastAssistantAt = null;
          stopAt = null;
        }
        if (Array.isArray(content) && content.some((block) => block?.type === 'text')
          && !content.some((block) => block?.type === 'tool_use')) {
          lastAssistantAt = now();
          // A buffered assistant message may reach the iterator after Stop's
          // callback has already started. Preserve that stronger pre-Hook
          // boundary; a blocked Stop explicitly invalidates it below.
        }
      }
      if (message?.type === 'system' && ['task_started', 'task_progress'].includes(message.subtype)) {
        lastAssistantAt = null;
        stopAt = null;
      }
      if (message?.type === 'result') resultFailed = Boolean(message.is_error)
        || String(message.subtype || '').startsWith('error');
    },
    onStop(event) {
      if (fact && event?.hook_event_name === 'Stop' && !event.agent_id) stopAt = now();
    },
    invalidateResponseBoundary() { stopAt = null; lastAssistantAt = null; },
    complete() {
      if (!fact) return;
      if (resultFailed) return recorder.terminal({ ...fact, status: 'failed' });
      const responseCompletedAt = stopAt || lastAssistantAt;
      if (!responseCompletedAt) return recorder.terminal({ ...fact, status: 'unsupported' });
      return recorder.complete({ ...fact, responseCompletedAt, terminalAt: now(),
        source: stopAt ? 'claude:main_stop' : 'claude:main_assistant' });
    },
    terminal(status) { if (fact) return recorder.terminal({ ...fact, status, terminalAt: now() }); },
  };
}

export function wrapClaudeUsageStopHooks(hookMap, capture) {
  if (!Array.isArray(hookMap?.Stop)) return hookMap;
  return { ...hookMap, Stop: hookMap.Stop.map((entry) => ({
    ...entry,
    hooks: entry.hooks.map((callback) => async (...args) => {
      const response = await callback(...args);
      if (!args[0]?.agent_id) {
        if (response?.decision === 'block') capture.invalidateResponseBoundary();
        if (response?.continue === false) capture.terminal('incomplete');
      }
      return response;
    }),
  })) };
}
