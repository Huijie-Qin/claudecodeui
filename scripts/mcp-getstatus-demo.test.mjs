import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpGetstatusDemoApiServer, TWENTY_MINUTES_MS } from './mcp-getstatus-demo-api.mjs';
import { createMcpGetstatusDemoMcpServer } from './mcp-getstatus-demo-mcp.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('status API starts a caller ID on first use and never resets it, with independent exact 20-minute boundaries', async () => {
  // Only unit tests advance this injected clock. CLI and browser E2E use Date.now().
  let currentTime = 1_800_000_000_000;
  const initialTime = currentTime;
  const api = createMcpGetstatusDemoApiServer({ now: () => currentTime });
  const url = await listen(api);
  const id = '7ca2e08b-d6f1-4306-9e35-d0d26d5a2b5d';
  const secondId = '8f4d5691-aa80-497d-8eb4-44d8b7f4d6ed';
  const status = async (queryId) => {
    const response = await fetch(`${url}/status?id=${encodeURIComponent(queryId)}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const first = await status(id);
    assert.equal(TWENTY_MINUTES_MS, 1_200_000);
    assert.deepEqual(first, {
      id, status: 'running', created_at_ms: initialTime, observed_at_ms: initialTime,
      elapsed_ms: 0, duration_ms: TWENTY_MINUTES_MS, finished_at_ms: null,
    });

    currentTime += 60_000;
    const second = await status(secondId);
    assert.equal(second.status, 'running');
    assert.equal(second.created_at_ms, currentTime);
    const repeated = await status(id);
    assert.equal(repeated.created_at_ms, initialTime);
    assert.equal(repeated.elapsed_ms, 60_000);

    currentTime = initialTime + TWENTY_MINUTES_MS - 1;
    assert.equal((await status(id)).status, 'running');
    currentTime += 1;
    const complete = await status(id);
    assert.equal(complete.status, 'success');
    assert.equal(complete.finished_at_ms, initialTime + TWENTY_MINUTES_MS);
    assert.equal(complete.elapsed_ms, TWENTY_MINUTES_MS);
    assert.equal((await status(secondId)).status, 'running');
    currentTime += 60_000;
    const secondComplete = await status(secondId);
    assert.equal(secondComplete.status, 'success');
    assert.equal(secondComplete.created_at_ms, second.created_at_ms);
    const later = await status(id);
    assert.equal(later.status, 'success');
    assert.equal(later.created_at_ms, initialTime);
    assert.equal(later.finished_at_ms, complete.finished_at_ms);

    const evidence = await (await fetch(`${url}/evidence`)).json();
    assert.equal(evidence.records.length, 2);
    assert.equal(evidence.observations.length, 8);
    assert.equal(evidence.observations.filter((entry) => entry.firstSeen).length, 2);
    assert.ok(evidence.instanceId);
    assert.ok(evidence.hostname);
    assert.equal(evidence.pid, process.pid);
    assert.equal(evidence.durationMs, TWENTY_MINUTES_MS);
    assert.equal(evidence.startedAtMs, initialTime);
    assert.ok(evidence.observations.filter((entry) => entry.id === id)
      .every((entry) => entry.created_at_ms === initialTime));
  } finally {
    await close(api);
  }
});

test('MCP exposes only getstatus and forwards the unchanged ID to the API on every call', async () => {
  let currentTime = 1_800_000_000_000;
  const api = createMcpGetstatusDemoApiServer({ now: () => currentTime });
  const apiUrl = await listen(api);
  const mcp = createMcpGetstatusDemoMcpServer({ apiUrl, now: () => currentTime });
  const mcpUrl = await listen(mcp);
  const id = '3ac51c93-a930-4390-8d91-1066fb6dfae7';
  let rpcSequence = 0;
  const rpc = async (method, params = {}) => {
    const response = await fetch(`${mcpUrl}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcSequence, method, params }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const getstatus = (input) => rpc('tools/call', { name: 'getstatus', arguments: input });
  try {
    const initialized = await rpc('initialize');
    assert.equal(initialized.result.serverInfo.name, 'mcp-getstatus-demo');
    const listed = await rpc('tools/list');
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['getstatus']);
    assert.deepEqual(listed.result.tools[0].inputSchema.required, ['id']);
    assert.equal(listed.result.tools[0].inputSchema.additionalProperties, false);
    assert.equal(api.demoState.records.size, 0);

    const first = (await getstatus({ id })).result;
    assert.equal(first.structuredContent.status, 'running');
    assert.equal(first.structuredContent.elapsed_ms, 0);
    assert.deepEqual(JSON.parse(first.content[0].text), first.structuredContent);
    currentTime += TWENTY_MINUTES_MS - 1;
    assert.equal((await getstatus({ id })).result.structuredContent.status, 'running');
    currentTime += 1;
    const final = (await getstatus({ id })).result;
    assert.equal(final.structuredContent.status, 'success');
    assert.equal(final.structuredContent.id, id);
    assert.equal(final.structuredContent.created_at_ms, first.structuredContent.created_at_ms);

    const evidence = await (await fetch(`${mcpUrl}/evidence`)).json();
    assert.equal(evidence.apiUrl, apiUrl);
    assert.ok(evidence.instanceId);
    assert.ok(evidence.hostname);
    assert.equal(evidence.pid, process.pid);
    assert.equal(evidence.calls.length, 3);
    assert.equal(api.demoState.records.size, 1);
    assert.equal(api.demoState.observations.length, evidence.calls.length);
    evidence.calls.forEach((call, index) => {
      assert.equal(call.toolName, 'getstatus');
      assert.deepEqual(call.input, { id });
      assert.equal(call.durationMs, 0);
      const { firstSeen: _firstSeen, ...observation } = api.demoState.observations[index];
      assert.deepEqual(call.output, observation);
      assert.equal(call.startedAtMs, observation.observed_at_ms);
      assert.equal(call.completedAtMs, observation.observed_at_ms);
    });
  } finally {
    await Promise.all([close(mcp), close(api)]);
  }
});

test('invalid IDs and obsolete tool names cannot silently create new remote records', async () => {
  const api = createMcpGetstatusDemoApiServer();
  const apiUrl = await listen(api);
  const mcp = createMcpGetstatusDemoMcpServer({ apiUrl });
  const mcpUrl = await listen(mcp);
  const call = async (name, args) => (await fetch(`${mcpUrl}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })).json();
  try {
    for (const path of ['/status', '/status?id=', '/status?id=%20', '/status?id=a&id=b']) {
      assert.equal((await fetch(`${apiUrl}${path}`)).status, 400);
    }
    for (const input of [undefined, {}, { id: 3 }, { id: '' }, { id: ' ' }, { id: 'x', task_id: 'y' }]) {
      const result = await call('getstatus', input);
      assert.equal(result.result.isError, true);
    }
    assert.equal((await call('execute_task', {})).error.code, -32601);
    assert.equal((await call('get_task_status', { task_id: 'x' })).error.code, -32601);
    assert.equal(api.demoState.records.size, 0);
    assert.equal(api.demoState.observations.length, 0);
    assert.equal(mcp.demoState.calls.length, 6);
    assert.ok(mcp.demoState.calls.every((entry) => entry.error && !entry.output));

    // Query encoding must preserve IDs, including characters with URL meaning.
    const id = 'caller/%+&?=id';
    const result = await call('getstatus', { id });
    assert.equal(result.result.structuredContent.id, id);
    assert.equal(result.result.structuredContent.status, 'running');
    assert.deepEqual([...api.demoState.records.keys()], [id]);
  } finally {
    await Promise.all([close(mcp), close(api)]);
  }
});
