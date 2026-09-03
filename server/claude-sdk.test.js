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

test('configured Hooks are not registered for an internal Hook follow-up turn', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  assert.equal(claudeSdk.resolveConfiguredHookUserId({ userId: 42 }, 7), 42);
  assert.equal(claudeSdk.resolveConfiguredHookUserId({}, 7), 7);
  assert.equal(claudeSdk.resolveConfiguredHookUserId({
    userId: 42,
    hookRecovery: { hookId: 'normal-end-notification', executionId: 'execution-1' },
  }, 7), null);
});

test('Hook execution cards omit mcp loop scheduling metadata from action results', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const results = claudeSdk.createHookCardActionResults({
    postActions: [
      { id: 'call-status', type: 'call_mcp_tool' },
      { id: 'wait-status', type: 'mcp_loop_run' },
      { id: 'audit', type: 'write_record' },
    ],
  }, {
    'call-status': { output: { status: 'running' } },
    'wait-status': { output: { scheduled: true, jobId: 'loop-1', status: 'running' } },
    audit: { output: { recorded: true, id: 'record-1', data: { status: 'success' } } },
  });

  assert.deepEqual(results.map((result) => result.actionId), ['call-status', 'audit']);
  assert.equal(results.some((result) => result.actionType === 'mcp_loop_run'), false);
});

test('Docker Hook headersHelper receives the same per-exec USER_KEY as Claude', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const calls = [];
  const userKey = 'A'.repeat(64);
  const runner = claudeSdk.createHookHeadersHelperRunner({
    mode: 'docker',
    containerName: 'claude-runtime-1',
    containerCwd: '/workspace',
    hookCommandEnv: {
      USER_KEY: userKey,
      TENANT_ID: '3',
    },
  }, {}, {
    execFileImpl: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return { stdout: '{"Authorization":"ok"}\n', stderr: '' };
    },
  });

  await runner({
    command: 'python3 proxy_auth.py',
    env: { CLAUDE_CODE_MCP_SERVER_NAME: 'private-mcp' },
    timeoutMs: 10_000,
  });

  assert.ok(calls[0].args.includes(`USER_KEY=${userKey}`));
  assert.ok(calls[0].args.includes('TENANT_ID=3'));
  assert.ok(calls[0].args.includes('CLAUDE_CODE_MCP_SERVER_NAME=private-mcp'));
  assert.deepEqual(calls[0].args.slice(-3), ['/bin/sh', '-lc', 'python3 proxy_auth.py']);
});

test('Docker Hook headersHelper errors never retain USER_KEY or the docker command', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const userKey = 'B'.repeat(64);
  const runner = claudeSdk.createHookHeadersHelperRunner({
    mode: 'docker',
    containerName: 'claude-runtime-1',
    hookCommandEnv: { USER_KEY: userKey },
  }, {}, {
    execFileImpl: async () => {
      const error = new Error(`Command failed: docker exec --env USER_KEY=${userKey}`);
      error.code = 1;
      error.stderr = `auth_key=${userKey} is invalid`;
      throw error;
    },
  });

  await assert.rejects(
    runner({ command: 'python3 proxy_auth.py', timeoutMs: 10_000 }),
    (error) => {
      assert.equal(error.code, 'MCP_HEADERS_HELPER_COMMAND_FAILED');
      assert.equal(error.message.includes(userKey), false);
      assert.equal(error.message.includes('docker exec'), false);
      assert.match(error.message, /\[REDACTED:USER_KEY\]/);
      return true;
    },
  );
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

test('interactive stream timeout cannot expire before the tool approval timeout', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  assert.equal(
    claudeSdk.resolveInteractiveStreamCloseTimeoutMs({
      CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '5000',
    }, 10_000),
    70_000,
  );
  assert.equal(
    claudeSdk.resolveInteractiveStreamCloseTimeoutMs({
      CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '120000',
    }, 10_000),
    120_000,
  );
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

test('Claude turn completion waits for authoritative idle when session-state events are available', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const lifecycle = claudeSdk.createClaudeTurnLifecycleTracker();

  assert.equal(lifecycle.observe({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'running',
  }), 'processing');
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
  }), null);

  // Parent output may still arrive here; it must not be cut off by an early
  // main-turn completion after the child settles.
  assert.equal(lifecycle.observe({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', delta: { text: 'final parent output' } },
  }), null);
  assert.equal(lifecycle.observe({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'idle',
  }), 'complete');
  assert.equal(lifecycle.flush(), false);
});

test('parent idle does not erase or complete active background agents', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const lifecycle = claudeSdk.createClaudeTurnLifecycleTracker();

  lifecycle.observe({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'running',
  });
  lifecycle.observe({
    type: 'system',
    subtype: 'task_started',
    task_id: 'agent-background',
    tool_use_id: 'toolu_agent_background',
  });
  assert.equal(lifecycle.finishResult(0), false);

  assert.equal(lifecycle.observe({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'idle',
  }), null);
  assert.deepEqual(lifecycle.getActiveTasks().map((task) => task.taskId), ['agent-background']);

  assert.equal(lifecycle.observe({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'agent-background',
    status: 'completed',
  }), null);
  assert.deepEqual(lifecycle.getActiveTasks(), []);

  assert.equal(lifecycle.observe({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'idle',
  }), 'complete');
});

test('background activity after parent idle requires a fresh idle boundary', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const lifecycle = claudeSdk.createClaudeTurnLifecycleTracker();

  lifecycle.observe({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  lifecycle.observe({ type: 'system', subtype: 'task_started', task_id: 'agent-background' });
  assert.equal(lifecycle.finishResult(0), false);
  assert.equal(lifecycle.observe({
    type: 'system', subtype: 'session_state_changed', state: 'idle',
  }), null);
  assert.equal(lifecycle.observe({
    type: 'system', subtype: 'task_progress', task_id: 'agent-background', summary: 'Still working',
  }), 'processing');
  assert.equal(lifecycle.observe({
    type: 'system', subtype: 'task_notification', task_id: 'agent-background', status: 'completed',
  }), null);
  assert.equal(lifecycle.observe({
    type: 'system', subtype: 'session_state_changed', state: 'idle',
  }), 'complete');
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

test('Claude turn completion waits for AskUserQuestion responses before closing the stream', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const interactions = claudeSdk.createPendingInteractionTracker();
  const lifecycle = claudeSdk.createClaudeTurnLifecycleTracker();
  lifecycle.finishResult(0);
  const completion = { sessionId: 'session-1' };

  interactions.begin('ask-user-question-1');
  assert.equal(claudeSdk.shouldEmitClaudeTurnCompletion(completion, interactions, lifecycle), false);

  interactions.end('ask-user-question-1');
  assert.equal(claudeSdk.shouldEmitClaudeTurnCompletion(completion, interactions, lifecycle), true);
});

test('result plus a quiet stream cannot close the turn while background agents are running', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const { completeClaudeTurnBoundary } = await import('./services/claude-turn-boundary.js');
  const lifecycle = claudeSdk.createClaudeTurnLifecycleTracker();
  const interactions = claudeSdk.createPendingInteractionTracker();
  const events = [];
  const timers = [];
  let pendingCompletion = null;
  const session = {
    status: 'processing',
    inputQueue: { close: () => events.push('input-closed') },
    instance: { close: () => events.push('query-closed') },
    queuedTurns: [{ content: 'Next turn' }],
  };
  const scheduler = claudeSdk.createClaudeTurnCompletionScheduler({
    canComplete: () => claudeSdk.shouldEmitClaudeTurnCompletion(pendingCompletion, interactions, lifecycle),
    onComplete: () => {
      completeClaudeTurnBoundary(session);
      events.push('complete');
      pendingCompletion = null;
    },
    setTimeoutFn: (callback) => {
      const timer = { callback, cancelled: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => { timer.cancelled = true; },
  });
  const observe = (message) => {
    scheduler.cancel();
    lifecycle.observe(message);
    // The real stream loop retries scheduling after EVERY event, not just idle.
    scheduler.schedule();
  };

  observe({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  for (const taskId of ['child-a', 'child-b']) {
    observe({ type: 'system', subtype: 'task_started', task_id: taskId });
  }
  pendingCompletion = { sessionId: 'session-1' };
  assert.equal(lifecycle.finishResult(0), false);
  scheduler.schedule();
  assert.equal(timers.length, 0, 'a pending result is not permission to arm completion');

  observe({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  observe({ type: 'system', subtype: 'task_notification', task_id: 'child-a', status: 'completed' });
  observe({ type: 'assistant', message: { content: 'Parent is still waiting.' } });
  assert.equal(timers.length, 0);
  assert.equal(session.status, 'processing');
  assert.equal(session.queuedTurns.length, 1);
  assert.deepEqual(events, []);

  observe({ type: 'system', subtype: 'task_notification', task_id: 'child-b', status: 'completed' });
  observe({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  events.push('parent-final-text');
  observe({ type: 'assistant', message: { content: 'Final parent summary.' } });
  assert.equal(timers.length, 0, 'parent output must finish before completion is armed');
  observe({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  assert.equal(scheduler.isScheduled(), true);
  timers.at(-1).callback();
  assert.deepEqual(events, ['parent-final-text', 'input-closed', 'query-closed', 'complete']);
  assert.equal(session.queuedTurns.length, 0);
});

test('completion timer rechecks readiness after parent, child, permission, or turn state changes', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const changes = [
    (lifecycle) => lifecycle.observe({ type: 'system', subtype: 'task_started', task_id: 'late-child' }),
    (lifecycle) => lifecycle.observe({ type: 'system', subtype: 'session_state_changed', state: 'running' }),
    (_lifecycle, interactions) => interactions.begin('ask-user-question'),
    (lifecycle) => lifecycle.beginTurn(),
    (lifecycle) => lifecycle.finishResult(1),
    (lifecycle) => lifecycle.stopAll(),
  ];
  for (const change of changes) {
    const lifecycle = claudeSdk.createClaudeTurnLifecycleTracker();
    const interactions = claudeSdk.createPendingInteractionTracker();
    lifecycle.observe({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
    assert.equal(lifecycle.finishResult(0), true);
    let fire;
    let closed = false;
    const scheduler = claudeSdk.createClaudeTurnCompletionScheduler({
      canComplete: () => claudeSdk.shouldEmitClaudeTurnCompletion({ sessionId: 'session-1' }, interactions, lifecycle),
      onComplete: () => { closed = true; },
      setTimeoutFn: (callback) => { fire = callback; return { unref() {} }; },
      clearTimeoutFn: () => {},
    });
    assert.equal(scheduler.schedule(), true);
    change(lifecycle, interactions);
    fire();
    assert.equal(closed, false);
    assert.equal(scheduler.schedule(), false);
  }
});

test('stream exhaustion cannot flush a result with unfinished background agents', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const lifecycle = claudeSdk.createClaudeTurnLifecycleTracker();
  lifecycle.observe({ type: 'system', subtype: 'task_started', task_id: 'child' });
  assert.equal(lifecycle.finishResult(0), false);
  assert.equal(lifecycle.flush(), false);
  assert.equal(lifecycle.canComplete(), false);
  assert.equal(lifecycle.getActiveTasks().length, 1);

  const parentOnly = claudeSdk.createClaudeTurnLifecycleTracker();
  parentOnly.observe({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  assert.equal(parentOnly.finishResult(0), false);
  assert.equal(parentOnly.flush(), true);
  assert.equal(parentOnly.canComplete(), true);
});

test('Claude turn completion grace restarts when trailing parent output arrives', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  let completed = 0;
  const timers = [];
  const scheduler = claudeSdk.createClaudeTurnCompletionScheduler({
    delayMs: 500,
    onComplete: () => {
      completed++;
    },
    setTimeoutFn: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      timer.cancelled = true;
    },
  });

  scheduler.schedule();
  scheduler.schedule();

  assert.equal(timers.length, 2);
  assert.equal(timers[0].cancelled, true);
  assert.equal(timers[1].cancelled, false);
  assert.equal(completed, 0);
  assert.equal(scheduler.isScheduled(), true);

  timers[1].callback();
  assert.equal(completed, 1);
  assert.equal(scheduler.isScheduled(), false);
});

test('Claude lifecycle tracker exposes active subagents for manual stop', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const lifecycle = claudeSdk.createClaudeTurnLifecycleTracker();

  lifecycle.observe({
    type: 'system',
    subtype: 'task_started',
    task_id: 'agent-a',
    tool_use_id: 'toolu_agent_a',
    description: 'Review API',
  });
  lifecycle.observe({
    type: 'system',
    subtype: 'task_started',
    task_id: 'agent-b',
    tool_use_id: 'toolu_agent_b',
    description: 'Review UI',
  });
  lifecycle.observe({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'agent-a',
    status: 'completed',
  });

  assert.deepEqual(lifecycle.getActiveTasks(), [{
    taskId: 'agent-b',
    toolUseId: 'toolu_agent_b',
    description: 'Review UI',
  }]);
  assert.deepEqual(lifecycle.stopAll().map((task) => task.taskId), ['agent-b']);
  assert.deepEqual(lifecycle.getActiveTasks(), []);
});

test('manual session stop requests every active subagent to stop and emits stopped state', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const stoppedTaskIds = [];
  const sent = [];
  const lifecycle = claudeSdk.createClaudeTurnLifecycleTracker();
  for (const [taskId, toolUseId] of [['agent-a', 'toolu_agent_a'], ['agent-b', 'toolu_agent_b']]) {
    lifecycle.observe({
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
      tool_use_id: toolUseId,
      description: `Run ${taskId}`,
    });
  }

  const messages = await claudeSdk.stopActiveClaudeSubagentTasks('session-1', {
    instance: {
      stopTask: async (taskId) => stoppedTaskIds.push(taskId),
    },
    turnLifecycle: lifecycle,
    writer: { send: (message) => sent.push(message) },
    runtimeOptions: {},
    runtimeId: null,
  }, { timeoutMs: 100 });

  assert.deepEqual(stoppedTaskIds, ['agent-a', 'agent-b']);
  assert.deepEqual(messages.map((message) => ({
    taskId: message.taskId,
    toolUseId: message.toolUseId,
    status: message.status,
    syntheticSubagentStop: message.syntheticSubagentStop,
  })), [
    { taskId: 'agent-a', toolUseId: 'toolu_agent_a', status: 'stopped', syntheticSubagentStop: true },
    { taskId: 'agent-b', toolUseId: 'toolu_agent_b', status: 'stopped', syntheticSubagentStop: true },
  ]);
  assert.deepEqual(sent, messages);
  assert.deepEqual(lifecycle.getActiveTasks(), []);
});

test('mapCliOptionsToSDK loads project CLAUDE.md natively without prompt duplication', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  const options = claudeSdk.mapCliOptionsToSDK({
    executionEnv: {},
    settingSources: ['project', 'user', 'local'],
  });

  assert.equal(options.systemPrompt.type, 'preset');
  assert.equal(options.systemPrompt.preset, 'claude_code');
  assert.equal(options.systemPrompt.append, undefined);
  assert.deepEqual(options.settingSources, ['project', 'user', 'local']);
});

test('mapCliOptionsToSDK ignores legacy agentInstructions to avoid duplicating CLAUDE.md memory', async () => {
  const claudeSdk = await import('./claude-sdk.js');

  const options = claudeSdk.mapCliOptionsToSDK({ executionEnv: {}, agentInstructions: '# Legacy Agent' });

  assert.equal(options.systemPrompt.append, undefined);
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

test('buildClaudeUserMessage preserves native multiline skill invocations exactly', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const invocation = '/report-skill\n第一行\n第二行\n\n```json\n{"sentinel":"FINAL_LINE"}\n```';

  const message = claudeSdk.buildClaudeUserMessage(invocation, []);

  assert.equal(message.message.content, invocation);
});

test('resolveClaudeSupplementPayload validates without trimming native skill content', async () => {
  const claudeSdk = await import('./claude-sdk.js');
  const invocation = '/report-skill\n第一行\n第二行\n';

  const payload = claudeSdk.resolveClaudeSupplementPayload({
    sessionId: '  session-1  ',
    content: invocation,
  });

  assert.deepEqual(payload, {
    sessionId: 'session-1',
    content: invocation,
    displayContent: invocation,
    valid: true,
  });
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
