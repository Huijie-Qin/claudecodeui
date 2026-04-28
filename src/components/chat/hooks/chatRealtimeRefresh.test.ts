import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRefreshProjectsForRealtimeMessage } from './chatRealtimeRefresh';
import { shouldAdoptCreatedSession } from './sessionCreatedRouting';

test('shouldRefreshProjectsForRealtimeMessage refreshes when a provider session is created', () => {
  assert.equal(
    shouldRefreshProjectsForRealtimeMessage({ kind: 'session_created', newSessionId: 'session-123' }),
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
