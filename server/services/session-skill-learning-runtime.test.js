import assert from 'node:assert/strict';
import test from 'node:test';

import { completeSessionSkillText } from './session-skill-learning-runtime.js';

const input = {
  workspacePath: '/tmp/skill-workspace',
  tenantId: 2,
  userId: 3,
  workspaceId: 4,
  phase: 'evaluate',
  systemPrompt: 'Evaluate only the explicit input.',
  prompt: 'Explicit task data.',
};

function fixture(messages) {
  const observed = { idle: [], failed: [] };
  const dependencies = {
    runtimeManager: {
      prepareClaudeRuntime: async (options) => {
        observed.prepare = options;
        return {
          runtimeId: 'isolated-runtime',
          cwd: '/tmp/runtime-workspace',
          projectPath: '/workspace',
          executionEnv: { MODEL_TEST_CONFIG: 'configured' },
          pathToClaudeCodeExecutable: '/runtime/claude',
        };
      },
      markIdle: (id) => observed.idle.push(id),
      markFailed: (id) => observed.failed.push(id),
    },
    mapOptions: (options) => {
      observed.mapped = options;
      return { ...options, resume: 'old-session', continue: true, sessionStore: {}, settings: '/workspace/.claude/settings.json' };
    },
    runQuery: async function* ({ prompt, options }) {
      observed.prompt = prompt;
      observed.options = options;
      for (const message of messages) yield message;
    },
  };
  return { dependencies, observed };
}

test('text phases preserve the caller runtime identity and exclude sessions, tools, and implicit context', async () => {
  const { dependencies, observed } = fixture([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Draft.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: '  Final answer.\n' },
  ]);
  assert.equal(await completeSessionSkillText(input, dependencies), 'Final answer.');
  assert.deepEqual(observed.prepare, {
    tenantId: 2, userId: 3, workspaceId: 4,
    cwd: input.workspacePath, projectPath: input.workspacePath,
  });
  assert.equal(observed.mapped.cwd, '/tmp/runtime-workspace');
  assert.equal(observed.mapped.projectPath, '/workspace');
  assert.deepEqual(observed.mapped.executionEnv, { MODEL_TEST_CONFIG: 'configured' });
  assert.deepEqual(observed.mapped.settingSources, []);
  assert.equal(observed.prompt, input.prompt);
  const options = observed.options;
  assert.equal(options.systemPrompt, input.systemPrompt);
  assert.equal(options.persistSession, false);
  assert.equal(options.maxTurns, 1);
  assert.equal(options.includePartialMessages, false);
  for (const name of ['resume', 'continue', 'sessionId', 'resumeSessionAt', 'forkSession', 'sessionStore']) {
    assert.equal(options[name], undefined);
  }
  for (const name of ['tools', 'allowedTools', 'skills', 'plugins', 'additionalDirectories', 'settingSources']) {
    assert.deepEqual(options[name], []);
  }
  for (const name of ['mcpServers', 'agents', 'hooks']) assert.deepEqual(options[name], {});
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.settings, { autoMemoryEnabled: false, disableAllHooks: true, claudeMdExcludes: ['**'] });
  assert.equal((await options.canUseTool('Read', {})).behavior, 'deny');
  assert.deepEqual(observed.idle, ['isolated-runtime']);
  assert.deepEqual(observed.failed, []);
});

test('successful terminal results may use assistant text when result text is absent', async () => {
  const { dependencies } = fixture([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Answer' }] } },
    { type: 'result', subtype: 'success' },
  ]);
  assert.equal(await completeSessionSkillText(input, dependencies), 'Answer');
});

test('model failures, truncated responses, and empty responses never become successful outputs', async (t) => {
  const cases = [
    { messages: [{ type: 'result', is_error: true, result: 'Failed.' }], code: 'SESSION_SKILL_MODEL_FAILED' },
    { messages: [{ type: 'result', subtype: 'error_max_turns', result: 'Partial.' }], code: 'SESSION_SKILL_MODEL_FAILED' },
    { messages: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Incomplete' }] } }], code: 'SESSION_SKILL_INCOMPLETE_RESPONSE' },
    { messages: [{ type: 'result', subtype: 'success', result: ' ' }], code: 'SESSION_SKILL_EMPTY_RESPONSE' },
    { messages: [{ type: 'result', subtype: 'success', result: 'x'.repeat(120_001) }], code: 'SESSION_SKILL_RESPONSE_TOO_LARGE' },
  ];
  for (const { messages, code } of cases) {
    await t.test(code, async () => {
      const { dependencies, observed } = fixture(messages);
      await assert.rejects(completeSessionSkillText(input, dependencies), { code, statusCode: 502 });
      assert.deepEqual(observed.idle, []);
      assert.deepEqual(observed.failed, ['isolated-runtime']);
    });
  }
});

test('authentication failures are explicit and never replaced with a fabricated skill', async () => {
  const { dependencies } = fixture([{ type: 'result', is_error: true, errors: ['Authentication_error: invalid API key secret-value'] }]);
  await assert.rejects(completeSessionSkillText(input, dependencies), (error) => {
    assert.equal(error.code, 'SESSION_SKILL_AUTH_REQUIRED');
    assert.equal(error.statusCode, 401);
    assert.doesNotMatch(error.message, /secret-value/);
    return true;
  });
});

test('timeout aborts an outstanding query and marks its runtime failed', async () => {
  const { dependencies, observed } = fixture([]);
  let closed = false;
  let signal;
  dependencies.timeoutMs = 15;
  dependencies.runQuery = ({ options }) => {
    signal = options.abortController.signal;
    return {
      close: () => { closed = true; },
      async *[Symbol.asyncIterator]() {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      },
    };
  };
  await assert.rejects(completeSessionSkillText(input, dependencies), { code: 'SESSION_SKILL_MODEL_TIMEOUT', statusCode: 504 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.equal(closed, true);
  assert.deepEqual(observed.failed, ['isolated-runtime']);
});

test('a runtime prepared after timeout is released without making a model call', async () => {
  const { dependencies, observed } = fixture([]);
  let finishPrepare;
  dependencies.timeoutMs = 10;
  dependencies.runtimeManager.prepareClaudeRuntime = () => new Promise((resolve) => { finishPrepare = resolve; });
  await assert.rejects(completeSessionSkillText(input, dependencies), { code: 'SESSION_SKILL_MODEL_TIMEOUT' });
  finishPrepare({ runtimeId: 'late-runtime' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed.options, undefined);
  assert.deepEqual(observed.failed, ['late-runtime']);
});

test('job cancellation aborts the model query and removes the caller listener', async () => {
  const { dependencies, observed } = fixture([]);
  const controller = new AbortController();
  let removed = false;
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.removeEventListener = (...args) => { removed = true; return remove(...args); };
  dependencies.runQuery = async function* ({ options }) {
    await new Promise((_, reject) => {
      options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      controller.abort();
    });
  };
  await assert.rejects(completeSessionSkillText({ ...input, signal: controller.signal }, dependencies), { code: 'SESSION_SKILL_CANCELLED', statusCode: 409 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(removed, true);
  assert.deepEqual(observed.failed, ['isolated-runtime']);
});

test('already cancelled jobs never prepare a runtime', async () => {
  const { dependencies, observed } = fixture([]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(completeSessionSkillText({ ...input, signal: controller.signal }, dependencies), { code: 'SESSION_SKILL_CANCELLED' });
  assert.equal(observed.prepare, undefined);
});
