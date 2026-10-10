import assert from 'node:assert/strict';
import test from 'node:test';

import { chatMessageToNormalized, normalizedToChatMessages } from './useChatMessages';
import {
  shouldFlushPendingUserMessageToSession,
  shouldShowPendingUserMessageInView,
} from './pendingUserMessageRouting';

test('task notification details survive the local chat/store round trip without duplicating lifecycle events', () => {
  const original = normalizedToChatMessages([
    { id: 'start', sessionId: 'session-1', provider: 'claude', kind: 'task_notification', timestamp: '2026-09-22T01:00:00Z',
      taskId: 'job-a', toolUseId: 'bash-a', status: 'running', summary: 'Execute check' },
    { id: 'finish', sessionId: 'session-1', provider: 'claude', kind: 'task_notification', timestamp: '2026-09-22T01:00:01Z',
      taskId: 'job-a', status: 'completed', summary: 'Check passed', result: 'OK', outputFile: '/tmp/job-a.output', usage: { duration_ms: 1000 } },
  ])[0];
  const saved = chatMessageToNormalized(original, 'session-1', 'claude');
  assert.ok(saved);
  const restored = normalizedToChatMessages([JSON.parse(JSON.stringify(saved))])[0];
  assert.deepEqual(restored.taskNotification, original.taskNotification);
  assert.equal(restored.id, 'start');
  assert.equal(restored.taskNotification?.events?.length, 2);
});

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
