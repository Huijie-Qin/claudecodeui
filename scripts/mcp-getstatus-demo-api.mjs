import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

export const TWENTY_MINUTES_MS = 20 * 60 * 1000;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 40150;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

// Each ID's first HTTP request starts its own clock. Polls only read that clock;
// neither this API nor its MCP client sleeps until the task is complete.
export function createMcpGetstatusDemoApiServer({ now = () => Date.now() } = {}) {
  const records = new Map();
  const observations = [];
  const startedAtMs = now();
  const instanceId = crypto.randomUUID();
  const pid = process.pid;
  const hostname = os.hostname();
  const evidence = () => ({
    instanceId,
    pid,
    hostname,
    startedAtMs,
    durationMs: TWENTY_MINUTES_MS,
    records: [...records.values()],
    observations,
  });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok', instanceId, pid, recordCount: records.size });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/evidence') {
      sendJson(response, 200, evidence());
      return;
    }
    if (url.pathname !== '/status') {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }
    const id = url.searchParams.get('id');
    if (!id || !id.trim() || id.length > 256 || url.searchParams.getAll('id').length !== 1) {
      sendJson(response, 400, { error: 'id must be one non-empty string of at most 256 characters' });
      return;
    }
    const observedAtMs = now();
    let record = records.get(id);
    const firstSeen = !record;
    if (!record) {
      record = { id, createdAtMs: observedAtMs, durationMs: TWENTY_MINUTES_MS };
      records.set(id, record);
    }
    const elapsedMs = Math.max(0, observedAtMs - record.createdAtMs);
    const complete = elapsedMs >= record.durationMs;
    const result = {
      id,
      status: complete ? 'success' : 'running',
      created_at_ms: record.createdAtMs,
      observed_at_ms: observedAtMs,
      elapsed_ms: elapsedMs,
      duration_ms: record.durationMs,
      finished_at_ms: complete ? record.createdAtMs + record.durationMs : null,
    };
    observations.push({ firstSeen, ...result });
    sendJson(response, 200, result);
  });
  server.demoState = { records, observations, startedAtMs, instanceId, pid, hostname, durationMs: TWENTY_MINUTES_MS };
  return server;
}

export function startMcpGetstatusDemoApiServer({
  host = process.env.MCP_GETSTATUS_DEMO_API_HOST || DEFAULT_HOST,
  port = Number(process.env.MCP_GETSTATUS_DEMO_API_PORT || DEFAULT_PORT),
} = {}) {
  const server = createMcpGetstatusDemoApiServer();
  server.listen(port, host, () => {
    console.log(`[mcp-getstatus-demo-api] listening on http://${host}:${port}; first-seen IDs complete after ${TWENTY_MINUTES_MS} ms`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpGetstatusDemoApiServer();
}
