import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureClaudeStopHookBoundary,
  completeClaudeTurnBoundary,
  enqueueClaudeFollowupTurn,
} from './claude-turn-boundary.js';

test('main Stop waits for supplemental queries while retaining the current query count', () => {
  const inputQueue = { pendingQueryTurns: 2, inputRevision: 2 };
  const boundary = captureClaudeStopHookBoundary(inputQueue, { hook_event_name: 'Stop' });

  assert.equal(boundary.inputRevision, 2);
  assert.equal(boundary.isCurrent(), false, 'a current query plus an unfinished supplement is not final');

  inputQueue.pendingQueryTurns = 1;
  assert.equal(boundary.isCurrent(), true, 'Stop precedes the final query result');

  inputQueue.pendingQueryTurns = 0;
  assert.equal(boundary.isCurrent(), true);
});

test('new input permanently invalidates a captured Stop even after its query completes', () => {
  const inputQueue = { pendingQueryTurns: 1, inputRevision: 1 };
  const boundary = captureClaudeStopHookBoundary(inputQueue, { hook_event_name: 'Stop' });
  assert.equal(boundary.isCurrent(), true);

  inputQueue.pendingQueryTurns = 2;
  inputQueue.inputRevision += 1;
  assert.equal(boundary.isCurrent(), false);

  inputQueue.pendingQueryTurns = 1;
  assert.equal(boundary.isCurrent(), false, 'the old Stop cannot become current again');

  const latestBoundary = captureClaudeStopHookBoundary(inputQueue, { hook_event_name: 'Stop' });
  assert.equal(latestBoundary.isCurrent(), true, 'the final Stop can capture the new input revision');
});

test('context-only input invalidates an in-progress Stop without adding a pending query', () => {
  const inputQueue = { pendingQueryTurns: 1, inputRevision: 1 };
  const boundary = captureClaudeStopHookBoundary(inputQueue, { hook_event_name: 'Stop' });

  inputQueue.inputRevision += 1;
  assert.equal(inputQueue.pendingQueryTurns, 1);
  assert.equal(boundary.isCurrent(), false);
  assert.equal(captureClaudeStopHookBoundary(inputQueue, { hook_event_name: 'Stop' }).isCurrent(), true);
});

test('Stop boundary capture does not gate subagents, failures, or tool Hooks', () => {
  const inputQueue = { pendingQueryTurns: 2, inputRevision: 2 };
  for (const event of [
    { hook_event_name: 'Stop', agent_id: 'child' },
    { hook_event_name: 'SubagentStop', agent_id: 'child' },
    { hook_event_name: 'StopFailure' },
    { hook_event_name: 'PreToolUse' },
    undefined,
  ]) {
    assert.equal(captureClaudeStopHookBoundary(inputQueue, event), null);
  }
});

test('queued Hook follow-ups wait outside the active SDK input stream', () => {
  let inputPushes = 0;
  let inputCloses = 0;
  let instanceCloses = 0;
  const session = {
    status: 'processing',
    inputQueue: {
      push: () => { inputPushes += 1; },
      close: () => { inputCloses += 1; },
    },
    instance: {
      close: () => { instanceCloses += 1; },
    },
  };

  const position = enqueueClaudeFollowupTurn(session, {
    content: 'second turn',
    displayContent: 'second turn',
  });

  assert.equal(position, 1);
  assert.equal(inputPushes, 0, 'the active SDK stream must not receive the follow-up early');
  assert.equal(inputCloses, 0);
  assert.equal(instanceCloses, 0);

  const boundary = completeClaudeTurnBoundary(session);

  assert.equal(boundary.nextTurn.content, 'second turn');
  assert.equal(boundary.remainingTurns, 0);
  assert.deepEqual(boundary.closeErrors, []);
  assert.equal(inputCloses, 1);
  assert.equal(instanceCloses, 1);
  assert.equal(session.status, 'transitioning');
});

test('queued Claude follow-ups retain FIFO turn boundaries', () => {
  const session = {
    status: 'processing',
    inputQueue: { close() {} },
    instance: { close() {} },
  };

  enqueueClaudeFollowupTurn(session, { content: 'first queued turn' });
  enqueueClaudeFollowupTurn(session, { content: 'second queued turn' });

  const firstBoundary = completeClaudeTurnBoundary(session);
  assert.equal(firstBoundary.nextTurn.content, 'first queued turn');
  assert.equal(firstBoundary.remainingTurns, 1);

  const secondBoundary = completeClaudeTurnBoundary(session);
  assert.equal(secondBoundary.nextTurn.content, 'second queued turn');
  assert.equal(secondBoundary.remainingTurns, 0);
});

test('a completed Claude turn without a follow-up becomes idle', () => {
  const session = {
    status: 'processing',
    inputQueue: { close() {} },
    instance: { close() {} },
  };

  const boundary = completeClaudeTurnBoundary(session);

  assert.equal(boundary.nextTurn, null);
  assert.equal(boundary.remainingTurns, 0);
  assert.equal(session.status, 'idle');
});

test('completion discards stale Hook turns while preserving ordinary and current turns in FIFO order', () => {
  const inputQueue = { pendingQueryTurns: 1, inputRevision: 1, close() {} };
  const staleBoundary = captureClaudeStopHookBoundary(inputQueue, { hook_event_name: 'Stop' });
  const discarded = [];
  const session = { status: 'processing', inputQueue, instance: { close() {} } };

  enqueueClaudeFollowupTurn(session, {
    content: 'stale Hook Skill',
    mode: 'hook_recovery',
    isCurrent: staleBoundary.isCurrent,
    onDiscard: () => discarded.push('stale Hook Skill'),
  });
  enqueueClaudeFollowupTurn(session, { content: 'ordinary first turn' });
  inputQueue.inputRevision += 1;
  const currentBoundary = captureClaudeStopHookBoundary(inputQueue, { hook_event_name: 'Stop' });
  enqueueClaudeFollowupTurn(session, {
    content: 'current Hook Skill',
    mode: 'hook_recovery',
    isCurrent: currentBoundary.isCurrent,
    onDiscard: () => discarded.push('current Hook Skill'),
  });
  enqueueClaudeFollowupTurn(session, { content: 'ordinary last turn' });

  const firstBoundary = completeClaudeTurnBoundary(session);
  assert.equal(firstBoundary.nextTurn.content, 'ordinary first turn');
  assert.equal(firstBoundary.remainingTurns, 2);
  assert.deepEqual(firstBoundary.closeErrors, []);
  assert.deepEqual(discarded, ['stale Hook Skill']);

  const secondBoundary = completeClaudeTurnBoundary(session);
  assert.equal(secondBoundary.nextTurn.content, 'current Hook Skill');
  assert.equal(secondBoundary.remainingTurns, 1);

  const thirdBoundary = completeClaudeTurnBoundary(session);
  assert.equal(thirdBoundary.nextTurn.content, 'ordinary last turn');
  assert.equal(thirdBoundary.remainingTurns, 0);
  assert.deepEqual(discarded, ['stale Hook Skill']);
});

test('discard callback failures are reported without blocking later queued turns or stream closure', () => {
  const discardError = new Error('discard activity failed');
  let inputCloses = 0;
  let instanceCloses = 0;
  const discarded = [];
  const session = {
    status: 'processing',
    inputQueue: { close: () => { inputCloses += 1; } },
    instance: { close: () => { instanceCloses += 1; } },
  };
  enqueueClaudeFollowupTurn(session, {
    content: 'stale first turn',
    isCurrent: () => false,
    onDiscard: () => { throw discardError; },
  });
  enqueueClaudeFollowupTurn(session, {
    content: 'stale second turn',
    isCurrent: () => false,
    onDiscard: () => discarded.push('stale second turn'),
  });
  enqueueClaudeFollowupTurn(session, { content: 'next ordinary turn' });

  const boundary = completeClaudeTurnBoundary(session);
  assert.equal(boundary.nextTurn.content, 'next ordinary turn');
  assert.equal(boundary.remainingTurns, 0);
  assert.deepEqual(boundary.closeErrors, [discardError]);
  assert.deepEqual(discarded, ['stale second turn']);
  assert.equal(inputCloses, 1);
  assert.equal(instanceCloses, 1);
  assert.equal(session.status, 'transitioning');
});

test('discarding every stale Hook turn leaves the completed session idle', () => {
  let discarded = 0;
  const session = { status: 'processing', inputQueue: { close() {} }, instance: { close() {} } };
  enqueueClaudeFollowupTurn(session, {
    content: 'stale Hook Skill',
    isCurrent: () => false,
    onDiscard: () => { discarded += 1; },
  });

  const boundary = completeClaudeTurnBoundary(session);
  assert.equal(boundary.nextTurn, null);
  assert.equal(boundary.remainingTurns, 0);
  assert.deepEqual(boundary.closeErrors, []);
  assert.equal(discarded, 1);
  assert.equal(session.status, 'idle');
});
