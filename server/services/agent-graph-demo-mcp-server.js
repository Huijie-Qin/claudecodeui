import http from 'node:http';
import { pathToFileURL } from 'node:url';

import {
  REPORT_DIMENSIONS,
  REPORT_METRICS,
  agentGraphDemoDataService,
} from './agent-graph-demo-data.js';

const DEFAULT_PORT = 39999;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_TOKEN = 'agent-graph-demo-internal';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const MAX_BODY_BYTES = 1_000_000;

const stringArraySchema = {
  type: 'array',
  items: { type: 'string' },
};

function reportQueryProperties() {
  return {
    start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format.' },
    end_date: { type: 'string', description: 'End date in YYYY-MM-DD format.' },
    apps: { ...stringArraySchema, description: 'Music App ids or names.' },
    dimensions: { ...stringArraySchema, description: `Grouping dimensions: ${REPORT_DIMENSIONS.join(', ')}.` },
    metrics: { ...stringArraySchema, description: `Metrics: ${REPORT_METRICS.join(', ')}.` },
  };
}

const audienceProperties = {
  filters: {
    type: 'array',
    description: 'Tag filters such as app.soda-music.status eq 已卸载.',
    items: {
      type: 'object',
      properties: {
        tag: { type: 'string' },
        operator: { type: 'string' },
        value: {},
      },
      required: ['tag', 'operator'],
      additionalProperties: false,
    },
  },
  dimensions: { ...stringArraySchema, description: 'Tags to analyze.' },
  match: { type: 'string', enum: ['all', 'any'] },
  top_n: { type: 'number', minimum: 1, maximum: 50 },
};

function defineTool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  };
}

function normalizeReportArguments(args = {}) {
  return {
    startDate: args.start_date,
    endDate: args.end_date,
    apps: args.apps,
    dimensions: args.dimensions,
    metrics: args.metrics,
  };
}

function firstSqlMatch(sql, patterns) {
  for (const pattern of patterns) {
    const match = sql.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function translateHiveSql(sql) {
  const normalizedSql = String(sql || '').trim();
  if (!/\bfrom\s+(?:[a-zA-Z0-9_]+\.)?music_app_daily_metrics\b/i.test(normalizedSql)) {
    throw new Error('Demo Hive supports SELECT queries from music_app_daily_metrics. Use describe_hive_tables for the schema.');
  }
  if (!/^select\b/i.test(normalizedSql) || /\b(insert|update|delete|drop|alter|truncate|create)\b/i.test(normalizedSql)) {
    throw new Error('Demo Hive is read-only and accepts SELECT statements only.');
  }

  const between = normalizedSql.match(/\bdate\s+between\s+'(\d{4}-\d{2}-\d{2})'\s+and\s+'(\d{4}-\d{2}-\d{2})'/i);
  const startDate = between?.[1] || firstSqlMatch(normalizedSql, [
    /\bdate\s*>=\s*'(\d{4}-\d{2}-\d{2})'/i,
    /\bdate\s*>\s*'(\d{4}-\d{2}-\d{2})'/i,
  ]);
  const endDate = between?.[2] || firstSqlMatch(normalizedSql, [
    /\bdate\s*<=\s*'(\d{4}-\d{2}-\d{2})'/i,
    /\bdate\s*<\s*'(\d{4}-\d{2}-\d{2})'/i,
  ]);
  const app = firstSqlMatch(normalizedSql, [
    /\bapp_id\s*=\s*'([^']+)'/i,
    /\bapp_name\s*=\s*'([^']+)'/i,
  ]);
  const selectClause = normalizedSql.match(/^select\s+([\s\S]+?)\s+from\b/i)?.[1] || '';
  const metrics = REPORT_METRICS.filter((metric) => new RegExp(`\\b${metric}\\b`, 'i').test(selectClause));
  const groupBy = normalizedSql.match(/\bgroup\s+by\s+([\s\S]+?)(?:\border\s+by\b|\blimit\b|$)/i)?.[1] || '';
  const dimensions = REPORT_DIMENSIONS.filter((dimension) => new RegExp(`\\b${dimension}\\b`, 'i').test(groupBy));
  if (/date_format\s*\(\s*date[^)]*%Y-%m/i.test(selectClause + groupBy) && !dimensions.includes('month')) {
    dimensions.push('month');
  }
  if (dimensions.length === 0) dimensions.push('month', 'app_name');

  return {
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    apps: app ? [app] : undefined,
    dimensions,
    metrics: metrics.length ? metrics : undefined,
  };
}

function createServers(dataService) {
  return {
    '/hive': {
      name: 'hive-mcp',
      tools: [
        defineTool(
          'describe_hive_tables',
          'Describe the simulated Hive warehouse tables, columns, data coverage, and metric semantics.',
          {},
        ),
        defineTool(
          'query_hive_metrics',
          'Run a governed structured query against the simulated music_app_daily_metrics Hive table.',
          reportQueryProperties(),
        ),
        defineTool(
          'execute_hive_sql',
          'Execute a read-only SELECT subset against music_app_daily_metrics. Supports date filters, App equality filters, grouping dimensions, and approved metric columns.',
          { sql: { type: 'string', description: 'Read-only Hive SELECT statement.' } },
          ['sql'],
        ),
      ],
      handlers: {
        describe_hive_tables: () => ({
          engine: 'simulated-hive',
          readOnly: true,
          tables: [
            {
              name: 'music_app_daily_metrics',
              grain: 'date + app + optional platform/region/city-tier/channel dimensions',
              dimensions: REPORT_DIMENSIONS,
              metrics: REPORT_METRICS,
            },
            {
              name: 'music_user_profiles',
              grain: 'anonymous deterministic user sample',
              note: 'Use 标签查询MCP for governed cohort filters and profile analysis.',
            },
          ],
          schema: dataService.getMusicReportSchema(),
        }),
        query_hive_metrics: (args) => dataService.queryMusicReports(normalizeReportArguments(args)),
        execute_hive_sql: (args) => {
          const translatedQuery = translateHiveSql(args.sql);
          return {
            engine: 'simulated-hive',
            sql: args.sql,
            translatedQuery,
            result: dataService.queryMusicReports(translatedQuery),
          };
        },
      },
    },
    '/bi-query': {
      name: 'bi-query-mcp',
      tools: [
        defineTool(
          'get_metric_catalog',
          'Return the governed BI metric catalog, supported dimensions, App catalog, coverage, and data-quality notes.',
          {},
        ),
        defineTool(
          'query_metric_report',
          'Query a BI report for installs, new users, uninstalls, retention, activity, subscriptions, listening, channels, platforms, and geography.',
          reportQueryProperties(),
        ),
        defineTool(
          'compare_metric_periods',
          'Compare the same App metrics between a current period and a baseline period.',
          {
            apps: { ...stringArraySchema, description: 'Music App ids or names.' },
            metrics: { ...stringArraySchema, description: 'Metrics to compare.' },
            dimensions: { ...stringArraySchema, description: 'Optional non-time breakdown dimensions.' },
            current_start: { type: 'string' },
            current_end: { type: 'string' },
            baseline_start: { type: 'string' },
            baseline_end: { type: 'string' },
          },
          ['current_start', 'current_end', 'baseline_start', 'baseline_end'],
        ),
      ],
      handlers: {
        get_metric_catalog: () => dataService.getMusicReportSchema(),
        query_metric_report: (args) => dataService.queryMusicReports(normalizeReportArguments(args)),
        compare_metric_periods: (args) => {
          const dimensions = ['app_name', ...(args.dimensions || []).filter((value) => value !== 'date' && value !== 'week' && value !== 'month')];
          const common = { apps: args.apps, metrics: args.metrics, dimensions: [...new Set(dimensions)] };
          return {
            current: dataService.queryMusicReports({
              ...common,
              startDate: args.current_start,
              endDate: args.current_end,
            }),
            baseline: dataService.queryMusicReports({
              ...common,
              startDate: args.baseline_start,
              endDate: args.baseline_end,
            }),
          };
        },
      },
    },
    '/tag-query': {
      name: 'tag-query-mcp',
      tools: [
        defineTool(
          'list_profile_tags',
          'List governed audience tags, filter operators, enumerations, App profile fields, and data boundaries.',
          {},
        ),
        defineTool(
          'analyze_audience',
          'Define a cohort with profile/App tags, then return cohort size, tag distributions, baseline shares, and Lift.',
          audienceProperties,
          ['filters', 'dimensions'],
        ),
        defineTool(
          'sample_audience',
          'Return a small masked sample for validating cohort filters. Never returns real PII.',
          {
            ...audienceProperties,
            tags: { ...stringArraySchema, description: 'Tags to return for each masked sample.' },
            limit: { type: 'number', minimum: 1, maximum: 200 },
          },
          ['filters', 'tags'],
        ),
      ],
      handlers: {
        list_profile_tags: () => dataService.getAudienceSchema(),
        analyze_audience: (args) => dataService.analyzeAudience(args),
        sample_audience: (args) => dataService.sampleAudience(args),
      },
    },
  };
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        reject(new Error('request_body_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        return resolve(JSON.parse(body));
      } catch (error) {
        return reject(error);
      }
    });
    req.on('error', reject);
  });
}

function toolResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function createAgentGraphDemoMcpServer({
  dataService = agentGraphDemoDataService,
  token = process.env.DEMO_MCP_TOKEN || DEFAULT_TOKEN,
} = {}) {
  const servers = createServers(dataService);
  const toolCalls = new Map();
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'agent-graph-demo-mcp',
        servers: Object.values(servers).map((server) => ({ name: server.name, toolCount: server.tools.length })),
        toolCalls: Object.fromEntries(toolCalls),
      });
      return;
    }

    const preset = servers[pathname];
    if (!preset) {
      sendJson(res, 404, { error: 'unknown_demo_mcp_server' });
      return;
    }
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      sendJson(res, 401, { error: 'invalid_demo_token' });
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    let rpc;
    try {
      rpc = await parseBody(req);
    } catch (error) {
      sendJson(res, 400, rpcError(null, -32700, error.message === 'request_body_too_large' ? error.message : 'Invalid JSON'));
      return;
    }

    const sessionHeaders = { 'mcp-session-id': `${preset.name}-session` };
    if (rpc.method === 'initialize') {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: preset.name, version: '1.0.0-demo' },
        },
      }, sessionHeaders);
      return;
    }
    if (rpc.method === 'notifications/initialized') {
      res.writeHead(202, sessionHeaders);
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
        result: { tools: preset.tools },
      }, sessionHeaders);
      return;
    }
    if (rpc.method === 'tools/call') {
      const toolName = rpc.params?.name;
      const handler = preset.handlers[toolName];
      if (!handler) {
        sendJson(res, 200, rpcError(rpc.id, -32602, `Unknown tool ${toolName || ''}`), sessionHeaders);
        return;
      }
      try {
        const callKey = `${preset.name}.${toolName}`;
        toolCalls.set(callKey, (toolCalls.get(callKey) || 0) + 1);
        const payload = await handler(rpc.params?.arguments || {});
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: toolResult(payload),
        }, sessionHeaders);
      } catch (error) {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            content: [{ type: 'text', text: error?.message || 'Demo MCP tool failed' }],
            isError: true,
          },
        }, sessionHeaders);
      }
      return;
    }

    sendJson(res, 200, rpcError(rpc.id, -32601, `Unknown method ${rpc.method || ''}`), sessionHeaders);
  });
}

export function startAgentGraphDemoMcpServer({
  host = process.env.HOST || DEFAULT_HOST,
  port = Number(process.env.PORT || DEFAULT_PORT),
  token = process.env.DEMO_MCP_TOKEN || DEFAULT_TOKEN,
} = {}) {
  const server = createAgentGraphDemoMcpServer({ token });
  server.listen(port, host, () => {
    console.log(`[agent-graph-demo-mcp] listening on http://${host}:${port}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAgentGraphDemoMcpServer();
}
