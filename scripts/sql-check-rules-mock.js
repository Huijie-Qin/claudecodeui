#!/usr/bin/env node
import http from 'node:http';

const HOST = process.env.SQL_CHECK_MOCK_HOST || '127.0.0.1';
const PORT = Number(process.env.SQL_CHECK_MOCK_PORT || 3102);

const DEFAULT_RULES = [
  {
    rule_id: 'require_where_for_update_delete',
    name: 'Require WHERE for UPDATE/DELETE',
    desc: 'UPDATE and DELETE statements must include a WHERE condition.',
  },
  {
    rule_id: 'block_select_star',
    name: 'Block SELECT *',
    desc: 'Queries should select explicit columns instead of using SELECT *.',
  },
  {
    rule_id: 'limit_large_select',
    name: 'Limit large SELECT',
    desc: 'Read-only queries should include LIMIT or pagination for large result sets.',
  },
  {
    rule_id: 'block_drop_table',
    name: 'Block DROP TABLE',
    desc: 'DROP TABLE requires manual review before execution.',
  },
];

function loadRules() {
  const rawRules = process.env.SQL_CHECK_MOCK_RULES_JSON;
  if (!rawRules) return DEFAULT_RULES;

  try {
    const parsed = JSON.parse(rawRules);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.response)) return parsed.response;
  } catch (error) {
    console.warn(`[sql-check-mock] Failed to parse SQL_CHECK_MOCK_RULES_JSON: ${error.message}`);
  }

  return DEFAULT_RULES;
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, {});
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { status: 'ok' });
  }

  if (req.method === 'GET' && url.pathname === '/sql-check/rules') {
    return sendJson(res, 200, { response: loadRules() });
  }

  return sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[sql-check-mock] listening on http://${HOST}:${PORT}`);
  console.log(`[sql-check-mock] rules endpoint: http://${HOST}:${PORT}/sql-check/rules`);
});
