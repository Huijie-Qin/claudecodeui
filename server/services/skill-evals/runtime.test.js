import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvaluationRuntime } from './runtime.js';

const budget = () => ({ costUsd: 0, calls: 0 });
test('SDK native executables launch directly with the isolated environment', async () => {
  const runtime = createEvaluationRuntime({ resolveEnvironment: () => ({ ANTHROPIC_API_KEY: 'test-key' }), runQuery: ({ options }) => (async function* () {
    const child = options.spawnClaudeCodeProcess({ command: '/bin/sh', args: ['-c', 'printf native-sdk-launch'], signal: options.abortController.signal });
    const completion = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
    });
    let output = '';
    for await (const chunk of child.stdout) output += chunk;
    await completion;
    assert.equal(output, 'native-sdk-launch');
    yield { type: 'result', subtype: 'success', result: output, total_cost_usd: 0.01 };
  })() });
  assert.equal((await runtime.modelCall({ scope: {}, prompt: 'Test', budget: budget() })).text, 'native-sdk-launch');
});
test('review model calls expose no native tools/settings and track reported usage', async () => {
  let observed;
  const runtime = createEvaluationRuntime({ resolveEnvironment: async () => ({ ANTHROPIC_API_KEY: 'test-key', PRIVATE_SETTING: 'never-inherit' }), runQuery: ({ options }) => {
    observed = options;
    return (async function* () { yield { type: 'result', subtype: 'success', result: 'OK', total_cost_usd: 0.01 }; })();
  } });
  const cost = budget();
  const result = await runtime.modelCall({ scope: {}, prompt: 'Test', systemPrompt: 'Test', budget: cost });
  assert.equal(result.text, 'OK'); assert.deepEqual(observed.tools, []); assert.deepEqual(observed.settingSources, []);
  assert.equal(observed.env.PRIVATE_SETTING, undefined); assert.equal(observed.env.ANTHROPIC_API_KEY, 'test-key');
  assert.equal((await observed.canUseTool('Bash', {})).behavior, 'deny'); assert.equal(cost.costUsd, 0.01);
});
test('sandbox collects artifacts from bounded tmpfs and always removes the container', async () => {
  const commands = [];
  const runtime = createEvaluationRuntime({ resolveEnvironment: async () => ({ ANTHROPIC_API_KEY: 'test-key' }), command: async (binary, args) => {
    commands.push({ binary, args });
    if (args[0] === 'top') return { stdout: 'PID COMMAND\n1 sleep', stderr: '' };
    if (args.includes('/usr/bin/python3')) return { stdout: '{"result.txt":"b2s="}', stderr: '' };
    return { stdout: '', stderr: '' };
  }, runQuery: ({ prompt, options }) => (async function* () {
    assert.equal(typeof prompt[Symbol.asyncIterator], 'function');
    assert.deepEqual(options.allowedTools, ['mcp__evaluation__shell', 'mcp__evaluation__delegate']);
    for await (const value of prompt) assert.equal(value.message.content, 'Generate result');
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } };
    yield { type: 'result', subtype: 'success', result: 'Done', total_cost_usd: 0.01 };
  })() });
  const result = await runtime.runCase({ scope: { id: 'job' }, files: { 'SKILL.md': Buffer.from('Instructions').toString('base64') }, testCase: { prompt: 'Generate result', files: [] }, budget: budget(), runtimeProfile: { model: 'test', image: 'image' } });
  assert.equal(result.artifacts['result.txt'], 'b2s=');
  const args = commands.find((call) => call.args[0] === 'run').args;
  assert.ok(args.includes('--tmpfs=/output:rw,nosuid,nodev,size=50m,mode=1777'));
  assert.ok(!args.includes('--network=none'));
  assert.ok(args.includes('host.docker.internal:host-gateway'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.some(value => value.endsWith(',dst=/skill,readonly')));
  assert.equal(args.filter((value) => value.startsWith('type=bind')).length, 3);
  assert.ok(commands.some((call) => call.args[0] === 'rm'));
});
test('missing runtime configuration fails before any execution', async () => {
  const runtime = createEvaluationRuntime({ image: '', resolveEnvironment: () => ({}) });
  await assert.rejects(runtime.preflight({}), (e) => e.code === 'EVAL_RUNTIME_UNAVAILABLE');
});

test('evaluations omit the SDK cost limit and ignore exhausted legacy budgets', async () => {
  const runtime = createEvaluationRuntime({ resolveEnvironment: () => ({ ANTHROPIC_API_KEY: 'test-key' }), runQuery: ({ options }) => {
    assert.equal(Object.hasOwn(options, 'maxBudgetUsd'), false);
    assert.equal(options.maxTurns, 24);
    return (async function* () { yield { type: 'result', subtype: 'success', result: 'OK', total_cost_usd: 12 }; })();
  } });
  const usage = { remainingUsd: 0, costUsd: 0, calls: 0 };
  for (let i = 0; i < 2; i++) {
    assert.equal((await runtime.modelCall({ scope: {}, prompt: 'Test', budget: usage })).text, 'OK');
  }
  assert.equal(usage.costUsd, 24);
  assert.equal(usage.calls, 2);
});

test('unavailable cost statistics do not interrupt successful evaluations', async () => {
  for (const cost of [undefined, null, 'unknown', NaN, Infinity, -1]) {
    const usage = { costUsd: 0, calls: 0 };
    const runtime = createEvaluationRuntime({ resolveEnvironment: () => ({ ANTHROPIC_API_KEY: 'test-key' }), runQuery: () =>
      (async function* () { yield { type: 'result', subtype: 'success', result: 'OK', total_cost_usd: cost }; })(),
    });
    assert.equal((await runtime.modelCall({ scope: {}, prompt: 'Test', budget: usage })).text, 'OK');
    assert.equal(usage.costUsd, 0);
    assert.equal(usage.costIncomplete, true);
  }
});

test('model-call count remains enforced without a cost limit', async () => {
  const runtime = createEvaluationRuntime({ runQuery: () => assert.fail('No model should run') });
  await assert.rejects(runtime.modelCall({ scope: {}, prompt: 'Test', budget: { costUsd: 0, calls: 1500 } }), { code: 'EVAL_LIMIT_EXCEEDED' });

});
