import assert from 'node:assert/strict';
import test from 'node:test';

import {
  replaceTemporaryActiveSessionIds,
  replaceTemporaryProcessingSessions,
} from './useSessionProtection';

test('replaceTemporaryActiveSessionIds transfers temporary sessions to the real id', () => {
  assert.deepEqual(
    [...replaceTemporaryActiveSessionIds(
      new Set(['session-existing', 'new-session-123']),
      'session-real',
    )].sort(),
    ['session-existing', 'session-real'],
  );
});

test('replaceTemporaryActiveSessionIds leaves sessions unchanged when no temporary session exists', () => {
  const sessions = new Set(['session-existing']);

  assert.equal(replaceTemporaryActiveSessionIds(sessions, 'session-real'), sessions);
});

test('replaceTemporaryProcessingSessions transfers the earliest temporary start time', () => {
  const sessions = new Map([
    ['session-existing', 30],
    ['new-session-later', 20],
    ['new-session-earlier', 10],
  ]);

  assert.deepEqual(
    [...replaceTemporaryProcessingSessions(sessions, 'session-real').entries()].sort(),
    [
      ['session-existing', 30],
      ['session-real', 10],
    ],
  );
});

test('replaceTemporaryProcessingSessions leaves sessions unchanged when no temporary session exists', () => {
  const sessions = new Map([['session-existing', 30]]);

  assert.equal(replaceTemporaryProcessingSessions(sessions, 'session-real'), sessions);
});
