import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRefreshProjectsForRealtimeMessage } from './chatRealtimeRefresh';

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
