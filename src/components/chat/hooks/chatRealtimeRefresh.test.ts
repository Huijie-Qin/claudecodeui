import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isRealtimeActivityForSession,
  shouldRefreshProjectsForRealtimeMessage,
  shouldRefreshSessionHistoryForRealtimeMessage,
} from './chatRealtimeRefresh';
import { shouldAdoptCreatedSession } from './sessionCreatedRouting';

test('shouldRefreshProjectsForRealtimeMessage refreshes when a provider session is created', () => {
  assert.equal(
    shouldRefreshProjectsForRealtimeMessage({ kind: 'session_created', newSessionId: 'session-123' }),
    true,
  );
});

test('scheduled task sessions refresh the project tree without taking over a pending chat', () => {
  assert.equal(
    shouldAdoptCreatedSession({
      newSessionId: 'scheduled-run-1',
      currentSessionId: 'new-session-1',
      selectedSessionId: null,
      hasPendingViewSession: true,
      isBackgroundSession: true,
    }),
    false,
  );
  assert.equal(
    shouldRefreshProjectsForRealtimeMessage({ kind: 'session_created', newSessionId: 'scheduled-run-1' }),
    true,
  );
});

test('shouldRefreshProjectsForRealtimeMessage refreshes after a successful completed session', () => {
  assert.equal(
    shouldRefreshProjectsForRealtimeMessage({ kind: 'complete', exitCode: 0, sessionId: 'session-123' }),
    true,
  );
});

test('shouldRefreshProjectsForRealtimeMessage ignores failed completions and unrelated messages', () => {
  assert.equal(shouldRefreshProjectsForRealtimeMessage({ kind: 'complete', exitCode: 1, sessionId: 'session-123' }), false);
  assert.equal(shouldRefreshProjectsForRealtimeMessage({ kind: 'text', sessionId: 'session-123' }), false);
});

test('shouldRefreshSessionHistoryForRealtimeMessage refreshes after normalized completion', () => {
  assert.equal(
    shouldRefreshSessionHistoryForRealtimeMessage({
      kind: 'complete',
      exitCode: 0,
      sessionId: 'session-123',
    }),
    true,
  );
  assert.equal(
    shouldRefreshSessionHistoryForRealtimeMessage({
      kind: 'complete',
      exitCode: 1,
      sessionId: 'session-123',
    }),
    false,
  );
});

test('shouldRefreshSessionHistoryForRealtimeMessage preserves legacy session status refreshes', () => {
  assert.equal(
    shouldRefreshSessionHistoryForRealtimeMessage({
      type: 'session-status',
      isProcessing: false,
      sessionId: 'session-123',
    }),
    true,
  );
});

test('shouldAdoptCreatedSession ignores a new-session event after the user switched to another session', () => {
  assert.equal(shouldAdoptCreatedSession({
    newSessionId: 'new-session-real-id',
    currentSessionId: null,
    selectedSessionId: 'existing-session-2',
    hasPendingViewSession: false,
  }), false);
});

test('shouldAdoptCreatedSession accepts a new-session event while still viewing the pending new session', () => {
  assert.equal(shouldAdoptCreatedSession({
    newSessionId: 'new-session-real-id',
    currentSessionId: null,
    selectedSessionId: null,
    hasPendingViewSession: true,
  }), true);
});

test('background WebSocket traffic does not postpone the current session status probe', () => {
  assert.equal(isRealtimeActivityForSession({ type: 'active-sessions' }, 'session-1', 'claude'), false);
  assert.equal(isRealtimeActivityForSession({ type: 'projects_updated' }, 'session-1', 'claude'), false);
  assert.equal(isRealtimeActivityForSession({ kind: 'text', sessionId: 'session-2', provider: 'claude' }, 'session-1', 'claude'), false);
  assert.equal(isRealtimeActivityForSession({ kind: 'text', sessionId: 'session-1', provider: 'cursor' }, 'session-1', 'claude'), false);
  assert.equal(isRealtimeActivityForSession({ kind: 'stream_delta', sessionId: 'session-1', provider: 'claude' }, 'session-1', 'claude'), true);
});
