export async function run(event) {
  if (event.hook_event_name !== 'PreToolUse' || event.tool_name !== 'Write') {
    return { output: { detected: false, sql: '' } };
  }
  if (typeof event.tool_input?.content !== 'string') throw new Error('Write content must be a string');
  const message = event.tool_input.content;
  if (/\.sql$/i.test(String(event.tool_input.file_path || ''))) return { output: { detected: Boolean(message.trim()), sql: message.trim() } };
  const sqlKeywords = '(?:WITH|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|REPLACE|UPSERT|TRUNCATE|EXPLAIN|SHOW|DESCRIBE|PRAGMA|GRANT|REVOKE|CALL|EXECUTE|VALUES|VACUUM)';
  const sqlStartPattern = new RegExp('^\\s*' + sqlKeywords + '\\b', 'i');
  const stripLeadingComments = (value) => {
    let text = String(value || '').replace(/^\uFEFF/, '').trim();
    let previous;
    do {
      previous = text;
      text = text.replace(/^--[^\r\n]*(?:\r?\n|$)/, '').replace(/^\/\*[\s\S]*?\*\//, '').trimStart();
    } while (text !== previous);
    return text;
  };
  const looksLikeSql = (value) => sqlStartPattern.test(stripLeadingComments(value));
  const snippets = [];
  const seenSnippets = new Set();
  const addSnippet = (value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seenSnippets.has(normalized)) return;
    seenSnippets.add(normalized);
    snippets.push(normalized);
  };
  const visitJson = (value, key = "", depth = 0) => {
    if (depth > 10 || value == null) return;
    if (typeof value === 'string') {
      if (/(?:sql|query|statement)/i.test(key) && looksLikeSql(value)) addSnippet(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => visitJson(entry, key, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      Object.entries(value).forEach(([childKey, entry]) => visitJson(entry, childKey, depth + 1));
    }
  };
  const extractJsonSql = (value) => {
    try {
      visitJson(JSON.parse(String(value || "").trim()));
      return true;
    } catch {
      return false;
    }
  };
  let match;
  const dialectFencePattern = /```(?:sql|mysql|mariadb|postgres(?:ql)?|sqlite|tsql|plsql|hive|sparksql|bigquery|snowflake|redshift|oracle)\b[^\r\n]*\r?\n([\s\S]*?)```/gi;
  while ((match = dialectFencePattern.exec(message)) !== null) addSnippet(match[1]);
  const jsonFencePattern = /```json\b[^\r\n]*\r?\n([\s\S]*?)```/gi;
  while ((match = jsonFencePattern.exec(message)) !== null) extractJsonSql(match[1]);
  const unlabeledFencePattern = /```[ \t]*\r?\n([\s\S]*?)```/g;
  while ((match = unlabeledFencePattern.exec(message)) !== null) {
    if (looksLikeSql(match[1])) addSnippet(match[1]);
    else extractJsonSql(match[1]);
  }
  const xmlSqlPattern = /<sql(?:\s[^>]*)?>([\s\S]*?)<\/sql>/gi;
  while ((match = xmlSqlPattern.exec(message)) !== null) {
    if (looksLikeSql(match[1])) addSnippet(match[1]);
  }
  const trimmedMessage = message.trim();
  if (trimmedMessage.startsWith('{') || trimmedMessage.startsWith('[')) {
    extractJsonSql(trimmedMessage);
  }
  const withoutBlocks = message.replace(/```[\s\S]*?```/g, '\n').replace(/<sql(?:\s[^>]*)?>[\s\S]*?<\/sql>/gi, '\n');
  const inlineSource = withoutBlocks.replace(/(^|[^`])`([^`\r\n]+)`(?!`)/g, (whole, prefix, content) => {
    if (looksLikeSql(content)) addSnippet(content);
    return prefix + ' ';
  });
  const rawLines = inlineSource.split(/\r?\n/);
  for (let index = 0; index < rawLines.length; index += 1) {
    let firstLine = rawLines[index].replace(/^\s*(?:(?:[-*+]|>|\d+[.)])\s+)*/, '').trimStart();
    firstLine = firstLine.replace(/^(?:SQL(?:\s+(?:query|statement))?|查询(?:语句)?)(?:如下)?\s*[:：]\s*/i, '');
    if (!looksLikeSql(firstLine)) continue;
    const block = [firstLine];
    let nextIndex = index + 1;
    while (nextIndex < rawLines.length && rawLines[nextIndex].trim()) {
      block.push(rawLines[nextIndex].replace(/^\s*>\s?/, ''));
      nextIndex += 1;
    }
    addSnippet(block.join('\n'));
    index = nextIndex;
  }
  return { output: { detected: snippets.length > 0, sql: snippets.join('\n\n') } };
}
