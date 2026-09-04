import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeClaudeTurnBoundary,
  enqueueClaudeFollowupTurn,
} from './claude-turn-boundary.js';

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
