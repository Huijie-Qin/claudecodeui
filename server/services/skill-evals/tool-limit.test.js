import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createEvaluationRuntime } from './runtime.js';

const success = { type: 'result', subtype: 'success', result: 'Done', total_cost_usd: 0 };
const toolUse = (id, name = 'Read') => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const toolResult = id => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Done' }] } });

function fixture(runQuery, env = {}) {
  const commands = [], signals = [];
  const runtime = createEvaluationRuntime({ env: { CLOUDCLI_DOCKER_SHARED_PYTHON: 'false', ...env },
    resolveEnvironment: () => ({ ANTHROPIC_API_KEY: 'fixture-secret' }),
    command: async (_binary, args) => { commands.push(args); return { stdout: args.includes('/usr/bin/python3') ? '{}' : '', stderr: '' }; },
    runQuery: args => { signals.push(args.options.abortController.signal); return runQuery(args); },
  });
  const run = () => runtime.runCase({ scope: { id: 'tool-limit' }, files: { 'SKILL.md': 'eA==' }, testCase: { prompt: 'Do the task' },
    budget: { calls: 0, costUsd: 0 }, runtimeProfile: { image: 'fixture-image' } });
  return { run, commands, signals };
}

test('100 native/MCP calls succeed by default; results are free and each case gets a fresh allowance', async () => {
  const f = fixture(() => (async function* () {
    for (let i = 0; i < 100; i++) {
      yield toolUse(`call-${i}`, i % 2 ? 'Read' : 'mcp__reports__query');
      yield toolResult(`call-${i}`);
    }
    yield success;
  })());
  for (let i = 0; i < 2; i++) {
    const result = await f.run();
    assert.equal(result.complete, true);
    assert.equal(result.events.filter(event => event.kind === 'tool_use').length, 100);
    assert.equal(result.events.filter(event => event.kind === 'tool_result').length, 100);
  }
});

test('call 101 aborts the SDK, preserves evidence and cleans up the container', async () => {
  const f = fixture(() => (async function* () {
    for (let i = 0; i < 101; i++) yield toolUse(`call-${i}`);
    assert.fail('The model must not continue after the limit');
  })());
  await assert.rejects(f.run(), error => {
    assert.equal(error.code, 'EVAL_LIMIT_EXCEEDED');
    assert.match(error.message, /100 次.*SKILL_EVAL_MAX_TOOL_CALLS/);
    assert.equal(error.evidence.events.filter(event => event.kind === 'tool_use').length, 100);
    assert.equal(f.signals[0].aborted, true);
    assert.equal(f.signals[0].reason, error);
    return true;
  });
  assert.ok(f.commands.some(args => args[0] === 'rm' && args[1] === '-f'));
});

async function withBroker(options, action) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'eval-limit-test', version: '1.0.0' });
  const server = options.mcpServers.evaluation.instance;
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { return await action(client); }
  finally { await client.close(); await server.close(); }
}

for (const limit of [3, 4]) {
  test(`configured limit ${limit} is shared by native tools, shell and delegated tasks`, async () => {
    const f = fixture(({ options }) => (async function* () {
      const parent = options.allowedTools.includes('mcp__evaluation__delegate');
      if (parent) yield toolUse('native');
      await withBroker(options, async client => {
        await client.callTool({ name: 'shell', arguments: { command: 'echo ok' } });
        if (parent) await client.callTool({ name: 'delegate', arguments: { task: 'Run one command' } });
      });
      yield success;
    })(), { SKILL_EVAL_MAX_TOOL_CALLS: String(limit) });
    if (limit === 4) {
      const result = await f.run();
      assert.equal(result.complete, true);
      assert.equal(result.events.filter(event => event.kind === 'tool_use').length, 3);
      assert.equal(result.events.filter(event => event.kind === 'task_started').length, 1);
    } else {
      await assert.rejects(f.run(), error => error.code === 'EVAL_LIMIT_EXCEEDED' && /3 次/.test(error.message));
      assert.ok(f.signals.every(signal => signal.aborted));
    }
    assert.ok(f.commands.some(args => args[0] === 'rm'));
  });
}

test('empty tool limit uses the default and invalid values fail explicitly', () => {
  for (const value of [undefined, '', '  ', '1', '200']) {
    assert.doesNotThrow(() => createEvaluationRuntime({ env: { SKILL_EVAL_MAX_TOOL_CALLS: value } }));
  }
  for (const value of ['0', '-1', '1.5', 'bad', 'Infinity', '9007199254740992']) {
    assert.throws(() => createEvaluationRuntime({ env: { SKILL_EVAL_MAX_TOOL_CALLS: value } }),
      error => error.code === 'EVAL_RUNTIME_CONFIGURATION' && /SKILL_EVAL_MAX_TOOL_CALLS/.test(error.message));
  }
});
