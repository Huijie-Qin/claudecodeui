import assert from 'node:assert/strict';
import test from 'node:test';

const withEnv = (key, value, callback) => {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
};

test('resolveClaudeModel lets ANTHROPIC_MODEL override UI model aliases', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  assert.equal(typeof claudeSdk.resolveClaudeModel, 'function');
  withEnv('ANTHROPIC_MODEL', 'glm-5.1', () => {
    assert.equal(claudeSdk.resolveClaudeModel({ model: 'opus' }), 'glm-5.1');
  });
});

test('resolveClaudeModel falls back to the UI model when no environment override is configured', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  withEnv('ANTHROPIC_MODEL', undefined, () => {
    assert.equal(claudeSdk.resolveClaudeModel({ model: 'sonnet' }), 'sonnet');
  });
});

test('mapCliOptionsToSDK makes normal sessions fully authorized for subagent inheritance', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  for (const permissionMode of [undefined, 'default', 'acceptEdits', 'bypassPermissions']) {
    const options = claudeSdk.mapCliOptionsToSDK({
      permissionMode,
      executionEnv: {},
    });

    assert.equal(options.permissionMode, 'bypassPermissions');
    assert.equal(options.allowDangerouslySkipPermissions, true);
    assert.ok(options.disallowedTools.includes('WebSearch'));
    assert.ok(options.disallowedTools.includes('WebFetch'));
  }
});

test('mapCliOptionsToSDK preserves plan mode without enabling permission bypass', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  const options = claudeSdk.mapCliOptionsToSDK({
    permissionMode: 'plan',
    executionEnv: {},
  });

  assert.equal(options.permissionMode, 'plan');
  assert.equal(options.allowDangerouslySkipPermissions, undefined);
  assert.ok(options.allowedTools.includes('Read'));
  assert.ok(options.allowedTools.includes('Task'));
});

test('buildToolInteractionContext preserves subagent and tool identities for UI routing', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  assert.deepEqual(claudeSdk.buildToolInteractionContext({
    toolUseID: ' toolu_question_1 ',
    agentID: ' agent-1 ',
  }), {
    toolUseId: 'toolu_question_1',
    agentId: 'agent-1',
  });
  assert.equal(claudeSdk.buildToolInteractionContext({}), undefined);
});

test('Claude turn completion waits until an active background task is terminal', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const lifecycle = claudeSdk.createClaudeTurnLifecycleTracker();

  assert.equal(lifecycle.observe({
    type: 'system',
    subtype: 'task_started',
    task_id: 'agent-1',
  }), 'processing');
  assert.equal(lifecycle.finishResult(0), false);
  assert.equal(lifecycle.observe({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'agent-1',
    status: 'completed',
  }), 'complete');
  assert.equal(lifecycle.observe({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'idle',
  }), null);
  assert.equal(lifecycle.flush(), false);
});

test('Claude turn completion does not require idle after a task is already terminal', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const lifecycle = claudeSdk.createClaudeTurnLifecycleTracker();

  lifecycle.observe({
    type: 'system',
    subtype: 'task_started',
    task_id: 'agent-fast',
  });
  lifecycle.observe({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'agent-fast',
    status: 'completed',
  });

  assert.equal(lifecycle.finishResult(0), true);
  assert.equal(lifecycle.observe({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'idle',
  }), null);
});

test('Claude turn completion waits for every concurrent background task without requiring idle', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const lifecycle = claudeSdk.createClaudeTurnLifecycleTracker();

  for (const taskId of ['agent-a', 'agent-b']) {
    lifecycle.observe({
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
    });
  }

  assert.equal(lifecycle.finishResult(0), false);
  assert.equal(lifecycle.observe({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'agent-a',
    status: 'completed',
  }), null);
  assert.equal(lifecycle.observe({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'agent-b',
    status: 'completed',
  }), 'complete');
  assert.equal(lifecycle.flush(), false);
});

test('Claude turn completion handles concurrent tasks that finish before the result', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const lifecycle = claudeSdk.createClaudeTurnLifecycleTracker();

  for (const taskId of ['agent-a', 'agent-b']) {
    lifecycle.observe({
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
    });
  }
  for (const taskId of ['agent-a', 'agent-b']) {
    assert.equal(lifecycle.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      status: 'completed',
    }), null);
  }

  assert.equal(lifecycle.finishResult(0), true);
  assert.equal(lifecycle.observe({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'idle',
  }), null);
});

test('Claude turn completion accepts a terminal task update after the result', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const lifecycle = claudeSdk.createClaudeTurnLifecycleTracker();

  lifecycle.observe({
    type: 'system',
    subtype: 'task_started',
    task_id: 'agent-updated',
  });
  assert.equal(lifecycle.finishResult(0), false);
  assert.equal(lifecycle.observe({
    type: 'system',
    subtype: 'task_updated',
    task_id: 'agent-updated',
    patch: { status: 'completed' },
  }), 'complete');
});

test('Claude turn completion keeps the immediate fallback for SDKs without lifecycle events', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const lifecycle = claudeSdk.createClaudeTurnLifecycleTracker();

  assert.equal(lifecycle.finishResult(0), true);
  assert.equal(lifecycle.flush(), false);
});

test('a newly queued Claude turn supersedes completion waiting on an older idle event', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const lifecycle = claudeSdk.createClaudeTurnLifecycleTracker();

  lifecycle.observe({
    type: 'system',
    subtype: 'task_started',
    task_id: 'agent-1',
  });
  assert.equal(lifecycle.finishResult(0), false);

  lifecycle.beginTurn();
  assert.equal(lifecycle.observe({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'idle',
  }), null);
  assert.equal(lifecycle.flush(), false);
});

test('Claude stream timeout stays paused until all concurrent interactions finish', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const interactions = claudeSdk.createPendingInteractionTracker();

  interactions.begin('request-a');
  interactions.begin('request-b');
  assert.equal(interactions.isPaused(), true);

  interactions.end('request-a');
  assert.equal(interactions.isPaused(), true);

  interactions.end('request-b');
  assert.equal(interactions.isPaused(), false);
});

test('createClaudePromptFactory keeps text-only prompts as strings', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  const createPrompt = claudeSdk.createClaudePromptFactory('hello', []);

  assert.equal(createPrompt(), 'hello');
});

test('buildClaudeUserMessage keeps display metadata out of model content', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const expandedSkillContent = '# report-skill\n\nExpanded skill instructions.';

  const message = claudeSdk.buildClaudeUserMessage(expandedSkillContent, [], {
    uuid: '11111111-1111-4111-8111-111111111111',
  });

  assert.equal(message.uuid, '11111111-1111-4111-8111-111111111111');
  assert.equal(message.message.content, expandedSkillContent);
  assert.equal(message.message.content.includes('ccui-display-command'), false);
  assert.equal(message.message.content.includes('/report-skill'), false);
});

test('createClaudePromptFactory creates native image content blocks', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  const createPrompt = claudeSdk.createClaudePromptFactory('describe this', [
    {
      data: 'data:image/png;base64,aGVsbG8=',
      size: 5,
      mimeType: 'image/png',
    },
  ]);

  const iterator = createPrompt()[Symbol.asyncIterator]();
  const first = await iterator.next();
  const second = await iterator.next();

  assert.equal(second.done, true);
  assert.equal(first.value.type, 'user');
  assert.equal(first.value.parent_tool_use_id, null);
  assert.deepEqual(first.value.message, {
    role: 'user',
    content: [
      { type: 'text', text: 'describe this' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'aGVsbG8=',
        },
      },
    ],
  });
});

test('createClaudePromptFactory rejects unsupported image types', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  assert.throws(
    () => claudeSdk.createClaudePromptFactory('describe this', [
      {
        data: 'data:image/svg+xml;base64,PHN2Zy8+',
        size: 6,
        mimeType: 'image/svg+xml',
      },
    ]),
    /Unsupported image type image\/svg\+xml/,
  );
});
