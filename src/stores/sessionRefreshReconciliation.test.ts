import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileRealtimeAfterServerRefresh } from './sessionMerge';
import type { NormalizedMessage } from './useSessionStore';

const makeAssistantText = (
  id: string,
  timestamp: string,
): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp,
  provider: 'claude',
  kind: 'text',
  role: 'assistant',
  content: 'The final streamed answer.',
});

test('server refresh keeps a finalized stream while persisted history is still stale', () => {
  const finalizedStream = makeAssistantText(
    'text_1777199494000_stream',
    '2026-04-26T10:31:34.000Z',
  );

  const reconciled = reconcileRealtimeAfterServerRefresh([], [finalizedStream]);

  assert.deepEqual(reconciled, [finalizedStream]);
});

test('server refresh removes a finalized stream after the persisted copy arrives', () => {
  const finalizedStream = makeAssistantText(
    'text_1777199494000_stream',
    '2026-04-26T10:31:34.000Z',
  );
  const persistedAssistant = makeAssistantText(
    'assistant-from-jsonl',
    '2026-04-26T10:31:35.000Z',
  );

  const reconciled = reconcileRealtimeAfterServerRefresh(
    [persistedAssistant],
    [finalizedStream],
  );

  assert.deepEqual(reconciled, []);
});
