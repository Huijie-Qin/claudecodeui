import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizedToChatMessages } from '../components/chat/hooks/useChatMessages';

import { computeMerged, reconcileRealtimeAfterServerRefresh } from './sessionMerge';
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

test('late parent text updates the current transcript even when history has the same id', () => {
  const partial = makeAssistantText('parent-answer_0', '2026-09-03T10:00:00.000Z');
  const complete = { ...partial, content: `${partial.content}\nFinal paragraph after the children finished.` };

  const displayed = normalizedToChatMessages(computeMerged([partial], [complete]));
  assert.equal(displayed.length, 1);
  assert.equal(displayed[0].content, complete.content);

  // A refresh that started before the last WebSocket message must not discard
  // that message merely because its id is already present in stale history.
  const retained = reconcileRealtimeAfterServerRefresh([partial], [complete]);
  assert.deepEqual(retained, [complete]);
  assert.equal(normalizedToChatMessages(computeMerged([partial], retained))[0].content, complete.content);

  assert.deepEqual(reconcileRealtimeAfterServerRefresh([complete], retained), []);
  assert.deepEqual(computeMerged([complete], [partial]), [complete]);
});

test('text extension preference does not cross agent scopes or override unrelated canonical content', () => {
  const persisted = makeAssistantText('parent-answer_0', '2026-09-03T10:00:00.000Z');
  for (const live of [
    { ...persisted, content: `${persisted.content} Child suffix.`, parentToolUseId: 'child-tool' },
    { ...persisted, content: `${persisted.content} Other session.`, sessionId: 'session-2' },
    { ...persisted, content: 'Unrelated content that happens to be much longer than the persisted canonical text.' },
  ]) {
    assert.deepEqual(computeMerged([persisted], [live]), [persisted]);
  }
});
