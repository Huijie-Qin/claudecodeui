import assert from 'node:assert/strict';
import test from 'node:test';

import { closeClaudeSessionForShutdown } from './claude-session-shutdown.js';

test('shutdown closes idle Claude streams without treating them as processing', async () => {
  const events = [];
  const session = {
    status: 'idle',
    inputQueue: { close: () => events.push('input-close') },
    instance: { close: () => events.push('stream-close') },
  };

  const result = await closeClaudeSessionForShutdown({
    sessionId: 'idle-one',
    session,
    abortProcessing: () => events.push('abort'),
  });

  assert.equal(result.abortError, null);
  assert.equal(result.closeError, null);
  assert.deepEqual(events, ['input-close', 'stream-close']);
});

test('shutdown awaits a successful processing abort without racing stream close', async () => {
  const events = [];
  const result = await closeClaudeSessionForShutdown({
    sessionId: 'active-one',
    session: {
      status: 'processing',
      inputQueue: { close: () => events.push('input-close') },
      instance: { close: () => events.push('stream-close') },
    },
    abortProcessing: async (sessionId) => {
      events.push(`abort:${sessionId}`);
      return true;
    },
  });

  assert.equal(result.abortError, null);
  assert.equal(result.closeError, null);
  assert.deepEqual(events, ['abort:active-one']);
});

test('shutdown closes a processing stream only after abort reports failure', async () => {
  const events = [];
  const result = await closeClaudeSessionForShutdown({
    sessionId: 'active-fallback',
    session: {
      status: 'processing',
      inputQueue: { close: () => events.push('input-close') },
      instance: { close: () => events.push('stream-close') },
    },
    abortProcessing: async (sessionId) => {
      events.push(`abort:${sessionId}`);
      return false;
    },
  });

  assert.equal(result.abortError, null);
  assert.equal(result.closeError, null);
  assert.deepEqual(events, ['abort:active-fallback', 'input-close', 'stream-close']);
});

test('shutdown records an abort error before using the close fallback', async () => {
  const events = [];
  const abortFailure = new Error('interrupt failed');
  const result = await closeClaudeSessionForShutdown({
    sessionId: 'active-error',
    session: {
      status: 'processing',
      inputQueue: { close: () => events.push('input-close') },
      instance: { close: () => events.push('stream-close') },
    },
    abortProcessing: async () => {
      events.push('abort');
      throw abortFailure;
    },
  });

  assert.equal(result.abortError, abortFailure);
  assert.equal(result.closeError, null);
  assert.deepEqual(events, ['abort', 'input-close', 'stream-close']);
});
