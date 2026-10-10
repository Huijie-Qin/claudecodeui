import { localParts, normalizeTimestamp } from './ai-usage-config.js';
import { isInheritedUsageMessage } from './ai-usage-inheritance.js';

export const logicalSessionKey = (scope) => JSON.stringify([
  scope.tenant_id, scope.workspace_id, scope.user_id, scope.provider,
  scope.provider_session_id || scope.session_key || scope.runtime_id,
]);

function contentText(content) {
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('\n') : '';
}

// Deliberately excludes body text, inputs and transient SDK-generated IDs/times.
export function parseUsageMessage(scope, message, { timeZone, fallbackId, fallbackTime, subagentId = null, includeSkillTools = true } = {}) {
  if (!message || typeof message !== 'object' || isInheritedUsageMessage(message)) return [];
  const time = normalizeTimestamp(message.timestamp || fallbackTime);
  const id = message.uuid || message.id || fallbackId;
  if (!time || !id) return [];
  const role = message.role || message.message?.role || message.type;
  const sessionKey = logicalSessionKey(scope);
  const base = { stat_date: localParts(time, timeZone).date, user_id: scope.user_id,
    workspace_id: scope.workspace_id, session_key: sessionKey, occurred_at: time };
  const value = { provider: scope.provider, providerSessionId: scope.provider_session_id || null };
  const rows = [];
  const content = message.message?.content ?? message.content;
  const text = contentText(content).trim();
  const internal = message.isMeta || message.is_meta || message.message?.isMeta || message.message?.is_meta
    || /^Base directory for this skill:/.test(text) || message.parent_tool_use_id
    || /^<(?:ccui-hook-recovery|ccui-mcp-loop-results)(?:\s|>)/.test(text)
    || (Array.isArray(content) && content.some((part) => part?.type === 'tool_result'));
  if (role === 'user' && !internal && !subagentId && (text || message.kind === 'message')) {
    rows.push({ ...base, dataset: 'interactions', row_key: `${sessionKey}:message:${id}`, value });
  }
  if (!includeSkillTools) return rows;
  const tools = [];
  if (message.kind === 'tool_use' && message.toolName === 'Skill' && message.toolId) {
    tools.push({ id: message.toolId, name: message.toolInput?.skill });
  }
  if (role === 'assistant') {
    for (const part of Array.isArray(content) ? content : []) {
      if (part?.type === 'tool_use' && part.name === 'Skill' && part.id) tools.push({ id: part.id, name: part.input?.skill });
    }
  }
  for (const tool of tools) {
    if (typeof tool.name !== 'string' || !tool.name.trim()) continue;
    rows.push({ ...base, dataset: 'skill_invocations', row_key: `${sessionKey}:skill:${subagentId || 'main'}:${tool.id}`,
      subject_id: null, value: { ...value, skillName: tool.name.trim().slice(0, 200), toolUseId: tool.id,
        subagentId, skillId: null, callerUserId: scope.user_id, publisherUserId: null, attribution: 'unresolved' } });
  }
  return rows;
}

const SQL_FIELDS = [
  ['sqlBlockCount', 'SQL 块数', '块'], ['sqlLineCount', 'SQL 行数', '行'],
  ['nonEmptySqlLineCount', '非空 SQL 行数', '行'], ['statementCount', '语句数', '条'],
  ['characterCount', '字符数', '字符'],
];

export function safeHookFields(recordType, data, definitions = null) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { fields: [], fieldsUnavailable: true };
  }
  if (Array.isArray(definitions)) {
    const fields = definitions.slice(0, 20).flatMap((definition) => {
      const key = definition?.key;
      if (typeof key !== 'string' || !Object.hasOwn(data, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) return [];
      const value = data[key];
      if (!['number', 'string', 'boolean'].includes(definition.type) || typeof value !== definition.type
        || (typeof value === 'number' && !Number.isFinite(value))) return [];
      const aggregation = ['sum', 'avg', 'min', 'max', 'none'].includes(definition.aggregation) ? definition.aggregation : 'none';
      return [{ key, label: String(definition.label || key).slice(0, 120), unit: String(definition.unit || '').slice(0, 32),
        type: definition.type, value: typeof value === 'string' ? value.slice(0, 500) : value,
        aggregation: definition.type === 'number' ? aggregation : 'none' }];
    });
    return { fields, fieldsUnavailable: fields.length < definitions.length || !definitions.length };
  }
  if (recordType !== 'sql_response_metrics') return { fields: [], fieldsUnavailable: true };
  const fields = SQL_FIELDS.filter(([key]) => typeof data[key] === 'number' && Number.isFinite(data[key]) && data[key] >= 0)
    .map(([key, label, unit]) => ({ key, label, unit, type: 'number', value: data[key], aggregation: 'sum' }));
  return { fields, fieldsUnavailable: fields.length < SQL_FIELDS.length };
}
