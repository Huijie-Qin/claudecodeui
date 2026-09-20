import { getAiUsageCaptureDatabase } from './ai-usage-turns.js';
import { isInheritedUsageMessage } from './ai-usage-inheritance.js';

const ORIGINS = new Set(['user', 'hook', 'agent_graph', 'top_skill', 'unknown']);
const KINDS = new Set(['request', 'tool', 'session']);

export { migrateAiUsageSkillContext } from '../database/ai-usage-skill-context-schema.js';

function positiveId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function identifier(value) {
  return typeof value === 'string' && value.trim() && value.length <= 500 ? value.trim() : null;
}

function skillIdentifier(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return /^[^\s/<>]{1,200}$/.test(name) ? name : null;
}

function timestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('Invalid Skill context timestamp');
  return new Date(parsed).toISOString();
}

function trustedScope(input) {
  const ids = [input.tenantId, input.userId, input.workspaceId].map(positiveId);
  const provider = identifier(input.provider);
  if (ids.some((id) => !id) || !provider) throw new Error('Trusted Skill context scope is required');
  return [...ids, provider];
}

// This is only a submitted command candidate, not a validated installed Skill.
// Never retain arguments, command bodies, or arbitrary input objects.
export function leadingSkillName(command) {
  if (typeof command !== 'string') return null;
  const match = command.trimStart().match(/^\/([^\s/<>]+)(?:\s|$)/);
  return match ? skillIdentifier(match[1]) : null;
}

export function createAiUsageSkillContextRecorder({ database, getDatabase = getAiUsageCaptureDatabase,
  now = () => new Date().toISOString(), logger = console } = {}) {
  function safely(operation, callback) {
    try {
      const connection = database || getDatabase();
      if (!connection) throw new Error('Usage database has not been configured');
      return callback(connection);
    } catch (error) {
      try { logger.warn(`[AiUsage] ${operation} failed: ${error?.message || error}`); } catch { /* Diagnostics must not affect a query. */ }
      return null;
    }
  }

  function record(input) {
    return safely('record Skill context', (connection) => {
      const scope = trustedScope(input);
      const contextId = identifier(input.contextId);
      if (!contextId || !KINDS.has(input.contextKind)) throw new Error('Skill context identity is required');
      if (!ORIGINS.has(input.origin)) throw new Error('Invalid Skill context origin');
      const sessionId = identifier(input.sessionId);
      const requestId = identifier(input.requestId);
      const subagentId = identifier(input.subagentId);
      const skillName = skillIdentifier(input.skillName);
      const occurredAt = timestamp(input.occurredAt || now());
      const updatedAt = timestamp(now());
      return connection.transaction(() => {
        const previous = connection.prepare(`SELECT * FROM ai_usage_skill_context WHERE
          tenant_id=? AND user_id=? AND workspace_id=? AND provider=? AND context_kind=? AND context_id=?`)
          .get(...scope, input.contextKind, contextId);
        if (previous) {
          if ((previous.session_id && sessionId && previous.session_id !== sessionId)
            || (previous.request_id && requestId && previous.request_id !== requestId)
            || (previous.subagent_id && subagentId && previous.subagent_id !== subagentId)
            || (previous.skill_name && skillName && previous.skill_name !== skillName)
            || (previous.origin !== 'unknown' && input.origin !== 'unknown' && previous.origin !== input.origin)) {
            throw new Error('Skill context identity conflict');
          }
          // Only an explicitly trusted observation can refine an unknown tool.
          // An uncertain repeated SDK event must never overwrite a known origin.
          const refine = previous.context_kind === 'tool' && previous.origin === 'unknown'
            && input.trustedOrigin === true && input.origin !== 'unknown'
            && !(previous.subagent_id && input.origin === 'user');
          const uncertainChild = previous.context_kind === 'tool' && subagentId
            && !previous.subagent_id && previous.origin === 'user' && input.origin === 'unknown';
          const nextOrigin = uncertainChild ? 'unknown' : input.origin;
          const nextRequestId = uncertainChild ? null : requestId;
          const changeOrigin = refine || uncertainChild;
          const changed = connection.prepare(`UPDATE ai_usage_skill_context SET
            session_id=COALESCE(session_id,?),
            subagent_id=COALESCE(subagent_id,?),
            origin=CASE WHEN ? THEN ? ELSE origin END,
            request_id=CASE WHEN ? THEN ? ELSE request_id END, updated_at=?
            WHERE tenant_id=? AND user_id=? AND workspace_id=? AND provider=? AND context_kind=? AND context_id=?
              AND ((session_id IS NULL AND ? IS NOT NULL) OR (subagent_id IS NULL AND ? IS NOT NULL) OR ?)`)
            .run(sessionId, subagentId, changeOrigin ? 1 : 0, nextOrigin, changeOrigin ? 1 : 0, nextRequestId, updatedAt,
              ...scope, input.contextKind, contextId, sessionId, subagentId, changeOrigin ? 1 : 0).changes;
          return { changed: changed > 0 };
        }
        const result = connection.prepare(`INSERT INTO ai_usage_skill_context
          (tenant_id,user_id,workspace_id,provider,session_id,context_kind,context_id,request_id,origin,skill_name,subagent_id,occurred_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...scope, sessionId, input.contextKind, contextId,
          requestId, input.origin, skillName, subagentId, occurredAt, updatedAt);
        return { changed: result.changes > 0 };
      })();
    });
  }

  return {
    recordRequest: (input) => record({ ...input, contextKind: 'request' }),
    recordTool: (input) => record({ ...input, contextKind: 'tool' }),
    recordSession: (input) => record({ ...input, contextKind: 'session' }),
    bindSession(input) {
      return safely('bind Skill context session', (connection) => {
        const scope = trustedScope(input);
        const sessionId = identifier(input.sessionId);
        const requestId = identifier(input.requestId);
        const contextId = identifier(input.contextId);
        const contextKind = KINDS.has(input.contextKind) ? input.contextKind : null;
        if (!sessionId || (!requestId && !(contextId && contextKind))) return { changed: false };
        const predicate = contextId && contextKind ? 'context_kind=? AND context_id=?' : 'request_id=?';
        const keys = contextId && contextKind ? [contextKind, contextId] : [requestId];
        return { changed: connection.prepare(`UPDATE ai_usage_skill_context SET session_id=?,updated_at=?
          WHERE tenant_id=? AND user_id=? AND workspace_id=? AND provider=? AND ${predicate} AND session_id IS NULL`)
          .run(sessionId, timestamp(now()), ...scope, ...keys).changes > 0 };
      });
    },
  };
}

export const aiUsageSkillContextRecorder = createAiUsageSkillContextRecorder();

export function createClaudeSkillContextCapture({ options = {}, writerUserId, recorder = aiUsageSkillContextRecorder,
  now = () => new Date().toISOString() } = {}) {
  const scope = { tenantId: options.tenantId, userId: options.userId ?? writerUserId,
    workspaceId: options.workspaceId, provider: 'claude' };
  const enabled = [scope.tenantId, scope.userId, scope.workspaceId].every(positiveId);
  const inherited = options.mcpLoopResume === true ? options.aiUsageSkillRequest : null;
  const initialOrigin = options.hookRecovery ? 'hook' : options.mcpLoopResume === true
    ? (ORIGINS.has(inherited?.origin) ? inherited.origin : 'unknown') : 'user';
  const identity = { requestId: identifier(inherited?.requestId), origin: initialOrigin };
  const requests = new Set();
  if (identity.requestId) requests.add(identity.requestId);
  let sessionId = identifier(options.sessionId);
  let ambiguous = inherited?.origin === 'unknown' && !identity.requestId;
  const hookAgents = new Set();
  const unbound = new Map();
  const safeRecord = (method, input) => {
    if (enabled) {
      if (!sessionId && method !== 'bindSession') {
        const contextKind = method === 'recordTool' ? 'tool' : method === 'recordSession' ? 'session' : 'request';
        unbound.set(`${contextKind}:${input.contextId}`, { contextKind, contextId: input.contextId });
      }
      return recorder[method]({ ...scope, sessionId, ...input });
    }
    return null;
  };

  const capture = {
    identity,
    request({ messageId, command, supplemental = false, occurredAt } = {}) {
      const id = identifier(messageId);
      if (!id) return;
      const resume = !supplemental && options.mcpLoopResume === true;
      const origin = supplemental ? 'user' : initialOrigin;
      const requestId = resume ? identity.requestId : id;
      safeRecord('recordRequest', { contextId: id, requestId, origin,
        skillName: resume ? null : leadingSkillName(command), occurredAt: occurredAt || now() });
      if (!resume) {
        if (requests.size && !requests.has(id)) ambiguous = true;
        requests.add(id);
        identity.requestId = ambiguous ? null : id;
        identity.origin = ambiguous ? 'unknown' : origin;
      }
    },
    bindSession(value) {
      const next = identifier(value);
      if (!next || (sessionId && sessionId !== next)) return;
      sessionId = next;
      for (const requestId of requests) safeRecord('bindSession', { requestId });
      for (const context of unbound.values()) safeRecord('bindSession', context);
      unbound.clear();
    },
    markSubagentHook({ agentId, occurredAt } = {}) {
      const id = identifier(agentId);
      if (!id) return;
      hookAgents.add(id);
      // The stable marker retains the first injection time across repetitions.
      // Consumers exclude this branch only at/after that timestamp, not before.
      safeRecord('recordSession', { contextId: `subagent:${id}`, requestId: null,
        origin: 'hook', subagentId: id, occurredAt: occurredAt || now() });
    },
    observeTool(input) {
      if (input?.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Skill') return;
      capture.observe({ type: 'assistant',
        ...(Object.hasOwn(input, 'parent_tool_use_id') ? { parent_tool_use_id: input.parent_tool_use_id } : {}),
        agent_id: input.agent_id,
        message: { content: [{ type: 'tool_use', name: 'Skill', id: input.tool_use_id, input: input.tool_input }] },
      });
    },
    observe(message) {
      if (!message || typeof message !== 'object' || isInheritedUsageMessage(message)) return;
      // Non-Skill messages (including every token delta) perform no writes.
      const tools = message.type === 'assistant' && Array.isArray(message.message?.content)
        ? message.message.content.filter((part) => part?.type === 'tool_use' && part.name === 'Skill')
        : message.kind === 'tool_use' && message.toolName === 'Skill'
          ? [{ id: message.toolId, input: message.toolInput }] : [];
      if (!tools.length) return;
      const child = Boolean(message.parent_tool_use_id || message.parentToolUseId || message.agent_id || message.agentId);
      const main = !child && (message.parent_tool_use_id === null || message.parentToolUseId === null);
      const knownHook = (initialOrigin === 'hook' && !ambiguous)
        || hookAgents.has(message.agent_id || message.agentId);
      const origin = knownHook ? 'hook' : main && !ambiguous && identity.requestId ? identity.origin : 'unknown';
      for (const tool of tools) {
        const toolId = identifier(tool.id);
        if (!toolId || typeof tool.input?.skill !== 'string' || !tool.input.skill.trim()) continue;
        safeRecord('recordTool', { contextId: toolId, requestId: origin === 'unknown' ? null : identity.requestId,
          origin, skillName: tool.input.skill, trustedOrigin: knownHook || main,
          subagentId: identifier(message.agent_id || message.agentId),
          occurredAt: message.timestamp || now() });
      }
    },
  };
  return capture;
}
