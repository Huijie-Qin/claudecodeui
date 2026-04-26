import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from './useSessionStore';
import { computeMerged } from './sessionMerge';

const makeUserText = (fields: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: fields.id || 'msg-1',
  sessionId: fields.sessionId || 'session-1',
  timestamp: fields.timestamp || '2026-04-26T10:31:33.000Z',
  provider: fields.provider || 'claude',
  kind: 'text',
  role: 'user',
  content: fields.content || '你能联网查询当前的热点资讯吗',
});

test('computeMerged drops local optimistic user message after the server copy arrives', () => {
  const serverMessage = makeUserText({
    id: 'server-user',
    timestamp: '2026-04-26T10:31:33.357Z',
  });
  const localOptimisticMessage = makeUserText({
    id: 'local_1777199493000_abc123',
    timestamp: '2026-04-26T10:31:33.000Z',
  });

  const merged = computeMerged([serverMessage], [localOptimisticMessage]);

  assert.deepEqual(merged, [serverMessage]);
});

test('computeMerged keeps later repeated user text as a distinct message', () => {
  const serverMessage = makeUserText({
    id: 'server-user',
    timestamp: '2026-04-26T10:31:33.357Z',
  });
  const laterRepeat = makeUserText({
    id: 'local_1777203093000_def456',
    timestamp: '2026-04-26T11:31:33.000Z',
  });

  const merged = computeMerged([serverMessage], [laterRepeat]);

  assert.deepEqual(merged, [serverMessage, laterRepeat]);
});
