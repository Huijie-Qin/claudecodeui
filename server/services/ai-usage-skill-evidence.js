import { localParts, normalizeTimestamp } from './ai-usage-config.js';
import { isInheritedUsageMessage } from './ai-usage-inheritance.js';

const ORIGINS = new Set(['user', 'hook', 'agent_graph', 'top_skill', 'unknown']);
const EXCLUDED_ORIGINS = new Set(['hook', 'agent_graph', 'top_skill']);
const identifier = (value) => typeof value === 'string' && value.trim() && value.length <= 1000
  ? value.trim() : Number.isSafeInteger(value) ? String(value) : null;
const origin = (value) => ORIGINS.has(value) ? value : 'unknown';
const skillName = (value) => typeof value === 'string' && value.length <= 200
  && /^[^\s/\\<>"'`]+$/u.test(value.trim()) ? value.trim() : null;
const sessionKey = (scope) => JSON.stringify([scope.tenant_id, scope.workspace_id, scope.user_id,
  scope.provider, scope.provider_session_id || scope.session_key || scope.runtime_id]);
const branch = (value) => identifier(value) || null;
const evidenceKey = (key, subagentId, kind, id) => `${key}:evidence:${JSON.stringify([subagentId, kind, id])}`;
const invocationKey = (key, subagentId, kind, id) => `${key}:skill:${JSON.stringify([subagentId, kind, id])}`;

function contentText(content) {
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('\n') : '';
}

function leadingCommand(text) {
  const native = text.match(/^<command-name>\s*\/([^\s<>/]+)\s*<\/command-name>(?:\s|$)/u)
    || text.match(/^<command-message>[^<]*<\/command-message>\s*<command-name>\s*\/([^\s<>/]+)\s*<\/command-name>(?:\s|$)/u);
  return skillName((native || text.match(/^\/([^\s/<>]+)(?:\s|$)/u))?.[1]);
}

function expansionName(text) {
  const match = text.match(/^Base directory for this skill:\s*([^\r\n]+)(?:\r?\n|$)/);
  if (!match) return null;
  // Retain the last directory token only, never a filesystem path or Skill body.
  return skillName(match[1].trim().replace(/[\\/]+$/, '').split(/[\\/]/).at(-1));
}

/** Capture only safe evidence. The caller owns persistence and the file checkpoint. */
export function collectSkillEvidence(scope, message, {
  timeZone, fallbackId, fallbackTime, subagentId = null, state = {}, includeBoundaries = false,
} = {}) {
  if (!message || typeof message !== 'object' || isInheritedUsageMessage(message)) return [];
  const occurredAt = normalizeTimestamp(message.timestamp || fallbackTime);
  const id = identifier(message.uuid || message.id || fallbackId);
  const role = message.role || message.message?.role || message.type;
  const content = message.message?.content ?? message.content;
  const text = contentText(content).trim();
  const isMeta = message.isMeta || message.is_meta || message.message?.isMeta || message.message?.is_meta;
  const toolResult = Array.isArray(content) && content.some((part) => part?.type === 'tool_result');
  const subagent = branch(subagentId) || branch(message.agent_id || message.agentId);
  const key = sessionKey(scope);
  const base = { tenant_id: scope.tenant_id, stat_date: occurredAt ? localParts(occurredAt, timeZone).date : null,
    user_id: scope.user_id, workspace_id: scope.workspace_id, session_key: key, occurred_at: occurredAt };
  const common = { provider: scope.provider, providerSessionId: scope.provider_session_id || null, subagentId: subagent };
  const rows = [];
  const add = (kind, identity, value) => {
    if (occurredAt) rows.push({ ...base, dataset: 'skill_evidence',
      row_key: evidenceKey(key, subagent, kind, identity), subject_id: null, value: { ...common, kind, ...value } });
  };

  if (role === 'user' && /^<ccui-hook-recovery(?:\s|>)/.test(text)) {
    state.requestId = id;
    state.origin = 'hook';
    if (includeBoundaries && id) add('boundary', id, { messageId: id, requestId: id, origin: 'hook' });
  } else if (role === 'user' && /^<ccui-mcp-loop-results(?:\s|>)/.test(text)) {
    // Continuation tool results belong to the existing request, not a new slash.
  } else if (role === 'user' && isMeta && id) {
    const name = expansionName(text);
    if (name) add('expansion', id, { skillName: name, messageId: id,
      requestId: identifier(state.requestId), origin: origin(state.origin) });
  } else if (role === 'user' && !subagent && !isMeta && !toolResult && !message.parent_tool_use_id
    && !/^Base directory for this skill:/.test(text) && (text || message.kind === 'message')) {
    // A missing identity cannot safely leave a previous request attached to later tools.
    state.requestId = occurredAt ? id : null;
    state.origin = id && occurredAt ? 'user' : 'unknown';
    if (includeBoundaries && id) add('boundary', id, { messageId: id, requestId: id, origin: 'user' });
    const name = id && leadingCommand(text);
    if (name) add('slash', id, { skillName: name, messageId: id, requestId: id, origin: 'user' });
  }

  const tools = [];
  if (message.kind === 'tool_use' && message.toolName === 'Skill') {
    tools.push({ id: message.toolId, name: message.toolInput?.skill });
  }
  if (role === 'assistant') {
    for (const part of Array.isArray(content) ? content : []) {
      if (part?.type === 'tool_use' && part.name === 'Skill') tools.push({ id: part.id, name: part.input?.skill });
    }
  }
  const seen = new Set();
  for (const tool of tools) {
    const toolUseId = identifier(tool.id);
    const name = skillName(tool.name);
    if (!toolUseId || !name || seen.has(toolUseId)) continue;
    seen.add(toolUseId);
    add('tool', toolUseId, { skillName: name, toolUseId,
      requestId: identifier(state.requestId), origin: origin(state.origin) });
  }
  return rows;
}

function rowScope(row) {
  let tuple;
  try { tuple = JSON.parse(row.session_key); } catch { return null; }
  if (!Array.isArray(tuple) || tuple.length !== 5 || tuple.some((value) => value == null)) return null;
  const [tenantId, workspaceId, userId, provider, sessionId] = tuple;
  if ((row.tenant_id != null && String(row.tenant_id) !== String(tenantId))
    || (row.workspace_id != null && String(row.workspace_id) !== String(workspaceId))
    || (row.user_id != null && String(row.user_id) !== String(userId))) return null;
  return { tenant_id: tenantId, workspace_id: workspaceId, user_id: userId, provider,
    provider_session_id: sessionId, session_key: row.session_key };
}

function contextScope(context) {
  if ([context.tenant_id, context.workspace_id, context.user_id, context.provider, context.session_id]
    .some((value) => value == null || value === '')) return null;
  return { tenant_id: context.tenant_id, workspace_id: context.workspace_id, user_id: context.user_id,
    provider: context.provider, provider_session_id: context.session_id };
}

function canonicalScopeKey(scope) {
  return JSON.stringify([scope.tenant_id, scope.workspace_id, scope.user_id,
    scope.provider, scope.provider_session_id].map(String));
}

function validBinding(bindings, candidate) {
  const scope = candidate.scope;
  return bindings.some((binding) => {
    if (binding.local_name !== candidate.skillName || !identifier(binding.remote_skill_id)) return false;
    if (binding.tenant_id != null && String(binding.tenant_id) !== String(scope.tenant_id)) return false;
    if (binding.workspace_id != null && String(binding.workspace_id) !== String(scope.workspace_id)) return false;
    const from = normalizeTimestamp(binding.valid_from);
    const to = normalizeTimestamp(binding.valid_to);
    return from && from <= candidate.occurredAt && (binding.valid_to == null || (to && to > candidate.occurredAt));
  });
}

/** Rebuild complete correlation groups from safe evidence and trusted source metadata. */
export function reconcileSkillEvidence({ evidence = [], contexts = [], bindings = [], timeZone } = {}) {
  const groups = new Map();
  const groupFor = (scope) => {
    const key = canonicalScopeKey(scope);
    if (!groups.has(key)) groups.set(key, { scope, evidence: [], contexts: [] });
    return groups.get(key);
  };
  for (const row of evidence) {
    const scope = rowScope(row);
    const value = row.value;
    const occurredAt = normalizeTimestamp(row.occurred_at);
    if (!scope || !occurredAt || !value || !['slash', 'tool', 'expansion'].includes(value.kind)) continue;
    const name = skillName(value.skillName);
    const id = identifier(value.kind === 'tool' ? value.toolUseId : value.messageId || value.requestId);
    if (!name || !id) continue;
    groupFor(scope).evidence.push({ scope, kind: value.kind, skillName: name, id, occurredAt,
      messageId: identifier(value.messageId), requestId: identifier(value.requestId),
      origin: origin(value.origin), subagentId: branch(value.subagentId), synthetic: false });
  }
  for (const context of contexts) {
    const scope = contextScope(context);
    const occurredAt = normalizeTimestamp(context.occurred_at);
    const id = identifier(context.context_id);
    if (!scope || !occurredAt || !id || !['request', 'tool', 'session'].includes(context.context_kind)) continue;
    groupFor(scope).contexts.push({ ...context, context_id: id, occurred_at: occurredAt,
      updated_at: normalizeTimestamp(context.updated_at) || occurredAt });
  }

  const result = [];
  for (const group of groups.values()) {
    const latest = new Map();
    for (const context of group.contexts) {
      const key = JSON.stringify([context.context_kind, context.context_id]);
      if (!latest.has(key) || latest.get(key).updated_at < context.updated_at) latest.set(key, context);
    }
    const allContexts = [...latest.values()];
    const requests = allContexts.filter((context) => context.context_kind === 'request');
    const toolContexts = allContexts.filter((context) => context.context_kind === 'tool');
    const sessionContexts = allContexts.filter((context) => context.context_kind === 'session');
    const requestFor = (candidate) => requests.find((context) => context.context_id === candidate.messageId)
      || requests.find((context) => context.context_id === candidate.requestId)
      || requests.find((context) => context.request_id != null && context.request_id === candidate.requestId);
    const excluded = (candidate) => EXCLUDED_ORIGINS.has(candidate.origin) || sessionContexts.some((context) => {
      if (!EXCLUDED_ORIGINS.has(context.origin)) return false;
      if (!context.context_id.startsWith('subagent:')) return true;
      return candidate.subagentId === context.context_id.slice('subagent:'.length)
        && candidate.occurredAt >= context.occurred_at;
    });
    const candidates = group.evidence.map((candidate) => ({ ...candidate }));

    // Trusted native tool observations can survive an absent/late transcript. If a
    // transcript exists, borrow its exact branch, never create a second main copy.
    for (const context of toolContexts) {
      const matches = candidates.filter((candidate) => candidate.kind === 'tool' && candidate.id === context.context_id
        && (!branch(context.subagent_id) || !candidate.subagentId || candidate.subagentId === branch(context.subagent_id)));
      const name = skillName(context.skill_name);
      if (!matches.length && name) candidates.push({ scope: group.scope, kind: 'tool', id: context.context_id,
        skillName: name, occurredAt: context.occurred_at, subagentId: branch(context.subagent_id),
        requestId: identifier(context.request_id), origin: origin(context.origin), synthetic: true });
    }
    for (const context of requests) {
      const name = skillName(context.skill_name);
      if (!name) continue;
      const requestId = identifier(context.request_id) || context.context_id;
      if (!candidates.some((candidate) => candidate.kind === 'slash'
        && !candidate.subagentId && (candidate.requestId === requestId || candidate.messageId === context.context_id))) {
        candidates.push({ scope: group.scope, kind: 'slash', id: context.context_id, messageId: context.context_id,
          skillName: name, occurredAt: context.occurred_at, subagentId: null,
          requestId, origin: origin(context.origin), synthetic: true });
      }
    }

    for (const candidate of candidates) {
      const toolContext = candidate.kind === 'tool'
        && toolContexts.find((context) => context.context_id === candidate.id
          && (!branch(context.subagent_id) || !candidate.subagentId || candidate.subagentId === branch(context.subagent_id)));
      if (toolContext) {
        // Explicit unknown/null means unresolved. Do not guess from file ordering.
        candidate.requestId = identifier(toolContext.request_id);
        candidate.origin = origin(toolContext.origin);
        candidate.occurredAt = toolContext.occurred_at;
        if (branch(toolContext.subagent_id)) candidate.subagentId = branch(toolContext.subagent_id);
        candidate.skillName = skillName(toolContext.skill_name) || candidate.skillName;
      }
      const request = requestFor(candidate);
      if (request) {
        if (candidate.kind === 'slash' && request.request_id && request.context_id !== request.request_id
          && !request.skill_name) candidate.continuation = true;
        candidate.requestId = identifier(request.request_id) || request.context_id;
        if (!toolContext) candidate.origin = origin(request.origin);
        // A matching excluded trusted request remains excluded even if another
        // observation has incomplete origin metadata for that same request.
        if (EXCLUDED_ORIGINS.has(request.origin)) candidate.origin = request.origin;
      }
    }

    const deduplicated = new Map();
    const order = (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id);
    for (const candidate of candidates.sort(order)) {
      if (candidate.continuation || excluded(candidate)) continue;
      if (candidate.kind === 'slash' && (candidate.origin !== 'user' || !candidate.requestId)) continue;
      const key = JSON.stringify([candidate.subagentId, candidate.kind,
        candidate.kind === 'slash' ? candidate.requestId : candidate.id]);
      if (!deduplicated.has(key)) deduplicated.set(key, candidate);
    }
    const facts = [...deduplicated.values()];
    const tools = facts.filter((candidate) => candidate.kind === 'tool');
    const expansions = facts.filter((candidate) => candidate.kind === 'expansion');
    const exactMatch = (a, b) => a.requestId && a.requestId === b.requestId
      && a.subagentId === b.subagentId && a.skillName === b.skillName;
    const invocations = [...tools];
    for (const slash of facts.filter((candidate) => candidate.kind === 'slash')) {
      const bound = validBinding(bindings, slash);
      const native = tools.find((tool) => exactMatch(slash, tool));
      const expanded = expansions.some((expansion) => exactMatch(slash, expansion));
      if (!(bound || (!slash.synthetic && (native || expanded)))) continue;
      if (!native) invocations.push(slash);
    }
    for (const invocation of invocations) {
      const scope = invocation.scope;
      const key = sessionKey(scope);
      const isTool = invocation.kind === 'tool';
      result.push({ dataset: 'skill_invocations', tenant_id: scope.tenant_id,
        row_key: invocationKey(key, invocation.subagentId, invocation.kind, isTool ? invocation.id : invocation.requestId),
        stat_date: localParts(invocation.occurredAt, timeZone).date, user_id: scope.user_id,
        workspace_id: scope.workspace_id, subject_id: null, session_key: key, occurred_at: invocation.occurredAt,
        value: { provider: scope.provider, providerSessionId: scope.provider_session_id,
          skillName: invocation.skillName, skillId: null, callerUserId: scope.user_id, publisherUserId: null,
          attribution: 'unresolved', origin: invocation.origin, requestId: invocation.requestId,
          subagentId: invocation.subagentId, toolUseId: isTool ? invocation.id : null,
          invocationKind: invocation.kind, messageId: isTool ? null : invocation.messageId } });
    }
  }
  return result.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.row_key.localeCompare(b.row_key));
}
