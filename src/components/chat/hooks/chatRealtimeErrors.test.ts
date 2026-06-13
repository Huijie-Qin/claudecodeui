import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getRealtimeErrorContent,
  isPendingViewTerminalMessage,
} from './chatRealtimeErrors';

test('getRealtimeErrorContent returns websocket error content', () => {
  const content = 'Command failed: docker run ...\nfailed to connect to the docker API';

  assert.equal(
    getRealtimeErrorContent({
      kind: 'error',
      content,
    }),
    content,
  );
});

test('isPendingViewTerminalMessage handles new-session errors without a session id', () => {
  assert.equal(
    isPendingViewTerminalMessage({
      kind: 'error',
      explicitSessionId: null,
      activeViewSessionId: null,
      hasPendingViewSession: true,
      selectedSessionId: null,
    }),
    true,
  );
});

test('isPendingViewTerminalMessage ignores existing selected sessions', () => {
  assert.equal(
    isPendingViewTerminalMessage({
      kind: 'error',
      explicitSessionId: null,
      activeViewSessionId: 'session-1',
      hasPendingViewSession: true,
      selectedSessionId: 'session-1',
    }),
    false,
  );
});
