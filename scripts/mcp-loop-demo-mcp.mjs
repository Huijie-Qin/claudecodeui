import http from 'node:http';
import { pathToFileURL } from 'node:url';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 40131;
const DEFAULT_TASK_SERVICE_URL = 'http://127.0.0.1:40130';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const MAX_BODY_BYTES = 1_000_000;

export const EXECUTE_TASK_TOOL = {
  name: 'execute_task',
  description: 'Submits a simulated task that normally completes after 20 minutes and returns its task ID.',
  inputSchema: {
    type: 'object',
    properties: {
      should_fail: { type: 'boolean', description: 'Complete in the failed state instead of success.', default: false },
    },
    additionalProperties: false,
  },
};

export const GET_TASK_STATUS_TOOL = {
  name: 'get_task_status',
  description: 'Returns the current state of a submitted task: running, success, or failed.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task ID returned by execute_task.' },
    },
    required: ['task_id'],
    additionalProperties: false,
  },
};

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
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

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function requestTaskService(taskServiceUrl, pathname, init) {
  const response = await fetch(new URL(pathname, taskServiceUrl), init);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || `Task service returned HTTP ${response.status}`);
  return payload;
}

export function createMcpLoopDemoMcpServer({
  taskServiceUrl = DEFAULT_TASK_SERVICE_URL,
  requiredAuthorization = null,
} = {}) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
    if (request.method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { status: 'ok', task_service_url: taskServiceUrl, calls });
      return;
    }
    if (pathname !== '/mcp') {
      sendJson(response, 404, { error: 'not_found' });
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
    if (requiredAuthorization && request.headers.authorization !== requiredAuthorization) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }

    let rpc;
    try {
      rpc = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, rpcError(null, -32700, error?.message || String(error)));
      return;
    }

    const sessionHeaders = { 'mcp-session-id': 'mcp-loop-demo-session' };
    if (rpc.method === 'initialize') {
      sendJson(response, 200, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'mcp-loop-demo', version: '1.0.0' },
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
      sendJson(response, 200, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: { tools: [EXECUTE_TASK_TOOL, GET_TASK_STATUS_TOOL] },
      }, sessionHeaders);
      return;
    }
    if (rpc.method !== 'tools/call') {
      sendJson(response, 200, rpcError(rpc.id, -32601, `Unknown method ${rpc.method || ''}`), sessionHeaders);
      return;
    }

    const toolName = rpc.params?.name;
    const input = rpc.params?.arguments || {};
    try {
      let payload;
      if (toolName === EXECUTE_TASK_TOOL.name) {
        payload = await requestTaskService(taskServiceUrl, '/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ should_fail: input.should_fail === true }),
        });
      } else if (toolName === GET_TASK_STATUS_TOOL.name) {
        if (!input.task_id) throw new Error('task_id is required');
        payload = await requestTaskService(taskServiceUrl, `/tasks/${encodeURIComponent(input.task_id)}`);
      } else {
        sendJson(response, 200, rpcError(rpc.id, -32601, `Unknown tool ${toolName || ''}`), sessionHeaders);
        return;
      }
      calls.push({ toolName, input: structuredClone(input), output: structuredClone(payload) });
      sendJson(response, 200, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
        },
      }, sessionHeaders);
    } catch (error) {
      const message = error?.message || String(error);
      sendJson(response, 200, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: { isError: true, content: [{ type: 'text', text: message }] },
      }, sessionHeaders);
    }
  });
  server.demoState = { calls, taskServiceUrl };
  return server;
}

export function startMcpLoopDemoMcpServer({
  host = process.env.MCP_LOOP_DEMO_MCP_HOST || DEFAULT_HOST,
  port = Number(process.env.MCP_LOOP_DEMO_MCP_PORT || DEFAULT_PORT),
  taskServiceUrl = process.env.MCP_LOOP_DEMO_TASK_URL || DEFAULT_TASK_SERVICE_URL,
} = {}) {
  const server = createMcpLoopDemoMcpServer({ taskServiceUrl });
  server.listen(port, host, () => {
    console.log(`[mcp-loop-demo-mcp] listening on http://${host}:${port}/mcp; task service ${taskServiceUrl}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpLoopDemoMcpServer();
}
