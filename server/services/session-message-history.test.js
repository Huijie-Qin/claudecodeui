import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindRuntimeMessagesToProviderSession,
  createSessionMessageHistoryService,
  persistNormalizedMessages,
  persistUserPromptMessage,
} from './session-message-history.js';

test('session message history prefers DB rows over provider fallback', async () => {
  let fallbackCalled = false;
  const service = createSessionMessageHistoryService({
    multitenancy: {
      sessionMessages: {
        listMessages: () => ({
          messages: [{ id: 'db-msg', kind: 'text', provider: 'claude', sessionId: 's1' }],
          total: 1,
          hasMore: false,
          offset: 0,
          limit: null,
        }),
      },
    },
    providerSessions: {
      fetchHistory: async () => {
        fallbackCalled = true;
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      },
    },
  });

  const result = await service.fetchHistory({
    tenantId: 1,
    userId: 2,
    provider: 'claude',
    providerSessionId: 's1',
    ownedSession: {
      workspace_id: 3,
      workspace_slug: 'repo',
      workspace_path: '/tmp/repo',
    },
  });

  assert.equal(result.total, 1);
  assert.equal(result.messages[0].id, 'db-msg');
  assert.equal(fallbackCalled, false);
});

test('session message history falls back when DB has no messages', async () => {
  let fallbackCalled = false;
  const service = createSessionMessageHistoryService({
    multitenancy: {
      sessionMessages: {
        listMessages: () => ({
          messages: [],
          total: 0,
          hasMore: false,
          offset: 0,
          limit: null,
        }),
      },
    },
    providerSessions: {
      fetchHistory: async (providerName, sessionId, options) => {
        fallbackCalled = true;
        assert.equal(providerName, 'claude');
        assert.equal(sessionId, 's1');
        assert.equal(options.projectPath, '/tmp/repo');
        return {
          messages: [{ id: 'legacy-msg', kind: 'text', provider: 'claude', sessionId: 's1' }],
          total: 1,
          hasMore: false,
          offset: 0,
          limit: null,
        };
      },
    },
  });

  const result = await service.fetchHistory({
    tenantId: 1,
    userId: 2,
    provider: 'claude',
    providerSessionId: 's1',
    ownedSession: {
      workspace_id: 3,
      workspace_slug: 'repo',
      workspace_path: '/tmp/repo',
    },
  });

  assert.equal(fallbackCalled, true);
  assert.equal(result.messages[0].id, 'legacy-msg');
});

test('user prompt is persisted before assistant history for newly created sessions', () => {
  const persisted = [];
  const multitenancy = {
    sessionMessages: {
      upsertMessages: ({ providerSessionId, messages }) => {
        persisted.push(...messages.map((message) => ({
          ...message,
          sessionId: providerSessionId || message.sessionId,
        })));
        return messages.length;
      },
      bindProviderSession: ({ providerSessionId }) => {
        for (const message of persisted) {
          if (!message.sessionId) {
            message.sessionId = providerSessionId;
          }
        }
        return persisted.length;
      },
      listMessages: () => ({
        messages: persisted,
        total: persisted.length,
        hasMore: false,
        offset: 0,
        limit: null,
      }),
    },
  };

  persistUserPromptMessage({
    multitenancy,
    options: { tenantId: 1, workspaceId: 3, userId: 2 },
    provider: 'claude',
    runtimeId: 'runtime-1',
    command: 'Reply exactly with ok.',
    timestamp: '2026-04-26T00:00:00.000Z',
    messageId: 'user-1',
  });

  bindRuntimeMessagesToProviderSession({
    multitenancy,
    runtimeId: 'runtime-1',
    providerSessionId: 'claude-session-1',
  });

  persistNormalizedMessages({
    multitenancy,
    options: { tenantId: 1, workspaceId: 3, userId: 2 },
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    runtimeId: 'runtime-1',
    messages: [{
      id: 'assistant-1',
      sessionId: 'claude-session-1',
      timestamp: '2026-04-26T00:00:01.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: 'ok',
    }],
  });

  const history = multitenancy.sessionMessages.listMessages();

  assert.deepEqual(history.messages.map((message) => message.role), ['user', 'assistant']);
  assert.deepEqual(history.messages.map((message) => message.content), ['Reply exactly with ok.', 'ok']);
  assert.deepEqual(history.messages.map((message) => message.sessionId), ['claude-session-1', 'claude-session-1']);
});
