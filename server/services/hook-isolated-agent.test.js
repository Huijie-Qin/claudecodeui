import assert from 'node:assert/strict';
import test from 'node:test';

import { runIsolatedHookAgent } from './hook-isolated-agent.js';

test('independent tasks perform tool work without resuming, persisting, or replaying parent lifecycle hooks', async () => {
  const logs = [];
  const guard = [{ hooks: [() => ({})] }];
  const permission = async () => ({ behavior: 'deny', message: 'test' });
  let captured;
  const output = await runIsolatedHookAgent({ prompt: 'Send a notification',
    sdkOptions: { resume: 'parent', sessionId: 'parent', forkSession: true, persistSession: true,
      settingSources: ['project'], hooks: { PreToolUse: guard, Stop: guard, PostToolUse: guard },
      permissionMode: 'default', canUseTool: permission, disallowedTools: ['Bash'],
      cwd: '/workspace', env: { TEST: 'yes', CLAUDECODE: '1' } },
    onLog: async (...entry) => logs.push(entry),
    queryFn: async function* (request) {
      captured = request;
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'send_notification' }] } };
      yield { type: 'user', message: { content: [{ type: 'tool_result', content: 'sent' }] } };
      yield { type: 'result', subtype: 'success', session_id: 'isolated', result: 'PRIVATE RESULT' };
    },
  });
  assert.equal(output.executed, true);
  assert.equal(output.result, 'PRIVATE RESULT');
  assert.equal(output.sessionId, 'isolated');
  for (const key of ['resume', 'sessionId', 'forkSession']) assert.equal(captured.options[key], undefined);
  assert.equal(captured.options.persistSession, false);
  assert.deepEqual(captured.options.settingSources, ['project']);
  assert.deepEqual(captured.options.hooks, { PreToolUse: guard });
  assert.equal(captured.options.canUseTool, permission);
  assert.deepEqual(captured.options.disallowedTools, ['Bash']);
  assert.equal(captured.options.env.CLAUDECODE, undefined);
  assert.equal(logs.length, 2);
});

test('independent query timeout aborts and closes the worker even when the iterator stalls', async () => {
  let closed = 0;
  let options;
  await assert.rejects(runIsolatedHookAgent({ prompt: 'task', timeoutMs: 20,
    queryFn: (request) => { options = request.options; return {
      [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), close: () => { closed++; },
    }; },
  }), /timed out/);
  assert.equal(options.abortController.signal.aborted, true);
  assert.equal(closed, 1);
});

test('aborted or unsuccessful isolated tasks cannot be recorded as successful work', async () => {
  const controller = new AbortController(); controller.abort(new Error('User stopped'));
  await assert.rejects(runIsolatedHookAgent({ signal: controller.signal }), /User stopped/);
  await assert.rejects(runIsolatedHookAgent({ prompt: 'task', queryFn: async function* () {
    yield { type: 'result', subtype: 'error_max_turns', is_error: true };
  } }), /task failed/);
});

test('stopping the parent cancels an already running independent task', async () => {
  const controller = new AbortController();
  let closed = 0;
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const running = runIsolatedHookAgent({ prompt: 'task', signal: controller.signal,
    queryFn: () => ({ [Symbol.asyncIterator]() { return this; },
      next: () => { ready(); return new Promise(() => {}); }, close: () => { closed++; } }),
  });
  await started;
  controller.abort(new Error('User stopped'));
  await assert.rejects(running, /User stopped/);
  assert.equal(closed, 1);
});
