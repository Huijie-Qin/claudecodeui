import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpLoopDemoMcpServer } from './mcp-loop-demo-mcp.mjs';
import {
  createMcpLoopDemoTaskServer,
  TWENTY_MINUTES_MS,
} from './mcp-loop-demo-task-service.mjs';

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
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('the task service stays running until exactly 20 minutes, with auditable success and failure timestamps', async () => {
  let currentTime = 1_800_000_000_000;
  let taskSequence = 0;
  const server = createMcpLoopDemoTaskServer({
    now: () => currentTime,
    createId: () => `task-${++taskSequence}`,
  });
  const url = await listen(server);
  try {
    const submit = async (shouldFail = false) => {
      const response = await fetch(`${url}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ should_fail: shouldFail }),
      });
      assert.equal(response.status, 202);
      return response.json();
    };
    const succeededTask = await submit();
    const failedTask = await submit(true);
    assert.equal(TWENTY_MINUTES_MS, 1_200_000);
    assert.equal(succeededTask.duration_ms, TWENTY_MINUTES_MS);
    assert.equal(succeededTask.status, 'running');
    assert.equal(succeededTask.elapsed_ms, 0);
    assert.equal(succeededTask.finished_at_ms, null);

    currentTime += TWENTY_MINUTES_MS - 1;
    const beforeDeadline = await (await fetch(`${url}/tasks/${succeededTask.task_id}`)).json();
    assert.equal(beforeDeadline.status, 'running');
    assert.equal(beforeDeadline.elapsed_ms, 1_199_999);
    assert.equal(beforeDeadline.finished_at_ms, null);

    currentTime += 1;
    const atDeadline = await (await fetch(`${url}/tasks/${succeededTask.task_id}`)).json();
    assert.equal(atDeadline.status, 'success');
    assert.equal(atDeadline.finished_at_ms - atDeadline.created_at_ms, TWENTY_MINUTES_MS);
    assert.equal(atDeadline.observed_at_ms, currentTime);
    const failedAtDeadline = await (await fetch(`${url}/tasks/${failedTask.task_id}`)).json();
    assert.equal(failedAtDeadline.status, 'failed');
    assert.equal(failedAtDeadline.elapsed_ms, TWENTY_MINUTES_MS);

    currentTime += 60_000;
    const afterDeadline = await (await fetch(`${url}/tasks/${succeededTask.task_id}`)).json();
    assert.equal(afterDeadline.status, 'success');
    assert.equal(afterDeadline.finished_at_ms, atDeadline.finished_at_ms);
    assert.equal(afterDeadline.elapsed_ms, TWENTY_MINUTES_MS + 60_000);
    assert.equal(server.demoState.observations.length, 6);
    assert.deepEqual(server.demoState.observations.at(-1), {
      operation: 'get_task_status',
      ...afterDeadline,
    });
    assert.equal(server.demoState.startedAtMs, succeededTask.created_at_ms);
    assert.ok(server.demoState.instanceId);
  } finally {
    await close(server);
  }
});

test('MCP exposes exactly execute_task/get_task_status and records submitted IDs, poll states and errors', async () => {
  // Only this fast contract test advances the injected clock. Browser E2E uses
  // the factories' default Date.now() clock and a real 1,200,000 ms duration.
  let currentTime = 1_800_000_000_000;
  let taskSequence = 0;
  const taskServer = createMcpLoopDemoTaskServer({
    now: () => currentTime,
    createId: () => `task-${++taskSequence}`,
  });
  const taskServiceUrl = await listen(taskServer);
  const mcpServer = createMcpLoopDemoMcpServer({ taskServiceUrl, now: () => currentTime });
  const mcpUrl = `${await listen(mcpServer)}/mcp`;
  let rpcSequence = 0;
  const rpc = async (method, params = {}) => {
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcSequence, method, params }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const call = (name, input = {}) => rpc('tools/call', { name, arguments: input });
  try {
    const listed = await rpc('tools/list');
    assert.deepEqual(listed.result.tools.map(({ name }) => name), ['execute_task', 'get_task_status']);

    const submitted = await call('execute_task');
    assert.equal(submitted.result.structuredContent.status, 'running');
    const taskId = submitted.result.structuredContent.task_id;
    const firstPoll = await call('get_task_status', { task_id: taskId });
    assert.equal(firstPoll.result.structuredContent.status, 'running');
    assert.deepEqual(JSON.parse(firstPoll.result.content[0].text), firstPoll.result.structuredContent);

    currentTime += TWENTY_MINUTES_MS;
    const finalPoll = await call('get_task_status', { task_id: taskId });
    assert.equal(finalPoll.result.structuredContent.status, 'success');
    assert.equal(finalPoll.result.structuredContent.elapsed_ms, TWENTY_MINUTES_MS);
    assert.equal(mcpServer.demoState.calls[2].startedAtMs - mcpServer.demoState.calls[0].startedAtMs, TWENTY_MINUTES_MS);
    assert.ok(mcpServer.demoState.calls.filter(({ toolName }) => toolName === 'get_task_status')
      .every(({ input }) => input.task_id === taskId));

    const failedTask = await call('execute_task', { should_fail: true });
    currentTime += TWENTY_MINUTES_MS;
    const failedPoll = await call('get_task_status', { task_id: failedTask.result.structuredContent.task_id });
    assert.equal(failedPoll.result.structuredContent.status, 'failed');

    const missingId = await call('get_task_status');
    assert.equal(missingId.result.isError, true);
    assert.equal(missingId.result.content[0].text, 'task_id is required');
    assert.equal(mcpServer.demoState.calls.at(-1).error, 'task_id is required');
    const unknownTask = await call('get_task_status', { task_id: 'missing-task' });
    assert.equal(unknownTask.result.isError, true);
    assert.equal(unknownTask.result.content[0].text, 'task_not_found');
    assert.equal(mcpServer.demoState.calls.at(-1).error, 'task_not_found');
    assert.equal(mcpServer.demoState.startedAtMs, taskServer.demoState.startedAtMs);
    assert.ok(mcpServer.demoState.instanceId);
    assert.doesNotThrow(() => JSON.stringify({
      calls: mcpServer.demoState.calls,
      observations: taskServer.demoState.observations,
    }));
  } finally {
    await Promise.all([close(mcpServer), close(taskServer)]);
  }
});
