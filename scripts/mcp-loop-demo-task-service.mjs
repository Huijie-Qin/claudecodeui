import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const TWENTY_MINUTES_MS = 20 * 60 * 1000;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 40130;
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        reject(new Error('request_body_too_large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(body.trim() ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function publicTask(task, now) {
  const observedAtMs = now();
  const elapsedMs = Math.max(0, observedAtMs - task.createdAtMs);
  const complete = elapsedMs >= task.durationMs;
  const status = complete ? (task.shouldFail ? 'failed' : 'success') : 'running';
  return {
    task_id: task.id,
    status,
    created_at_ms: task.createdAtMs,
    duration_ms: task.durationMs,
    observed_at_ms: observedAtMs,
    elapsed_ms: elapsedMs,
    finished_at_ms: complete ? task.createdAtMs + task.durationMs : null,
  };
}

export function createMcpLoopDemoTaskServer({
  durationMs = TWENTY_MINUTES_MS,
  now = () => Date.now(),
  createId = () => crypto.randomUUID(),
} = {}) {
  const tasks = new Map();
  const observations = [];
  const startedAtMs = now();
  const instanceId = crypto.randomUUID();
  const observeTask = (task, operation) => {
    const result = publicTask(task, now);
    observations.push({ operation, ...result });
    return result;
  };
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
    if (request.method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { status: 'ok', default_task_duration_ms: durationMs, task_count: tasks.size });
      return;
    }

    if (request.method === 'POST' && pathname === '/tasks') {
      try {
        const input = await readJsonBody(request);
        const task = {
          id: createId(),
          createdAtMs: now(),
          durationMs,
          shouldFail: input?.should_fail === true,
        };
        tasks.set(task.id, task);
        sendJson(response, 202, observeTask(task, 'execute_task'));
      } catch (error) {
        sendJson(response, 400, { error: error?.message || String(error) });
      }
      return;
    }

    const match = pathname.match(/^\/tasks\/([^/]+)$/);
    if (request.method === 'GET' && match) {
      const task = tasks.get(decodeURIComponent(match[1]));
      if (!task) {
        sendJson(response, 404, { error: 'task_not_found' });
        return;
      }
      sendJson(response, 200, observeTask(task, 'get_task_status'));
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  });
  server.demoState = { tasks, durationMs, observations, startedAtMs, instanceId };
  return server;
}

export function startMcpLoopDemoTaskServer({
  host = process.env.MCP_LOOP_DEMO_TASK_HOST || DEFAULT_HOST,
  port = Number(process.env.MCP_LOOP_DEMO_TASK_PORT || DEFAULT_PORT),
  durationMs = Number(process.env.MCP_LOOP_DEMO_TASK_DURATION_MS || TWENTY_MINUTES_MS),
} = {}) {
  const server = createMcpLoopDemoTaskServer({ durationMs });
  server.listen(port, host, () => {
    console.log(`[mcp-loop-demo-task] listening on http://${host}:${port}; task duration ${durationMs} ms`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpLoopDemoTaskServer();
}
