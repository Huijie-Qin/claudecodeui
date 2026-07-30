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

const makeAssistantText = (fields: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: fields.id || 'assistant-1',
  sessionId: fields.sessionId || 'session-1',
  timestamp: fields.timestamp || '2026-04-26T10:31:34.000Z',
  provider: fields.provider || 'claude',
  kind: 'text',
  role: 'assistant',
  content: fields.content || '可以。',
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

test('computeMerged drops realtime slash invocation after marker-restored history arrives', () => {
  const content = '/dataops-html-report 帮我分析这份数据';
  const serverMessage = makeUserText({
    id: 'expanded-skill-jsonl',
    timestamp: '2026-04-26T10:31:33.357Z',
    content,
  });
  const localOptimisticMessage = makeUserText({
    id: 'local_1777199493000_skill',
    timestamp: '2026-04-26T10:31:33.000Z',
    content,
  });

  const merged = computeMerged([serverMessage], [localOptimisticMessage]);

  assert.deepEqual(merged, [serverMessage]);
});

test('computeMerged drops realtime slash-only invocation after marker-restored history arrives', () => {
  const content = '/dataops-html-report';
  const serverMessage = makeUserText({
    id: 'expanded-skill-without-query-jsonl',
    timestamp: '2026-04-26T10:31:33.357Z',
    content,
  });
  const localOptimisticMessage = makeUserText({
    id: 'local_1777199493000_skill_without_query',
    timestamp: '2026-04-26T10:31:33.000Z',
    content,
  });

  const merged = computeMerged([serverMessage], [localOptimisticMessage]);

  assert.deepEqual(merged, [serverMessage]);
});

test('computeMerged matches persisted user messages to optimistic messages one-to-one', () => {
  const content = '/dataops-html-report 帮我分析这份数据';
  const serverMessage = makeUserText({
    id: 'expanded-skill-jsonl',
    timestamp: '2026-04-26T10:31:33.357Z',
    content,
  });
  const firstLocalCall = makeUserText({
    id: 'local_1777199493000_first',
    timestamp: '2026-04-26T10:31:33.000Z',
    content,
  });
  const secondLocalCall = makeUserText({
    id: 'local_1777199493700_second',
    timestamp: '2026-04-26T10:31:33.700Z',
    content,
  });

  const merged = computeMerged(
    [serverMessage],
    [firstLocalCall, secondLocalCall],
  );

  assert.deepEqual(merged, [serverMessage, secondLocalCall]);
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

test('computeMerged inserts optimistic user text before later server assistant messages', () => {
  const localUser = makeUserText({
    id: 'local_1777199493000_abc123',
    timestamp: '2026-04-26T10:31:33.000Z',
  });
  const serverAssistant = makeAssistantText({
    id: 'assistant-1',
    timestamp: '2026-04-26T10:31:34.000Z',
  });

  const merged = computeMerged([serverAssistant], [localUser]);

  assert.deepEqual(merged, [localUser, serverAssistant]);
});

test('computeMerged drops duplicate realtime messages by intrinsic id', () => {
  const realtimeMessage = makeAssistantText({
    id: 'assistant-duplicate',
  });

  const merged = computeMerged([], [realtimeMessage, realtimeMessage]);

  assert.deepEqual(merged, [realtimeMessage]);
});

test('computeMerged drops duplicated optimistic user text for the same local timestamp', () => {
  const firstLocalUser = makeUserText({
    id: 'local_1777199493000_abc123',
    timestamp: '2026-04-26T10:31:33.000Z',
    content: 'hello',
  });
  const duplicatedLocalUser = makeUserText({
    id: 'local_1777199493000_def456',
    timestamp: '2026-04-26T10:31:33.000Z',
    content: 'hello',
  });

  const merged = computeMerged([], [firstLocalUser, duplicatedLocalUser]);

  assert.deepEqual(merged, [firstLocalUser]);
});

test('computeMerged drops pending new-session user after the real session prompt is persisted', () => {
  const persistedPrompt = makeUserText({
    id: 'user_1777199493000_abc123',
    sessionId: 'real-session-1',
    timestamp: '2026-04-26T10:31:33.700Z',
    content: 'hello',
  });
  const pendingLocalUser = makeUserText({
    id: 'local_1777199493000_def456',
    sessionId: 'new-session-1777199493000',
    timestamp: '2026-04-26T10:31:33.000Z',
    content: 'hello',
  });

  const merged = computeMerged([persistedPrompt], [pendingLocalUser]);

  assert.deepEqual(merged, [persistedPrompt]);
});

test('computeMerged hides a streaming placeholder once the canonical assistant text arrives', () => {
  const streamingPlaceholder: NormalizedMessage = {
    id: '__streaming_session-1',
    sessionId: 'session-1',
    timestamp: '2026-04-28T19:01:17.000Z',
    provider: 'claude',
    kind: 'stream_delta',
    content: 'Hello can I today?',
  };
  const canonicalAssistant = makeAssistantText({
    id: 'msg_canonical_assistant',
    timestamp: '2026-04-28T19:01:17.500Z',
    content: 'Hello! How can I help you today?',
  });

  const merged = computeMerged([], [streamingPlaceholder, canonicalAssistant]);

  assert.deepEqual(merged, [canonicalAssistant]);
});

test('computeMerged hides segmented streaming placeholders once canonical assistant text arrives', () => {
  const streamingPlaceholder: NormalizedMessage = {
    id: '__streaming_session-1_2',
    sessionId: 'session-1',
    timestamp: '2026-04-28T19:01:19.000Z',
    provider: 'claude',
    kind: 'stream_delta',
    content: 'The command finished successfully.',
  };
  const canonicalAssistant = makeAssistantText({
    id: 'msg_canonical_assistant_after_tool',
    timestamp: '2026-04-28T19:01:19.500Z',
    content: 'The command finished successfully.',
  });

  const merged = computeMerged([], [streamingPlaceholder, canonicalAssistant]);

  assert.deepEqual(merged, [canonicalAssistant]);
});
