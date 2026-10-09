import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import Database from 'better-sqlite3';

import { HOOK_CONFIG_SCHEMA_SQL } from '../database/hook-config-schema.js';

// SDK/runtime imports open the application DB. Pre-create an isolated file so
// migration cannot copy a developer's real database into this test fixture.
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-stop-boundary-'));
const previousDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = path.join(tempRoot, 'app.db');
await fs.writeFile(process.env.DATABASE_PATH, '');
const { createHookRuntimeSession } = await import('./hook-runtime.js');
const { ClaudeInputQueue, buildClaudeUserMessage } = await import('../claude-sdk.js');
const {
  captureClaudeStopHookBoundary,
  completeClaudeTurnBoundary,
  enqueueClaudeFollowupTurn,
} = await import('./claude-turn-boundary.js');
const { db } = await import('../database/db.js');
if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
else process.env.DATABASE_PATH = previousDatabasePath;
after(async () => {
  db.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

const stopEvent = (extra = {}) => ({
  hook_event_name: 'Stop', session_id: 'main-session',
  stop_hook_active: false, last_assistant_message: 'The normal answer is done.',
  ...extra,
});

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function makeHook(id = 'stop-hook', extra = {}) {
  return {
    id, name: id, version: 1, eventName: 'Stop', includeSubagents: false,
    extensionLogic: { language: 'javascript', code: 'fixture script' },
    postActions: [],
    claudeResponse: { bindings: {
      systemMessage: { source: 'template', template: 'Check {{ccui.env.hookInvocationCount}}' },
    } },
    ...extra,
  };
}

function skillAction() {
  return { id: 'skill', type: 'invoke_skill', config: {
    skillId: 'builtin:test', skillName: 'test', argumentsTemplate: '',
  } };
}

function fixture(t, hooks, options = {}) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)');
  database.exec(HOOK_CONFIG_SCHEMA_SQL);
  database.prepare('INSERT INTO users VALUES (1, ?)').run('tester');
  const insert = database.prepare(`
    INSERT INTO hooks (id, name, event_name, created_by, updated_by, status, activation_scope)
    VALUES (?, ?, ?, 1, 1, 'published', 'all_users')
  `);
  for (const hook of hooks) insert.run(hook.id, hook.name, hook.eventName);
  const queue = new ClaudeInputQueue();
  t.after(() => { queue.close(); database.close(); });
  const observed = { scripts: [], skills: [], scheduled: [], variables: [] };
  const runtime = createHookRuntimeSession({
    hooks, database, userId: 1, workspaceRoot: tempRoot,
    captureStopHookBoundary: (event) => captureClaudeStopHookBoundary(queue, event),
    resolveUserVariables: async ({ hook }) => {
      observed.variables.push(hook.id);
      return { value: 'ready' };
    },
    scriptExecutor: async ({ hookId, event, env }) => {
      observed.scripts.push({ hookId, event, count: env.hookInvocationCount });
      return {};
    },
    skillContentLoader: async (...args) => {
      observed.skills.push(args);
      return 'Run the completion Skill.\nSKILL_FEEDBACK_MUST_NOT_LEAK';
    },
    enqueueSkillRecovery: async (request) => {
      observed.scheduled.push(request);
      return { status: 'queued', queuePosition: observed.scheduled.length };
    },
    ...options,
  });
  return { database, queue, observed, runtime };
}

function pushInput(queue, content = 'A supplemental human request.', options = {}) {
  const message = buildClaudeUserMessage(content, [], options);
  queue.push(message);
  return message;
}

async function consumeInitial(queue) {
  pushInput(queue, 'Initial human request.');
  await queue.next();
  assert.equal(queue.pendingQueryTurns, 1);
}

test('queued and SDK-consumed supplements suppress intermediate Stop side effects, then final Stop runs once', async (t) => {
  for (const consumeSupplement of [false, true]) {
    await t.test(consumeSupplement ? 'already consumed' : 'still queued', async (t) => {
      const hook = makeHook('stop-hook', {
        userVariables: [{ name: 'value', required: true }],
        postActions: [skillAction()],
      });
      const { database, queue, observed, runtime } = fixture(t, [hook]);
      await consumeInitial(queue);
      const originalBoundary = captureClaudeStopHookBoundary(queue, stopEvent());
      assert.equal(originalBoundary.isCurrent(), true);
      pushInput(queue);
      if (consumeSupplement) await queue.next();
      assert.equal(queue.pendingQueryTurns, 2);
      assert.equal(queue.items.length, consumeSupplement ? 0 : 1);
      assert.equal(originalBoundary.isCurrent(), false);

      // Native SDK Stop is called before the result that decrements the queue.
      const callback = runtime.hooks.Stop[0].hooks[0];
      assert.deepEqual(await callback(stopEvent()), {});
      assert.deepEqual(observed, { scripts: [], skills: [], scheduled: [], variables: [] });
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM hook_executions').get().count, 0);
      assert.equal(queue.finishQueryTurn(), 1);
      if (!consumeSupplement) await queue.next();

      assert.deepEqual(await callback(stopEvent({ last_assistant_message: 'The supplement is answered.' })),
        { systemMessage: 'Check 1' });
      assert.deepEqual(observed.scripts.map(({ count }) => count), [1]);
      assert.equal(observed.variables.length, 1);
      assert.equal(observed.skills.length, 1);
      assert.equal(observed.scheduled.length, 1);
      assert.equal(queue.finishQueryTurn(), 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM hook_executions').get().count, 1);
    });
  }
});

test('multiple live supplements defer Stop until every pending reply reaches its result boundary', async (t) => {
  const { queue, observed, runtime } = fixture(t, [makeHook()]);
  await consumeInitial(queue);
  for (const text of ['First supplement.', 'Second supplement.']) {
    pushInput(queue, text);
    await queue.next();
  }
  assert.equal(queue.pendingQueryTurns, 3);
  assert.equal(queue.items.length, 0);
  for (const remaining of [2, 1]) {
    assert.deepEqual(await runtime.hooks.Stop[0].hooks[0](stopEvent()), {});
    assert.equal(observed.scripts.length, 0);
    assert.equal(queue.finishQueryTurn(), remaining);
  }
  assert.deepEqual(await runtime.hooks.Stop[0].hooks[0](stopEvent()), { systemMessage: 'Check 1' });
  assert.equal(observed.scripts.length, 1);
  assert.equal(queue.finishQueryTurn(), 0);
});

test('pending main replies do not suppress tool hooks or explicit and inherited child Stop hooks', async (t) => {
  const inherited = makeHook('inherited-stop', { includeSubagents: true });
  const child = makeHook('explicit-child', { eventName: 'SubagentStop' });
  const tool = makeHook('tool-hook', { eventName: 'PreToolUse' });
  const { queue, observed, runtime } = fixture(t, [inherited, child, tool]);
  await consumeInitial(queue);
  pushInput(queue);
  const childEvent = stopEvent({ hook_event_name: 'SubagentStop', agent_id: 'child-a' });
  const toolEvent = stopEvent({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'read-1' });
  assert.equal(captureClaudeStopHookBoundary(queue, childEvent), null);
  assert.equal(captureClaudeStopHookBoundary(queue, toolEvent), null);
  assert.equal(captureClaudeStopHookBoundary(queue, stopEvent({ agent_id: 'child-b' })), null);
  assert.deepEqual(await runtime.hooks.Stop[0].hooks[0](stopEvent()), {});
  for (const entry of runtime.hooks.SubagentStop) {
    assert.deepEqual(await entry.hooks[0](childEvent), { systemMessage: 'Check 1' });
  }
  assert.deepEqual(await runtime.hooks.PreToolUse[0].hooks[0](toolEvent), { systemMessage: 'Check 1' });
  assert.deepEqual(observed.scripts.map(({ hookId }) => hookId),
    ['inherited-stop', 'explicit-child', 'tool-hook']);
});

test('a human supplement arriving while the Stop script waits discards feedback and prevents Skill scheduling', async (t) => {
  const entered = deferred();
  const release = deferred();
  let scripts = 0;
  const hook = makeHook('stop-hook', { postActions: [skillAction()] });
  const { queue, observed, runtime } = fixture(t, [hook], {
    scriptExecutor: async () => {
      if (++scripts === 1) { entered.resolve(); await release.promise; }
      return {};
    },
  });
  await consumeInitial(queue);
  const pendingStop = runtime.hooks.Stop[0].hooks[0](stopEvent());
  await entered.promise;
  pushInput(queue);
  await queue.next();
  release.resolve();
  assert.deepEqual(await pendingStop, {});
  assert.equal(observed.skills.length, 0);
  assert.equal(observed.scheduled.length, 0);
  assert.equal(queue.finishQueryTurn(), 1);
  assert.deepEqual(await runtime.hooks.Stop[0].hooks[0](stopEvent()), { systemMessage: 'Check 1' });
  assert.equal(scripts, 2);
  assert.equal(observed.scheduled.length, 1);
});

test('a supplement arriving during Skill loading discards the old enqueue and preserves the final recovery action', async (t) => {
  const entered = deferred();
  const release = deferred();
  let loads = 0;
  const hook = makeHook('stop-hook', { postActions: [skillAction()] });
  const { queue, observed, runtime } = fixture(t, [hook], {
    skillContentLoader: async () => {
      if (++loads === 1) { entered.resolve(); await release.promise; }
      return 'SKILL_FEEDBACK_MUST_NOT_LEAK';
    },
  });
  await consumeInitial(queue);
  const pendingStop = runtime.hooks.Stop[0].hooks[0](stopEvent());
  await entered.promise;
  pushInput(queue);
  release.resolve();
  assert.deepEqual(await pendingStop, {});
  assert.equal(observed.scheduled.length, 0);
  await queue.next();
  assert.equal(queue.finishQueryTurn(), 1);
  assert.deepEqual(await runtime.hooks.Stop[0].hooks[0](stopEvent()), { systemMessage: 'Check 1' });
  assert.equal(loads, 2);
  assert.equal(observed.scheduled.length, 1, 'Discarding an old attempt must not consume its recovery key');
});

test('a late supplement discards an in-flight completion verdict without exhausting the fresh human turn budget', async (t) => {
  const entered = deferred();
  const release = deferred();
  let reviews = 0;
  const hook = makeHook('review-hook', {
    extensionLogic: null, claudeResponse: { bindings: {} },
    postActions: [{ id: 'review', type: 'review_completion', config: { maxReviews: 2 } }],
  });
  const { queue, runtime } = fixture(t, [hook], {
    reviewCompletion: async () => {
      if (++reviews === 1) { entered.resolve(); await release.promise; }
      return { complete: false, reason: 'Needs more evidence.', nextStep: 'Continue the task.' };
    },
  });
  await consumeInitial(queue);
  const pendingStop = runtime.hooks.Stop[0].hooks[0](stopEvent());
  await entered.promise;
  pushInput(queue);
  await queue.next();
  release.resolve();
  assert.deepEqual(await pendingStop, {});
  assert.equal(queue.finishQueryTurn(), 1);
  const firstFreshReview = await runtime.hooks.Stop[0].hooks[0](stopEvent());
  assert.equal(firstFreshReview.decision, 'block');
  assert.equal(firstFreshReview.continue, undefined);
  const secondFreshReview = await runtime.hooks.Stop[0].hooks[0](stopEvent({ stop_hook_active: true }));
  assert.equal(secondFreshReview.continue, false);
  assert.equal(reviews, 3);
});

test('new human input resets completion review counts while repeated Stop retries in the same input revision retain them', async (t) => {
  const hook = makeHook('review-hook', {
    extensionLogic: null, claudeResponse: { bindings: {} },
    postActions: [{ id: 'review', type: 'review_completion', config: { maxReviews: 2 } }],
  });
  const { database, queue, runtime } = fixture(t, [hook], {
    reviewCompletion: async () => ({ complete: false, reason: 'Incomplete.', nextStep: 'Continue.' }),
  });
  await consumeInitial(queue);
  const callback = runtime.hooks.Stop[0].hooks[0];
  assert.equal((await callback(stopEvent())).decision, 'block');
  assert.equal((await callback(stopEvent({ stop_hook_active: true }))).continue, false);
  pushInput(queue);
  assert.deepEqual(await callback(stopEvent()), {});
  await queue.next();
  assert.equal(queue.finishQueryTurn(), 1);
  assert.equal((await callback(stopEvent())).decision, 'block');
  assert.equal((await callback(stopEvent({ stop_hook_active: true }))).continue, false);
  const rows = database.prepare('SELECT actions_json FROM hook_executions ORDER BY rowid').all();
  assert.deepEqual(rows.map(({ actions_json }) => JSON.parse(actions_json).review.output.reviewNumber), [1, 2, 1, 2]);
});

test('the final boundary discards stale Hook follow-ups and keeps the next valid queued turn', async (t) => {
  const { queue } = fixture(t, []);
  await consumeInitial(queue);
  const boundary = captureClaudeStopHookBoundary(queue, stopEvent());
  const discarded = [];
  const session = { status: 'processing', inputQueue: queue, instance: { close() {} } };
  enqueueClaudeFollowupTurn(session, {
    content: 'Old completion Skill.', isCurrent: boundary.isCurrent,
    onDiscard: () => discarded.push('old-skill'),
  });
  pushInput(queue);
  enqueueClaudeFollowupTurn(session, { content: 'A valid later turn.', isCurrent: () => true });
  const result = completeClaudeTurnBoundary(session);
  assert.equal(result.nextTurn.content, 'A valid later turn.');
  assert.deepEqual(discarded, ['old-skill']);
  assert.equal(result.remainingTurns, 0);
  assert.equal(session.status, 'transitioning');
  assert.deepEqual(result.closeErrors, []);
});

test('a Skill enqueued before a later review or MCP await becomes stale and final Stop can enqueue it again', async (t) => {
  for (const awaitingAction of ['review', 'mcp']) {
    await t.test(awaitingAction, async (t) => {
      const entered = deferred();
      const release = deferred();
      let laterCalls = 0;
      const waitForSupplement = async () => {
        if (++laterCalls === 1) { entered.resolve(); await release.promise; }
      };
      const laterAction = awaitingAction === 'review'
        ? { id: 'review', type: 'review_completion', config: { maxReviews: 3 } }
        : { id: 'mcp', type: 'call_mcp_tool', config: { toolName: 'mcp__fixture__check', inputs: {} } };
      const hook = makeHook('stop-hook', { postActions: [skillAction(), laterAction] });
      const scheduled = [];
      const discarded = [];
      const session = { status: 'processing', instance: { close() {} } };
      const { queue, runtime } = fixture(t, [hook], {
        enqueueSkillRecovery: async (request) => {
          scheduled.push(request);
          const queuePosition = enqueueClaudeFollowupTurn(session, {
            content: request.modelContent,
            isCurrent: request.isExecutionCurrent,
            onDiscard: () => discarded.push(request.executionId),
          });
          return { status: 'queued', queuePosition };
        },
        reviewCompletion: async () => {
          await waitForSupplement();
          return { complete: true, reason: 'Complete.', nextStep: '' };
        },
        mcpCaller: async () => { await waitForSupplement(); return { passed: true }; },
      });
      session.inputQueue = queue;
      await consumeInitial(queue);
      const pendingStop = runtime.hooks.Stop[0].hooks[0](stopEvent());
      await entered.promise;
      assert.equal(scheduled.length, 1, 'The first Skill is already enqueued before the later action waits');
      assert.equal(session.queuedTurns[0].isCurrent(), true);
      pushInput(queue);
      await queue.next();
      assert.equal(session.queuedTurns[0].isCurrent(), false);
      release.resolve();
      assert.deepEqual(await pendingStop, {});
      assert.equal(queue.finishQueryTurn(), 1);

      const response = await runtime.hooks.Stop[0].hooks[0](stopEvent());
      assert.equal(response.systemMessage, 'Check 1');
      if (awaitingAction === 'review') assert.equal(response.decision, 'approve');
      assert.equal(scheduled.length, 2, 'The stale recovery key must not suppress the final Skill');
      assert.equal(laterCalls, 2);
      assert.equal(session.queuedTurns[1].isCurrent(), true);
      assert.equal(queue.finishQueryTurn(), 0);
      const result = completeClaudeTurnBoundary(session);
      assert.deepEqual(discarded, [scheduled[0].executionId]);
      assert.equal(result.nextTurn.content, scheduled[1].modelContent);
      assert.equal(result.nextTurn.isCurrent(), true);
      assert.equal(result.remainingTurns, 0);
      assert.deepEqual(result.closeErrors, []);
    });
  }
});

test('script and reviewer failures after a supplement discard their failure feedback instead of blocking the new input', async (t) => {
  for (const failureSource of ['script', 'reviewer']) {
    await t.test(failureSource, async (t) => {
      const entered = deferred();
      const release = deferred();
      let scripts = 0;
      let reviews = 0;
      const throwAfterSupplement = async () => {
        entered.resolve();
        await release.promise;
        throw new Error(`Delayed ${failureSource} failure`);
      };
      const hook = makeHook('review-hook', {
        claudeResponse: { bindings: {} },
        postActions: [{ id: 'review', type: 'review_completion', config: { maxReviews: 2 } }],
      });
      const { database, queue, runtime } = fixture(t, [hook], {
        scriptExecutor: async () => {
          if (++scripts === 1 && failureSource === 'script') await throwAfterSupplement();
          return {};
        },
        reviewCompletion: async () => {
          if (++reviews === 1 && failureSource === 'reviewer') await throwAfterSupplement();
          return { complete: false, reason: 'Fresh review requires evidence.', nextStep: 'Continue.' };
        },
      });
      await consumeInitial(queue);
      const pendingStop = runtime.hooks.Stop[0].hooks[0](stopEvent());
      await entered.promise;
      pushInput(queue);
      await queue.next();
      release.resolve();
      assert.deepEqual(await pendingStop, {});
      const failure = database.prepare('SELECT status, response_json FROM hook_executions ORDER BY rowid LIMIT 1').get();
      assert.equal(failure.status, 'failed', 'The failure remains available in the audit record');
      assert.deepEqual(JSON.parse(failure.response_json), {});
      assert.equal(queue.finishQueryTurn(), 1);
      const freshResponse = await runtime.hooks.Stop[0].hooks[0](stopEvent());
      assert.equal(freshResponse.decision, 'block');
      assert.equal(freshResponse.continue, undefined);
      assert.match(freshResponse.reason, /Fresh review requires evidence/);
    });
  }
});
