import http from 'node:http';

const PORT = Number(process.env.PORT || 39999);
const TOKEN = process.env.DEMO_MCP_TOKEN || 'demo-internal-token';

const servers = {
  '/knowledge': {
    name: 'demo_knowledge_retrieval',
    tools: [
      {
        name: 'search_internal_docs',
        description: 'Search internal product, engineering, and operation documents.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query.' },
            limit: { type: 'number', description: 'Maximum number of matching records.' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      {
        name: 'summarize_design_notes',
        description: 'Summarize internal design notes for the current workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Topic to summarize.' },
          },
          required: ['topic'],
          additionalProperties: false,
        },
      },
      {
        name: 'find_decision_records',
        description: 'Find architecture and product decision records.',
        inputSchema: {
          type: 'object',
          properties: {
            area: { type: 'string', description: 'Product or engineering area.' },
          },
          required: ['area'],
          additionalProperties: false,
        },
      },
    ],
  },
  '/data-query': {
    name: 'demo_data_query',
    tools: [
      {
        name: 'query_business_metrics',
        description: 'Run approved internal metric lookups.',
        inputSchema: {
          type: 'object',
          properties: {
            metric: { type: 'string', description: 'Approved metric name.' },
            period: { type: 'string', description: 'Reporting period.' },
          },
          required: ['metric'],
          additionalProperties: false,
        },
      },
      {
        name: 'lookup_customer_segment',
        description: 'Return governed customer segment metadata.',
        inputSchema: {
          type: 'object',
          properties: {
            segment: { type: 'string', description: 'Customer segment identifier.' },
          },
          required: ['segment'],
          additionalProperties: false,
        },
      },
    ],
  },
  '/workspace-insight': {
    name: 'demo_workspace_insight',
    tools: [
      {
        name: 'inspect_workspace_health',
        description: 'Inspect workspace health signals and repository metadata.',
        inputSchema: {
          type: 'object',
          properties: {
            workspace: { type: 'string', description: 'Workspace name.' },
          },
          required: ['workspace'],
          additionalProperties: false,
        },
      },
      {
        name: 'list_dependency_hotspots',
        description: 'List dependency and module hotspots for a workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            workspace: { type: 'string', description: 'Workspace name.' },
          },
          required: ['workspace'],
          additionalProperties: false,
        },
      },
      {
        name: 'summarize_recent_agent_activity',
        description: 'Summarize recent agent activity visible to the workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            workspace: { type: 'string', description: 'Workspace name.' },
          },
          required: ['workspace'],
          additionalProperties: false,
        },
      },
      {
        name: 'suggest_project_next_steps',
        description: 'Suggest next implementation steps from workspace context.',
        inputSchema: {
          type: 'object',
          properties: {
            workspace: { type: 'string', description: 'Workspace name.' },
            focus: { type: 'string', description: 'Optional planning focus.' },
          },
          required: ['workspace'],
          additionalProperties: false,
        },
      },
    ],
  },
};

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const preset = servers[new URL(req.url, `http://${req.headers.host}`).pathname];
  if (!preset) {
    sendJson(res, 404, { error: 'unknown_demo_mcp_server' });
    return;
  }

  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    sendJson(res, 401, { error: 'invalid_demo_token' });
    return;
  }

  let rpc;
  try {
    rpc = await parseBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }

  if (rpc.method === 'initialize') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: rpc.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: preset.name, version: '1.0.0-demo' },
      },
    }, { 'mcp-session-id': `${preset.name}-session` });
    return;
  }

  if (rpc.method === 'notifications/initialized') {
    res.writeHead(202);
    res.end();
    return;
  }

  if (rpc.method === 'tools/list') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: rpc.id,
      result: { tools: preset.tools },
    }, { 'mcp-session-id': `${preset.name}-session` });
    return;
  }

  if (rpc.method === 'tools/call') {
    const toolName = rpc.params?.name;
    const tool = preset.tools.find((candidate) => candidate.name === toolName);

    if (!tool) {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: rpc.id,
        error: { code: -32602, message: `Unknown tool ${toolName}` },
      }, { 'mcp-session-id': `${preset.name}-session` });
      return;
    }

    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: rpc.id,
      result: {
        content: [
          {
            type: 'text',
            text: `${preset.name}.${toolName} demo result: ${JSON.stringify(rpc.params?.arguments || {})}`,
          },
        ],
      },
    }, { 'mcp-session-id': `${preset.name}-session` });
    return;
  }

  sendJson(res, 200, {
    jsonrpc: '2.0',
    id: rpc.id,
    error: { code: -32601, message: `Unknown method ${rpc.method}` },
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Demo MCP preset server listening on http://127.0.0.1:${PORT}`);
});
