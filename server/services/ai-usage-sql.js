import { createHash } from 'node:crypto';

import { localParts, normalizeTimestamp } from './ai-usage-config.js';
import { isInheritedUsageMessage } from './ai-usage-inheritance.js';
import { logicalSessionKey } from './ai-usage-parser.js';

const dialect = /^(?:sql|mysql|mariadb|postgres(?:ql)?|sqlite|tsql|plsql|hive|sparksql|bigquery|snowflake|redshift|oracle)$/i;
const sqlStart = /^(?:WITH|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|REPLACE|UPSERT|TRUNCATE|EXPLAIN|SHOW|DESCRIBE|PRAGMA|GRANT|REVOKE|CALL|EXECUTE|VALUES|VACUUM)\b/i;
function looksLikeSql(value) {
  return sqlStart.test(value.trim().replace(/^(?:(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*)+/, ''));
}

// Read text, never execute it. Match the former SQL-output formats without
// requiring a Hook installation or storing SQL/message bodies in report tables.
export function sqlOutputMetrics(text) {
  const snippets = new Set();
  const add = value => { const sql = value.trim(); if (sql) snippets.add(sql); };
  const visit = (value, key = '', depth = 0) => {
    if (depth > 10 || value == null) return;
    if (typeof value === 'string') {
      if (/(?:sql|query|statement)/i.test(key) && looksLikeSql(value)) add(value);
    } else if (Array.isArray(value)) value.forEach(item => visit(item, key, depth + 1));
    else if (typeof value === 'object') Object.entries(value).forEach(([k, v]) => visit(v, k, depth + 1));
  };
  const json = value => { try { visit(JSON.parse(value)); return true; } catch { return false; } };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const outside = [];
  // Consume all fences, including non-SQL and unfinished fences, so quoted
  // examples in another programming language cannot leak into plain-text SQL.
  for (let i = 0; i < lines.length; i++) {
    const opening = lines[i].match(/^\s{0,3}(`{3,}|~{3,})([^\n]*)$/);
    if (!opening) { outside.push(lines[i]); continue; }
    const language = opening[2].trim().split(/\s+/)[0];
    const end = new RegExp(`^\\s{0,3}${opening[1][0]}{${opening[1].length},}\\s*$`);
    const body = [];
    while (++i < lines.length && !end.test(lines[i])) body.push(lines[i]);
    if (i < lines.length) {
      const code = body.join('\n');
      if (dialect.test(language) || (!language && looksLikeSql(code))) add(code);
      else if (!language || language.toLowerCase() === 'json') json(code);
    }
    outside.push('');
  }
  let plain = outside.join('\n').replace(/<sql(?:\s[^>]*)?>([\s\S]*?)<\/sql>/gi, (_all, body) => {
    if (looksLikeSql(body)) add(body);
    return '\n';
  });
  if (json(plain.trim())) plain = '';
  plain = plain.replace(/(^|[^`])`([^`\n]+)`(?!`)/g, (_all, prefix, code) => {
    if (looksLikeSql(code)) add(code);
    return `${prefix} `;
  });
  const raw = plain.split('\n');
  const prefix = line => line.replace(/^\s*(?:(?:[-*+]|>|\d+[.)])\s+)*/, '')
    .replace(/^(?:SQL(?:\s+(?:query|statement))?|查询(?:语句)?)(?:如下)?\s*[:：]\s*/i, '');
  for (let i = 0; i < raw.length; i++) {
    const first = prefix(raw[i]);
    if (!looksLikeSql(first)) continue;
    const body = [first];
    // SQL commonly spans lines; stop at a terminator, blank, or prose. Explicit
    // fenced SQL is preferred for unusual syntax; do not count trailing advice.
    while (!/;\s*(?:--.*)?$/.test(body.at(-1)) && i + 1 < raw.length
      && raw[i + 1].trim() && (/^\s+\S/.test(raw[i + 1])
        || /^(?:FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|GROUP|ORDER|HAVING|LIMIT|UNION|AND|OR|ON|SET|VALUES|RETURNING|WHEN|THEN|ELSE|END|\)|,|;|--|\/\*)\b/i.test(prefix(raw[i + 1])))) {
      body.push(prefix(raw[++i]));
    }
    add(body.join('\n'));
  }
  return { generatedLines: [...snippets].reduce((sum, sql) => sum + sql.split('\n').length, 0), sqlBlockCount: snippets.size };
}

export function parseSqlGeneration(scope, raw, { timeZone = 'Asia/Shanghai', fallbackId, fallbackTime, subagentId = null } = {}) {
  if (!raw || typeof raw !== 'object' || isInheritedUsageMessage(raw)) return [];
  const message = raw.type === 'claude-response' ? raw.data : raw;
  if (!message || (message.role || message.message?.role || message.type) !== 'assistant'
    || message.isMeta || message.is_meta || message.message?.isMeta || message.message?.is_meta
    || (message.kind && !['text', 'message'].includes(message.kind))) return [];
  const time = normalizeTimestamp(message.timestamp || raw.timestamp || fallbackTime);
  const id = message.uuid || message.id || fallbackId;
  if (!time || !id) return [];
  const content = message.message?.content ?? message.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(part => part?.type === 'text' || part?.type === 'output_text').map(part => part.text || '').join('\n') : '';
  const sessionKey = logicalSessionKey(scope);
  const branch = subagentId || message.agentId || message.agent_id || message.subagentId || null;
  return [{ dataset: 'sql_generations', row_key: `sql:${createHash('sha256').update(JSON.stringify([sessionKey, branch, id])).digest('hex')}`,
    stat_date: localParts(time, timeZone).date, user_id: scope.user_id, workspace_id: scope.workspace_id,
    session_key: sessionKey, occurred_at: time,
    value: { ...sqlOutputMetrics(text), provider: scope.provider, providerSessionId: scope.provider_session_id,
      messageId: id, subagentId: branch, source: 'session_sql' } }];
}
