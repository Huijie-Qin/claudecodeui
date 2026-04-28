import assert from 'node:assert/strict';
import test from 'node:test';

import {
  shouldFlushPendingUserMessageToSession,
  shouldShowPendingUserMessageInView,
} from './pendingUserMessageRouting';

test('pending new-session user message is not flushed into a selected existing session', () => {
  assert.equal(
    shouldFlushPendingUserMessageToSession({
      activeSessionId: 'session-2',
      previousActiveSessionId: null,
      selectedSessionId: 'session-2',
      hasPendingUserMessage: true,
    }),
    false,
  );
});

test('pending new-session user message is hidden when viewing a selected existing session', () => {
  assert.equal(
    shouldShowPendingUserMessageInView({
      selectedSessionId: 'session-2',
      storeMessageCount: 0,
      hasPendingUserMessage: true,
    }),
    false,
  );
});

test('pending new-session user message can attach when the new session receives its real id', () => {
  assert.equal(
    shouldFlushPendingUserMessageToSession({
      activeSessionId: 'session-1',
      previousActiveSessionId: null,
      selectedSessionId: null,
      hasPendingUserMessage: true,
    }),
    true,
  );
});
