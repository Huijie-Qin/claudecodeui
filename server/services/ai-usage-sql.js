import { createHash } from 'node:crypto';

import { localParts, normalizeUsageTimestamp } from './ai-usage-config.js';
import { isInheritedUsageMessage } from './ai-usage-inheritance.js';
import { logicalSessionKey } from './ai-usage-parser.js';

const dialect = /^(?:sql|mysql|mariadb|postgres(?:ql)?|sqlite|tsql|plsql|hive|sparksql|bigquery|snowflake|redshift|oracle)$/i;
const sqlStart = /^(?:WITH|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|REPLACE|UPSERT|TRUNCATE|EXPLAIN|SHOW|DESCRIBE|PRAGMA|GRANT|REVOKE|CALL|EXECUTE|VALUES|VACUUM)\b/i;
function looksLikeSql(value) {
  return sqlStart.test(value.trim().replace(/^(?:(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*)+/, ''));
}

// Read text, never execute it. Match the former SQL-output formats without
// requiring a Hook installation or storing SQL/message bodies in report tables.
function collectSqlSnippets(text, snippets) {
  const add = value => { const sql = value.replace(/\r\n?/g, '\n').trim(); if (sql) snippets.add(sql); };
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
        || /^(?:(?:FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|GROUP|ORDER|HAVING|LIMIT|UNION|AND|OR|ON|SET|VALUES|RETURNING|WHEN|THEN|ELSE|END)\b|\)|,|;|--|\/\*)/i.test(prefix(raw[i + 1])))) {
      body.push(prefix(raw[++i]));
    }
    add(body.join('\n'));
  }
}

function snippetMetrics(snippets) {
  return { generatedLines: [...snippets].reduce((sum, sql) => sum + sql.split('\n').length, 0), sqlBlockCount: snippets.size };
}

export function sqlOutputMetrics(text) {
  const snippets = new Set();
  collectSqlSnippets(text, snippets);
  return snippetMetrics(snippets);
}

const generatedKinds = new Set(['thinking', 'reasoning', 'tool_use', 'tool_call', 'function_call']);
const excludedKinds = new Set(['tool_result', 'function_call_output', 'stream_delta', 'stream_end',
  'error', 'complete', 'status', 'permission_request', 'permission_cancelled', 'session_created',
  'interactive_prompt', 'task_notification', 'hook_activity', 'redacted_thinking']);
const isExcludedKind = kind => excludedKinds.has(kind) || (typeof kind === 'string'
  && /(?:[._]delta$|^stream_|^(?:message|content_block)_(?:start|stop)$)/.test(kind));
const unwrap = raw => raw?.type === 'claude-response' ? raw.data : raw;

// Native conversation type is authoritative (as in the history provider).
// Normalized thinking/tool-use events often omit role, but still describe AI output.
export function sqlMessageExclusion(raw) {
  const message = unwrap(raw);
  if (!message || typeof message !== 'object' || Array.isArray(message)) return 'invalid_message';
  const role = ['assistant', 'user'].includes(message.type) ? message.type
    : message.role || message.message?.role;
  if (role ? role !== 'assistant' : !generatedKinds.has(message.kind || message.type)) return 'non_assistant';
  if (isInheritedUsageMessage(raw)) return 'inherited';
  if (message.isMeta || message.is_meta || message.message?.isMeta || message.message?.is_meta) return 'meta';
  if (isExcludedKind(message.kind || message.type)) return 'non_generated_kind';
  return null;
}

// Traverse only generated payloads. Serializing the whole event would also
// count echoed tool results, metadata and nested subagent history a second time.
function replySqlMetrics(message) {
  const snippets = new Set(), texts = new Set();
  const text = value => {
    if (typeof value === 'string') texts.add(value.replace(/\r\n?/g, '\n').trim());
  };
  const literal = value => {
    const sql = value.replace(/\r\n?/g, '\n').trim();
    if (sql) snippets.add(sql);
  };
  const metadataKeys = new Set(['id', 'name', 'type', 'path', 'file_path', 'filePath', 'filename',
    'fileName', 'directory', 'cwd', 'url', 'uri', 'language', 'model', 'toolId', 'toolName']);
  const sqlKey = key => /(?:sql|query|statement)/i.test(key);
  const fileContentKey = key => /^(?:content|new_string|newString|new_text|newText|text)$/i.test(key);
  function input(value, key = '', sqlFile = false, depth = 0) {
    if (value == null || depth > 20 || metadataKeys.has(key)) return;
    if (typeof value === 'string') {
      if ((sqlKey(key) && looksLikeSql(value)) || (sqlFile && fileContentKey(key))) { literal(value); return; }
      // Function arguments can themselves be a JSON string. Parse that payload
      // before visiting it so nested content/sql/query values retain line breaks.
      try {
        const decoded = JSON.parse(value);
        if (decoded && typeof decoded === 'object') { input(decoded, '', sqlFile, depth + 1); return; }
      } catch { /* Ordinary generated text. */ }
      text(value);
    } else if (Array.isArray(value)) value.forEach(item => input(item, key, sqlFile, depth + 1));
    else if (typeof value === 'object') {
      const file = value.file_path ?? value.filePath ?? value.path ?? value.filename ?? value.fileName;
      const inSqlFile = sqlFile || (typeof file === 'string' && /\.sql$/i.test(file));
      for (const [childKey, child] of Object.entries(value)) input(child, childKey, inSqlFile, depth + 1);
    }
  }
  function content(value, depth = 0) {
    if (value == null || depth > 20) return;
    if (typeof value === 'string') { text(value); return; }
    if (Array.isArray(value)) {
      const fragments = [];
      for (const part of value) {
        if (typeof part === 'string') fragments.push(part);
        else if (part && ['text', 'output_text'].includes(part.type)) {
          if (typeof part.text === 'string') fragments.push(part.text);
        }
        else content(part, depth + 1);
      }
      if (fragments.length) text(fragments.join('\n'));
      return;
    }
    if (typeof value !== 'object' || isExcludedKind(value.type)) return;
    if (['tool_use', 'tool_call', 'function_call', 'function'].includes(value.type)) {
      input(value.input ?? value.arguments ?? value.function?.arguments ?? value.toolInput);
      return;
    }
    if (value.type === 'code' && dialect.test(value.language || '') && typeof value.code === 'string') literal(value.code);
    else text(value.text);
    text(value.thinking);
    content(value.reasoning, depth + 1);
    content(value.summary, depth + 1);
    content(value.content, depth + 1);
  }
  content(message.message?.content ?? message.content);
  for (const body of new Set([message, message.message].filter(Boolean))) {
    text(body.text);
    text(body.thinking);
    content(body.reasoning);
    input(body.toolInput ?? body.input);
    input(body.arguments ?? body.function?.arguments);
    content(body.tool_calls);
  }
  // A plain reply may split a multi-statement query into several snippets,
  // while a fenced block/tool argument preserves the same query as one. Prefer
  // that identical complete payload before merging its smaller parsed pieces.
  const parsedTexts = [...texts].map(value => {
    const parts = new Set();
    collectSqlSnippets(value, parts);
    return { value, parts };
  });
  const complete = new Set([...snippets, ...parsedTexts.flatMap(item => [...item.parts])]);
  for (const { value, parts } of parsedTexts) {
    if (complete.has(value)) snippets.add(value);
    else for (const part of parts) snippets.add(part);
  }
  return snippetMetrics(snippets);
}

export function parseSqlGeneration(scope, raw, { timeZone = 'Asia/Shanghai', fallbackId, fallbackTime, subagentId = null } = {}) {
  if (sqlMessageExclusion(raw)) return [];
  const message = unwrap(raw);
  const time = normalizeUsageTimestamp(message.timestamp || raw.timestamp || fallbackTime, timeZone);
  const id = message.uuid || message.id || fallbackId;
  if (!time || !id) return [];
  const sessionKey = logicalSessionKey(scope);
  const branch = subagentId || message.agentId || message.agent_id || message.subagentId || null;
  return [{ dataset: 'sql_generations', row_key: `sql:${createHash('sha256').update(JSON.stringify([sessionKey, branch, id])).digest('hex')}`,
    stat_date: localParts(time, timeZone).date, user_id: scope.user_id, workspace_id: scope.workspace_id,
    session_key: sessionKey, occurred_at: time,
    value: { ...replySqlMetrics(message), provider: scope.provider, providerSessionId: scope.provider_session_id,
      messageId: id, subagentId: branch, source: 'session_sql' } }];
}
