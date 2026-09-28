import assert from 'node:assert/strict';
import test from 'node:test';

import { createSandboxImageManager } from './sandbox-image.js';
import { createEvaluationRuntime } from './runtime.js';

const missing = () => Object.assign(new Error('inspect failed'), { stderr: 'Error response from daemon: No such image: test:local' });
const identity = 'sha256:test-image';
const auth = () => ({ ANTHROPIC_API_KEY: 'test-key' });

test('existing images are reused without a build and preflight pins the inspected image ID', async () => {
  const calls = [];
  const runtime = createEvaluationRuntime({ resolveEnvironment: auth, autoBuild: true, command: async (_docker, args) => {
    calls.push(args); return { stdout: args[0] === 'info' ? 'Docker' : identity };
  } });
  await runtime.warmup();
  assert.equal((await runtime.preflight({})).image, identity);
  assert.ok(calls.every(args => args[0] !== 'build'));
  assert.equal(calls.find(args => args[0] === 'image').at(-1), process.env.SKILL_EVAL_IMAGE || 'cloudcli-skill-eval:local');
});

test('missing images are built once from the bundled Dockerfile for concurrent preparation', async () => {
  let exists = false; const calls = [];
  const manager = createSandboxImageManager({ docker: '/usr/bin/docker', image: 'test:local', autoBuild: true,
    command: async (docker, args, options) => {
      assert.equal(docker, '/usr/bin/docker'); calls.push(args);
      if (args[0] === 'build') {
        assert.match(args.at(-1), /examples\/skill-evaluations$/);
        assert.match(args.at(-2), /examples\/skill-evaluations\/Dockerfile$/);
        assert.equal(options.timeout, 600000); exists = true;
      }
      if (args[0] === 'image' && !exists) throw missing();
      return { stdout: identity };
    },
  });
  const first = manager.ensure(); assert.equal(manager.preparing, true);
  assert.equal(manager.ensure(), first);
  assert.equal(await first, identity); assert.equal(manager.preparing, false);
  assert.equal(await manager.ensure(), identity);
  assert.equal(calls.filter(args => args[0] === 'build').length, 1);
});

test('disabled automatic build and inaccessible Docker never start a build', async () => {
  for (const failure of ['image-missing', 'daemon', 'inspect-permission']) {
    const calls = [];
    const manager = createSandboxImageManager({ docker: 'docker', image: 'test:local', autoBuild: failure !== 'image-missing', command: async (_docker, args) => {
      calls.push(args);
      if (args[0] === 'info' && failure === 'daemon') throw new Error('Connection refused');
      if (args[0] === 'image') throw failure === 'image-missing' ? missing() : new Error('Permission denied');
      return { stdout: 'Docker' };
    } });
    await assert.rejects(manager.ensure(), failure === 'image-missing' ? /SKILL_EVAL_AUTO_BUILD/ : /Docker/);
    assert.ok(calls.every(args => args[0] !== 'build')); assert.equal(manager.preparing, false);
  }
});

test('a failed build can be retried and does not retain a rejected preparation promise', async () => {
  let attempts = 0, exists = false;
  const manager = createSandboxImageManager({ docker: 'docker', image: 'test:local', autoBuild: true, command: async (_docker, args) => {
    if (args[0] === 'image' && !exists) throw missing();
    if (args[0] === 'build') { if (++attempts === 1) throw new Error('Network unavailable'); exists = true; }
    return { stdout: identity };
  } });
  await assert.rejects(manager.ensure(), /自动构建失败/);
  assert.equal(await manager.ensure(), identity); assert.equal(attempts, 2);
});

test('requests during startup preparation return a bounded preparing response without another build', async () => {
  let release, exists = false, builds = 0;
  const runtime = createEvaluationRuntime({ resolveEnvironment: auth, image: 'test:local', autoBuild: true, command: async (_docker, args) => {
    if (args[0] === 'image' && !exists) throw missing();
    if (args[0] === 'build') { builds++; await new Promise(resolve => { release = resolve; }); exists = true; }
    return { stdout: identity };
  } });
  const warmup = runtime.warmup();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(runtime.preflight({}), { code: 'EVAL_RUNTIME_PREPARING' });
  release(); await warmup;
  assert.equal((await runtime.preflight({})).image, identity); assert.equal(builds, 1);
});

test('automatic preparation is opt-in and does not affect ordinary application startup', async () => {
  const runtime = createEvaluationRuntime({ autoBuild: false, command: () => assert.fail('Docker must not be called') });
  await runtime.warmup();
});
