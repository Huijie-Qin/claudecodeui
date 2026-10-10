import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvaluationRuntime } from './runtime.js';
import { timeoutSetting } from './interruption.js';

const usage = () => ({ calls: 0, costUsd: 0 });
const execution = () => ({ workspace: '/tmp', mcpServers: {}, env: {}, access: { disallowedTools: [], isAllowed: () => true }, spawn: () => {} });

function sdkAbortFixture(overrides = {}) {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const runtime = createEvaluationRuntime({ env: {}, resolveEnvironment: () => ({ ANTHROPIC_API_KEY: 'test' }),
    runQuery: ({ options }) => {
      ready(options);
      const stream = (async function* () {
        await new Promise(resolve => options.abortController.signal.addEventListener('abort', resolve, { once: true }));
        throw new Error('Claude Code process aborted by user');
      })();
      // SDK cleanup must not replace the original abort reason either.
      stream.close = () => { throw new Error('SDK closed after abort'); };
      return stream;
    }, ...overrides });
  return { runtime, started };
}

test('case model runs past five minutes and reports the actual default timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runtime, started } = sdkAbortFixture();
  const pending = runtime.modelCall({ scope: {}, prompt: 'test', budget: usage(), execution: execution() });
  const rejected = assert.rejects(pending, error => error.code === 'EVAL_TIMEOUT' && /30 分钟/.test(error.message) && !/aborted by user/.test(error.message));
  const options = await started;
  t.mock.timers.tick(300000);
  assert.equal(options.abortController.signal.aborted, false);
  t.mock.timers.tick(1500000);
  await rejected;
});

test('review model timeout is independent and configurable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runtime, started } = sdkAbortFixture({ env: { SKILL_EVAL_MODEL_TIMEOUT_MS: '600000' } });
  const pending = runtime.modelCall({ scope: {}, prompt: 'test', budget: usage() });
  const rejected = assert.rejects(pending, error => error.code === 'EVAL_TIMEOUT' && /SKILL_EVAL_MODEL_TIMEOUT_MS/.test(error.message));
  const options = await started;
  t.mock.timers.tick(300000); assert.equal(options.abortController.signal.aborted, false);
  t.mock.timers.tick(300000); await rejected;
});

test('user cancellation, worker shutdown and tool limits preserve their own reasons', async () => {
  for (const code of ['EVAL_CANCELLED', 'EVAL_SERVER_STOP', 'EVAL_TOOL_ERROR']) {
    const controller = new AbortController();
    const { runtime, started } = sdkAbortFixture();
    const pending = runtime.modelCall({ scope: {}, prompt: 'test', budget: usage(), signal: controller.signal });
    const reason = Object.assign(new Error(`Original ${code}`), { code });
    const rejected = assert.rejects(pending, error => error === reason);
    await started; controller.abort(reason); await rejected;
  }
});

test('case timeout preserves evidence and cleans the container after SDK abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const { runtime, started } = sdkAbortFixture({ env: { SKILL_EVAL_CASE_TIMEOUT_MS: '600000', CLOUDCLI_DOCKER_SHARED_PYTHON: 'false' },
    command: async (_binary, args) => { calls.push(args); return { stdout: '', stderr: '' }; } });
  const pending = runtime.runCase({ scope: { id: 'timeout' }, files: { 'SKILL.md': 'eA==' }, testCase: { prompt: 'long task' },
    runtimeProfile: { image: 'test-image' }, budget: usage() });
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.code, 'EVAL_TIMEOUT');
    assert.match(error.message, /10 分钟/);
    assert.equal(error.evidence.events[0].text, 'long task');
    return true;
  });
  await started;
  t.mock.timers.tick(600000); await rejected;
  assert.ok(calls.some(args => args[0] === 'rm'));
});

test('invalid timeout configuration fails explicitly instead of silently reverting to five minutes', () => {
  assert.equal(timeoutSetting({}, 'TIMEOUT', 1800000), 1800000);
  assert.equal(timeoutSetting({ TIMEOUT: '900000' }, 'TIMEOUT', 1800000), 900000);
  for (const value of ['bad', '0', '-1', '1.5', 'Infinity', '3600001']) {
    assert.throws(() => timeoutSetting({ TIMEOUT: value }, 'TIMEOUT', 1800000), { code: 'EVAL_RUNTIME_CONFIGURATION' });
  }
});
