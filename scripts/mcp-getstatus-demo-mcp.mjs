import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 40151;
const DEFAULT_API_URL = 'http://127.0.0.1:40150';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const MAX_BODY_BYTES = 64 * 1024;

export const GETSTATUS_TOOL = {
  name: 'getstatus',
  description: 'Returns running until 20 minutes after this ID was first seen by the remote API, then success. Supply a random ID initially and reuse that exact ID for every subsequent call.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, maxLength: 256, description: 'Caller-provided random ID. Reuse the same ID when polling.' } },
    required: ['id'],
    additionalProperties: false,
  },
};

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('request_body_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function createMcpGetstatusDemoMcpServer({
  apiUrl = DEFAULT_API_URL,
  requiredAuthorization = null,
  now = () => Date.now(),
} = {}) {
  const calls = [];
  const startedAtMs = now();
  const instanceId = crypto.randomUUID();
  const pid = process.pid;
  const hostname = os.hostname();
  const sessionHeaders = { 'mcp-session-id': instanceId };
  const evidence = () => ({ calls, apiUrl, startedAtMs, instanceId, pid, hostname });
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
    if (request.method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { status: 'ok', apiUrl, instanceId, pid });
      return;
    }
    if (request.method === 'GET' && pathname === '/evidence') {
      sendJson(response, 200, evidence());
      return;
    }
    if (pathname !== '/mcp') {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    if (requiredAuthorization && request.headers.authorization !== requiredAuthorization) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    if (request.method === 'DELETE') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }
    let rpc;
    try {
      rpc = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, rpcError(null, -32700, error?.message || String(error)));
      return;
    }
    if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      sendJson(response, 400, rpcError(rpc?.id, -32600, 'Invalid JSON-RPC request'));
      return;
    }
    if (rpc.method === 'initialize') {
      sendJson(response, 200, {
        jsonrpc: '2.0', id: rpc.id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'mcp-getstatus-demo', version: '1.0.0' },
        },
      }, sessionHeaders);
      return;
    }
    if (rpc.method === 'notifications/initialized') {
      response.writeHead(202, sessionHeaders);
      response.end();
      return;
    }
    if (rpc.method === 'tools/list') {
      sendJson(response, 200, { jsonrpc: '2.0', id: rpc.id, result: { tools: [GETSTATUS_TOOL] } }, sessionHeaders);
      return;
    }
    if (rpc.method !== 'tools/call') {
      sendJson(response, 200, rpcError(rpc.id, -32601, `Unknown method ${rpc.method}`), sessionHeaders);
      return;
    }
    const toolName = rpc.params?.name;
    if (toolName !== GETSTATUS_TOOL.name) {
      sendJson(response, 200, rpcError(rpc.id, -32601, `Unknown tool ${toolName || ''}`), sessionHeaders);
      return;
    }
    const input = rpc.params?.arguments;
    const callStartedAtMs = now();
    const recordCall = (outcome) => {
      const completedAtMs = now();
      calls.push({
        toolName,
        input: structuredClone(input ?? null),
        startedAtMs: callStartedAtMs,
        completedAtMs,
        durationMs: Math.max(0, completedAtMs - callStartedAtMs),
        ...outcome,
      });
    };
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.id !== 'string'
        || !input.id.trim() || input.id.length > 256 || Object.keys(input).some((key) => key !== 'id')) {
        throw new Error('getstatus requires only one non-empty string argument: id (at most 256 characters)');
      }
      const upstreamUrl = new URL('/status', apiUrl);
      upstreamUrl.searchParams.set('id', input.id);
      const upstream = await fetch(upstreamUrl, { signal: AbortSignal.timeout(10_000) });
      const payload = await upstream.json();
      if (!upstream.ok) throw new Error(payload?.error || `Status API returned HTTP ${upstream.status}`);
      recordCall({ output: structuredClone(payload) });
      sendJson(response, 200, {
        jsonrpc: '2.0', id: rpc.id,
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload },
      }, sessionHeaders);
    } catch (error) {
      const message = error?.message || String(error);
      recordCall({ error: message });
      sendJson(response, 200, {
        jsonrpc: '2.0', id: rpc.id,
        result: { isError: true, content: [{ type: 'text', text: message }] },
      }, sessionHeaders);
    }
  });
  server.demoState = { calls, apiUrl, startedAtMs, instanceId, pid, hostname };
  return server;
}

export function startMcpGetstatusDemoMcpServer({
  host = process.env.MCP_GETSTATUS_DEMO_MCP_HOST || DEFAULT_HOST,
  port = Number(process.env.MCP_GETSTATUS_DEMO_MCP_PORT || DEFAULT_PORT),
  apiUrl = process.env.MCP_GETSTATUS_DEMO_API_URL || DEFAULT_API_URL,
} = {}) {
  const server = createMcpGetstatusDemoMcpServer({ apiUrl });
  server.listen(port, host, () => {
    console.log(`[mcp-getstatus-demo-mcp] listening on http://${host}:${port}/mcp; status API ${apiUrl}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpGetstatusDemoMcpServer();
}
