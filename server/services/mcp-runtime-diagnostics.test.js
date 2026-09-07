import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createMcpRuntimeDiagnostics } from './mcp-runtime-diagnostics.js';

function setup(options = {}) {
  const logs = [];
  const diagnostics = createMcpRuntimeDiagnostics({
    requestId: 'request-1', workspaceId: 12, runtimeMode: 'docker',
    workspacePath: '/srv/workspaces/demo', containerName: 'workspace-container',
    logger: { info: (prefix, payload) => {
      assert.equal(prefix, '[MCP Runtime]');
      logs.push(JSON.parse(payload));
    } },
    ...options,
  });
  return { logs, diagnostics };
}

test('logs actual config and SDK status without config values or raw error bodies', async () => {
  const { logs, diagnostics } = setup();
  diagnostics.logConfig({
    strictMcpConfig: true,
    mcpServers: {
      docs: { url: 'https://private.example/?token=SECRET', headers: { Authorization: 'SECRET' } },
      missing: { command: 'secret-command', env: { TOKEN: 'SECRET' } },
    },
    disallowedTools: ['Bash', 'mcp__docs__write'],
  });
  let requests = 0;
  const message = {
    type: 'system', subtype: 'init', session_id: 'session-1',
    mcp_servers: [{ name: 'docs', status: 'pending' }],
    tools: ['Read', 'mcp__docs__read'],
  };
  const query = { mcpServerStatus: async () => {
    requests++;
    return [{
      name: 'docs', status: 'failed', error: 'HTTP 401 SECRET private.example',
      config: { headers: { Authorization: 'SECRET' } },
    }];
  } };
  diagnostics.observe(message, query);
  await delay(0);
  diagnostics.observe(message, query);
  assert.equal(requests, 1);
  assert.deepEqual(logs[0].serverNames, ['docs', 'missing']);
  assert.equal(logs[0].configPath, '/srv/workspaces/demo/.mcp.json');
  assert.deepEqual(logs[0].disallowedMcpTools, ['mcp__docs__write']);
  assert.equal(logs[1].servers[0].advertisedToolCount, 1);
  const status = logs.find((entry) => entry.event === 'sdk_status');
  assert.equal(status.sessionId, 'session-1');
  assert.equal(status.servers[0].errorCategory, 'authentication');
  assert.equal(status.servers[0].toolCount, null);
  assert.deepEqual(status.missingFromSnapshot, ['missing']);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|private\.example|secret-command|Authorization/);
});

test('distinguishes connected with no tools from unknown tool inventory', async () => {
  const { logs, diagnostics } = setup();
  diagnostics.observe({ type: 'assistant' }, {});
  assert.equal(logs.length, 0);
  diagnostics.observe({ type: 'system', subtype: 'init', session_id: 's' }, {
    mcpServerStatus: async () => [
      { name: 'empty', status: 'connected', tools: [] },
      { name: 'ready', status: 'connected', tools: [{ name: 'read', description: 'SECRET' }] },
      { name: 'pending', status: 'pending' },
    ],
  });
  await delay(0);
  const status = logs.find((entry) => entry.event === 'sdk_status');
  assert.deepEqual(status.servers.map((server) => server.toolCount), [0, 1, null]);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
});

test('status failure, unsupported SDK and timeout do not break the message consumer', async () => {
  for (const [query, expected] of [
    [{}, { reason: 'unsupported_sdk' }],
    [{ mcpServerStatus: async () => { throw new Error('ECONNRESET SECRET'); } }, { errorCategory: 'network' }],
    [{ mcpServerStatus: () => new Promise(() => {}) }, { errorCategory: 'timeout' }],
  ]) {
    const { logs, diagnostics } = setup({ statusTimeoutMs: 5 });
    assert.equal(diagnostics.observe({ type: 'system', subtype: 'init' }, query), undefined);
    await delay(20);
    const unavailable = logs.find((entry) => entry.event === 'status_unavailable');
    for (const [key, value] of Object.entries(expected)) assert.equal(unavailable[key], value);
    assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
  }
});
