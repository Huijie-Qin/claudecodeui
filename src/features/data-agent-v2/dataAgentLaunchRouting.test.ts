import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isProvisionalDataAgentSessionId,
  resolveDataAgentLaunchMessage,
} from './dataAgentLaunchRouting';

test('does not treat a failed pending provider ID as a real session', () => {
  assert.deepEqual(
    resolveDataAgentLaunchMessage({
      kind: 'session_created',
      provider: 'claude',
      newSessionId: 'pending:request-1',
      failed: true,
    }, 'claude'),
    { type: 'await-error', sessionId: 'pending:request-1' },
  );
});

test('surfaces the matching launch error after a provisional session failure', () => {
  assert.deepEqual(
    resolveDataAgentLaunchMessage({
      kind: 'error',
      provider: 'claude',
      sessionId: 'pending:request-1',
      content: 'Provider failed to start',
    }, 'claude', 'pending:request-1'),
    { type: 'failed', message: 'Provider failed to start' },
  );
});

test('accepts a concrete provider session ID', () => {
  assert.deepEqual(
    resolveDataAgentLaunchMessage({
      kind: 'session_created',
      provider: 'codex',
      newSessionId: 'thread-123',
    }, 'codex'),
    { type: 'created', sessionId: 'thread-123' },
  );
  assert.equal(isProvisionalDataAgentSessionId('thread-123'), false);
});

test('ignores unrelated provider errors', () => {
  assert.deepEqual(
    resolveDataAgentLaunchMessage({
      kind: 'error',
      provider: 'claude',
      sessionId: 'existing-session',
      content: 'Unrelated failure',
    }, 'claude'),
    { type: 'ignore' },
  );
});
