import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClaudeSessionExecutionKey,
  createClaudeSessionExecutionQueue,
} from './claude-session-execution.js';

function createDeferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

test('same-session scheduled turns retain an intervening interactive message', async () => {
  const queue = createClaudeSessionExecutionQueue();
  const key = buildClaudeSessionExecutionKey({
    tenantId: 1,
    workspaceId: 2,
    userId: 3,
    sessionId: 'scheduled-session',
  });
  const transcript = [];
  const interactiveStarted = createDeferred();
  const finishInteractive = createDeferred();

  await queue.run(key, async () => {
    transcript.push('scheduled run 1');
  });

  const interactiveTurn = queue.run(key, async () => {
    transcript.push('interactive message');
    interactiveStarted.resolve();
    await finishInteractive.promise;
  });
  await interactiveStarted.promise;

  let secondScheduledStarted = false;
  const secondScheduledTurn = queue.run(key, async () => {
    secondScheduledStarted = true;
    transcript.push('scheduled run 2');
  });

  await Promise.resolve();
  assert.equal(secondScheduledStarted, false);
  assert.deepEqual(transcript, [
    'scheduled run 1',
    'interactive message',
  ]);

  finishInteractive.resolve();
  await Promise.all([interactiveTurn, secondScheduledTurn]);

  assert.deepEqual(transcript, [
    'scheduled run 1',
    'interactive message',
    'scheduled run 2',
  ]);
  assert.equal(queue.hasPending(key), false);
});

test('different Claude sessions can still execute concurrently', async () => {
  const queue = createClaudeSessionExecutionQueue();
  const firstStarted = createDeferred();
  const secondStarted = createDeferred();
  const release = createDeferred();

  const first = queue.run('session-a', async () => {
    firstStarted.resolve();
    await release.promise;
  });
  const second = queue.run('session-b', async () => {
    secondStarted.resolve();
    await release.promise;
  });

  await Promise.all([firstStarted.promise, secondStarted.promise]);
  release.resolve();
  await Promise.all([first, second]);
});

test('a failed Claude turn does not block the next turn in the same session', async () => {
  const queue = createClaudeSessionExecutionQueue();

  await assert.rejects(
    queue.run('scheduled-session', async () => {
      throw new Error('first turn failed');
    }),
    /first turn failed/,
  );

  const result = await queue.run('scheduled-session', async () => 'next turn completed');
  assert.equal(result, 'next turn completed');
});
