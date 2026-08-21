import http from 'node:http';

export const SQL_SYNTAX_MCP_PATH = '/mcp/sql-syntax-check';
export const SQL_SYNTAX_MCP_SERVER_NAME = 'sql-syntax-checker';
export const SQL_SYNTAX_MCP_TOOL_NAME = 'check_sql_syntax';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const MAX_BODY_BYTES = 1_000_000;
const SESSION_ID = 'ccui-sql-syntax-check-session';
const STATEMENT_STARTERS = new Set([
  'ALTER',
  'CREATE',
  'DELETE',
  'DESCRIBE',
  'DROP',
  'EXPLAIN',
  'GRANT',
  'INSERT',
  'MERGE',
  'REVOKE',
  'SELECT',
  'SHOW',
  'TRUNCATE',
  'UPDATE',
  'USE',
  'WITH',
]);

export const SQL_SYNTAX_MCP_TOOL = Object.freeze({
  name: SQL_SYNTAX_MCP_TOOL_NAME,
  description: 'Run a deterministic simulated syntax check for SQL returned by the model. This checker does not execute SQL.',
  inputSchema: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'SQL text, or a model response containing fenced sql blocks, to check.',
      },
      dialect: {
        type: 'string',
        enum: ['generic', 'mysql', 'postgresql', 'sqlite', 'hive'],
        description: 'SQL dialect hint. The simulated checker currently applies common structural rules.',
        default: 'generic',
      },
    },
    required: ['sql'],
    additionalProperties: false,
  },
});

function lineAndColumn(text, index) {
  const prefix = text.slice(0, Math.max(0, index));
  const lines = prefix.split('\n');
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

function issue(text, code, message, index = 0) {
  return { code, message, ...lineAndColumn(text, index) };
}

function scanSql(sql) {
  const masked = [...sql];
  const statements = [];
  let statementStart = 0;
  let state = 'normal';
  let quoteStart = -1;
  const parentheses = [];
  const issues = [];

  const mask = (index) => {
    if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' ';
  };

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (state === 'line_comment') {
      mask(index);
      if (char === '\n') state = 'normal';
      continue;
    }
    if (state === 'block_comment') {
      mask(index);
      if (char === '*' && next === '/') {
        mask(index + 1);
        index += 1;
        state = 'normal';
      }
      continue;
    }
    if (state !== 'normal') {
      mask(index);
      const delimiter = state === 'single_quote' ? "'" : state === 'double_quote' ? '"' : '`';
      if (char === delimiter && next === delimiter) {
        mask(index + 1);
        index += 1;
      } else if (char === delimiter) {
        state = 'normal';
      }
      continue;
    }

    if (char === '-' && next === '-') {
      mask(index);
      mask(index + 1);
      index += 1;
      state = 'line_comment';
      continue;
    }
    if (char === '/' && next === '*') {
      mask(index);
      mask(index + 1);
      index += 1;
      quoteStart = index - 1;
      state = 'block_comment';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      mask(index);
      quoteStart = index;
      state = char === "'" ? 'single_quote' : char === '"' ? 'double_quote' : 'backtick_quote';
      continue;
    }
    if (char === '(') parentheses.push(index);
    if (char === ')') {
      if (parentheses.length === 0) {
        issues.push(issue(sql, 'unexpected_closing_parenthesis', 'Unexpected closing parenthesis.', index));
      } else {
        parentheses.pop();
      }
    }
    if (char === ';' && parentheses.length === 0) {
      const rawStatement = sql.slice(statementStart, index);
      const leadingOffset = rawStatement.search(/\S/);
      const statement = rawStatement.trim();
      if (statement) statements.push({ text: statement, offset: statementStart + Math.max(0, leadingOffset) });
      statementStart = index + 1;
    }
  }

  const rawFinalStatement = sql.slice(statementStart);
  const finalLeadingOffset = rawFinalStatement.search(/\S/);
  const finalStatement = rawFinalStatement.trim();
  if (finalStatement) statements.push({ text: finalStatement, offset: statementStart + Math.max(0, finalLeadingOffset) });
  for (const index of parentheses) {
    issues.push(issue(sql, 'unclosed_parenthesis', 'Opening parenthesis is not closed.', index));
  }
  if (state === 'block_comment') {
    issues.push(issue(sql, 'unclosed_comment', 'Block comment is not closed.', quoteStart));
  } else if (state !== 'normal' && state !== 'line_comment') {
    issues.push(issue(sql, 'unclosed_quote', 'Quoted value or identifier is not closed.', quoteStart));
  }

  return { masked: masked.join(''), statements, issues };
}

function addPatternIssue(sql, maskedStatement, statementOffset, issues, pattern, code, message) {
  const match = pattern.exec(maskedStatement);
  if (!match) return;
  issues.push(issue(sql, code, message, statementOffset + match.index));
}

export function checkSqlSyntax(sqlValue, dialectValue = 'generic') {
  const sql = typeof sqlValue === 'string' ? sqlValue.trim() : '';
  const dialect = typeof dialectValue === 'string' && dialectValue.trim()
    ? dialectValue.trim().toLowerCase()
    : 'generic';
  if (!sql) {
    return {
      valid: false,
      dialect,
      checker: 'ccui-simulated-sql-syntax-checker',
      statementCount: 0,
      issues: [issue('', 'empty_sql', 'SQL text is empty.')],
    };
  }

  const scanned = scanSql(sql);
  const issues = [...scanned.issues];
  for (const statement of scanned.statements) {
    const maskedStatement = scanned.masked.slice(statement.offset, statement.offset + statement.text.length).trim();
    const firstTokenMatch = maskedStatement.match(/^([A-Za-z]+)/);
    const firstToken = firstTokenMatch?.[1]?.toUpperCase() || '';
    if (!STATEMENT_STARTERS.has(firstToken)) {
      issues.push(issue(
        sql,
        'unknown_statement_start',
        `Unrecognized SQL statement start${firstToken ? `: ${firstToken}` : ''}.`,
        statement.offset,
      ));
    }
    addPatternIssue(sql, maskedStatement, statement.offset, issues, /\bSELECT\s*(?:FROM\b|WHERE\b|GROUP\s+BY\b|ORDER\s+BY\b|HAVING\b|LIMIT\b|$)/i, 'missing_select_expression', 'SELECT must be followed by an expression.');
    addPatternIssue(sql, maskedStatement, statement.offset, issues, /,\s*(?:FROM\b|WHERE\b|GROUP\s+BY\b|ORDER\s+BY\b|HAVING\b|LIMIT\b|$)/i, 'trailing_comma', 'A comma cannot appear immediately before the next SQL clause.');
    addPatternIssue(sql, maskedStatement, statement.offset, issues, /\bFROM\s*(?:WHERE\b|GROUP\s+BY\b|ORDER\s+BY\b|HAVING\b|LIMIT\b|$)/i, 'missing_from_source', 'FROM must be followed by a table or subquery.');
    addPatternIssue(sql, maskedStatement, statement.offset, issues, /\bWHERE\s*(?:GROUP\s+BY\b|ORDER\s+BY\b|HAVING\b|LIMIT\b|$)/i, 'missing_where_expression', 'WHERE must be followed by an expression.');
    addPatternIssue(sql, maskedStatement, statement.offset, issues, /(?:,|\+|-|\/|=|<>|<=|>=|<|>|\bAND\b|\bOR\b)\s*$/i, 'incomplete_expression', 'SQL statement ends with an incomplete expression.');
  }

  return {
    valid: issues.length === 0,
    dialect,
    checker: 'ccui-simulated-sql-syntax-checker',
    statementCount: scanned.statements.length,
    issues,
  };
}

export function extractSqlForSyntaxCheck(value) {
  const text = typeof value === 'string' ? value : '';
  const snippets = [];
  const fencedPattern = /```sql\s*\n?([\s\S]*?)```/gi;
  let match;
  while ((match = fencedPattern.exec(text)) !== null) {
    if (match[1].trim()) snippets.push(match[1].trim());
  }
  return snippets.length > 0 ? snippets.join(';\n') : text;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('request_body_too_large');
  }
  return body.trim() ? JSON.parse(body) : {};
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export async function handleSqlSyntaxMcpRequest(req, res) {
  const sessionHeaders = { 'mcp-session-id': SESSION_ID };
  if (req.method === 'GET') {
    sendJson(res, 200, {
      status: 'ok',
      server: SQL_SYNTAX_MCP_SERVER_NAME,
      simulated: true,
      tools: [SQL_SYNTAX_MCP_TOOL_NAME],
    });
    return;
  }
  if (req.method === 'DELETE') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  let rpc;
  try {
    rpc = await readBody(req);
  } catch (error) {
    sendJson(res, 400, rpcError(null, -32700, error.message === 'request_body_too_large' ? error.message : 'Invalid JSON'));
    return;
  }

  if (rpc.method === 'initialize') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: rpc.id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SQL_SYNTAX_MCP_SERVER_NAME, version: '1.0.0-simulated' },
      },
    }, sessionHeaders);
    return;
  }
  if (rpc.method === 'notifications/initialized') {
    res.statusCode = 202;
    res.setHeader('mcp-session-id', SESSION_ID);
    res.end();
    return;
  }
  if (rpc.method === 'ping') {
    sendJson(res, 200, { jsonrpc: '2.0', id: rpc.id, result: {} }, sessionHeaders);
    return;
  }
  if (rpc.method === 'tools/list') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: rpc.id,
      result: { tools: [SQL_SYNTAX_MCP_TOOL] },
    }, sessionHeaders);
    return;
  }
  if (rpc.method === 'tools/call') {
    if (rpc.params?.name !== SQL_SYNTAX_MCP_TOOL_NAME) {
      sendJson(res, 200, rpcError(rpc.id, -32602, `Unknown tool ${rpc.params?.name || ''}`), sessionHeaders);
      return;
    }
    const args = rpc.params?.arguments || {};
    const payload = checkSqlSyntax(extractSqlForSyntaxCheck(args.sql), args.dialect);
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: rpc.id,
      result: toolResult(payload),
    }, sessionHeaders);
    return;
  }

  sendJson(res, 200, rpcError(rpc.id, -32601, `Unknown method ${rpc.method || ''}`), sessionHeaders);
}

export function createSqlSyntaxMcpServer() {
  return http.createServer(handleSqlSyntaxMcpRequest);
}
