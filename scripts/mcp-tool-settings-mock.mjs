import http from 'node:http';
import { pathToFileURL } from 'node:url';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 40123;
const MCP_PROTOCOL_VERSION = '2024-11-05';
const MAX_BODY_BYTES = 1_000_000;

export const ECHO_SETTINGS_TOOL = {
  name: 'echo_settings',
  description: 'Echoes received parameters so MCP default and force strategies can be verified end to end.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'Free-form topic supplied by the Agent.',
        default: 'schema-topic',
        examples: ['agent-topic'],
      },
      limit: {
        type: 'number',
        description: 'Maximum number of mock results.',
        default: 5,
        examples: [10],
      },
      region: {
        type: 'string',
        description: 'Region used for the mock lookup.',
        enum: ['global', 'cn', 'us'],
        default: 'global',
      },
      include_metadata: {
        type: 'boolean',
        description: 'Whether the mock result includes metadata.',
        default: true,
      },
      filters: {
        type: 'array',
        description: 'Structured filters passed to the mock lookup.',
        items: { type: 'string' },
        default: [],
        examples: [['published']],
      },
    },
    additionalProperties: false,
  },
};

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
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

export function createMcpToolSettingsMockServer() {
  const calls = [];

  return http.createServer(async (request, response) => {
    const pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
    if (request.method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { status: 'ok', calls });
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

    let rpc;
    try {
      rpc = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, rpcError(null, -32700, error.message));
      return;
    }

    const sessionHeaders = { 'mcp-session-id': 'mcp-tool-settings-mock-session' };
    if (rpc.method === 'initialize') {
      sendJson(response, 200, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'mcp-tool-settings-mock', version: '1.0.0' },
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
        result: { tools: [ECHO_SETTINGS_TOOL] },
      }, sessionHeaders);
      return;
    }
    if (rpc.method === 'tools/call' && rpc.params?.name === ECHO_SETTINGS_TOOL.name) {
      const receivedArguments = rpc.params.arguments || {};
      calls.push(receivedArguments);
      const payload = { receivedArguments, callNumber: calls.length };
      sendJson(response, 200, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
        },
      }, sessionHeaders);
      return;
    }

    sendJson(response, 200, rpcError(rpc.id, -32601, `Unknown method ${rpc.method || ''}`), sessionHeaders);
  });
}

export function startMcpToolSettingsMockServer({
  host = process.env.MCP_TOOL_SETTINGS_MOCK_HOST || DEFAULT_HOST,
  port = Number(process.env.MCP_TOOL_SETTINGS_MOCK_PORT || DEFAULT_PORT),
} = {}) {
  const server = createMcpToolSettingsMockServer();
  server.listen(port, host, () => {
    console.log(`[mcp-tool-settings-mock] listening on http://${host}:${port}/mcp`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpToolSettingsMockServer();
}
