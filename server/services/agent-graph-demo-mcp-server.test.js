import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentGraphDemoMcpServer } from './agent-graph-demo-mcp-server.js';

const TOKEN = 'test-token';

async function withServer(run) {
  const server = createAgentGraphDemoMcpServer({ token: TOKEN });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function rpc(baseUrl, path, payload, token = TOKEN) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

test('Demo MCP exposes Hive, BI, and Tag tool inventories', async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
    assert.deepEqual(health.servers.map((server) => server.name), [
      'hive-mcp',
      'bi-query-mcp',
      'tag-query-mcp',
    ]);

    const expected = new Map([
      ['/hive', ['describe_hive_tables', 'query_hive_metrics', 'execute_hive_sql']],
      ['/bi-query', ['get_metric_catalog', 'query_metric_report', 'compare_metric_periods']],
      ['/tag-query', ['list_profile_tags', 'analyze_audience', 'sample_audience']],
    ]);
    for (const [path, toolNames] of expected) {
      const initialize = await rpc(baseUrl, path, {
        jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
      });
      assert.equal(initialize.response.status, 200);
      assert.ok(initialize.response.headers.get('mcp-session-id'));
      const listed = await rpc(baseUrl, path, {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
      });
      assert.deepEqual(listed.body.result.tools.map((tool) => tool.name), toolNames);
    }
  });
});

test('Demo MCP tools return consistent simulated reports and audience results', async () => {
  await withServer(async (baseUrl) => {
    const hive = await rpc(baseUrl, '/hive', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'execute_hive_sql',
        arguments: {
          sql: "SELECT app_name, uninstalls, uninstall_rate FROM music_app_daily_metrics WHERE date BETWEEN '2026-07-01' AND '2026-07-31' AND app_id = 'soda-music' GROUP BY app_name",
        },
      },
    });
    assert.equal(hive.body.result.isError, undefined);
    assert.equal(hive.body.result.structuredContent.result.rows.length, 1);
    assert.equal(hive.body.result.structuredContent.result.query.apps[0], 'soda-music');

    const bi = await rpc(baseUrl, '/bi-query', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'query_metric_report',
        arguments: {
          start_date: '2026-07-01',
          end_date: '2026-07-31',
          apps: ['soda-music'],
          dimensions: ['month', 'app_name'],
          metrics: ['new_users', 'uninstalls', 'uninstall_rate'],
        },
      },
    });
    assert.equal(bi.body.result.structuredContent.rows.length, 1);
    assert.deepEqual(bi.body.result.structuredContent.query.metrics, ['new_users', 'uninstalls', 'uninstall_rate']);

    const tags = await rpc(baseUrl, '/tag-query', {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'analyze_audience',
        arguments: {
          filters: [{ tag: 'app.soda-music.status', operator: 'eq', value: '已卸载' }],
          dimensions: ['age_band', 'occupation'],
          top_n: 5,
        },
      },
    });
    assert.ok(tags.body.result.structuredContent.cohort.size > 0);
    assert.equal(tags.body.result.structuredContent.analyses.length, 2);

    const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
    assert.equal(health.toolCalls['hive-mcp.execute_hive_sql'], 1);
    assert.equal(health.toolCalls['bi-query-mcp.query_metric_report'], 1);
    assert.equal(health.toolCalls['tag-query-mcp.analyze_audience'], 1);
  });
});

test('Demo MCP rejects invalid credentials', async () => {
  await withServer(async (baseUrl) => {
    const result = await rpc(baseUrl, '/hive', {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    }, 'wrong-token');
    assert.equal(result.response.status, 401);
    assert.equal(result.body.error, 'invalid_demo_token');
  });
});
