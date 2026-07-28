import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindRuntimeMessagesToProviderSession,
  createSessionMessageHistoryService,
  persistNormalizedMessages,
  persistUserPromptMessage,
  shouldSuppressLiveUserTextMessage,
} from './session-message-history.js';

test('Claude session history prefers runtime JSONL over legacy DB rows', async () => {
  let historyOptions = null;
  const service = createSessionMessageHistoryService({
    multitenancy: {
      runtimes: {
        findByProviderSession: () => ({ runtime_home_path: '/tmp/runtime/home' }),
      },
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
      fetchHistory: async (_provider, _sessionId, options) => {
        historyOptions = options;
        return {
          messages: [{ id: 'jsonl-msg', kind: 'text', provider: 'claude', sessionId: 's1' }],
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

  assert.equal(result.total, 1);
  assert.equal(result.messages[0].id, 'jsonl-msg');
  assert.equal(historyOptions.runtimeHomePath, '/tmp/runtime/home');
});

test('background runs keep live user queries while interactive runs suppress echoed queries', () => {
  const userMessage = { kind: 'text', role: 'user', content: 'hello' };

  assert.equal(shouldSuppressLiveUserTextMessage(userMessage, {}), true);
  assert.equal(
    shouldSuppressLiveUserTextMessage(userMessage, { isBackgroundTaskWriter: true }),
    false,
  );
  assert.equal(
    shouldSuppressLiveUserTextMessage(
      { kind: 'text', role: 'assistant', content: 'hello' },
      {},
    ),
    false,
  );
});

test('interactive runs keep synthetic Claude task notifications for realtime result updates', () => {
  const taskNotification = {
    kind: 'text',
    role: 'user',
    content: [
      '  <task-notification version="2">',
      '<task-id>agent-1</task-id>',
      '<tool-use-id>toolu_agent_1</tool-use-id>',
      '<status>completed</status>',
      '<summary>Agent completed</summary>',
      '<result>Done</result>',
      '</task-notification>',
    ].join('\n'),
  };

  assert.equal(shouldSuppressLiveUserTextMessage(taskNotification, {}), false);
});

test('scheduled Claude history fills a missing user query from the database fallback', async () => {
  let historyOptions = null;
  const service = createSessionMessageHistoryService({
    multitenancy: {
      runtimes: {
        findByProviderSession: () => ({ runtime_home_path: '/tmp/runtime/home' }),
      },
      sessionMessages: {
        listMessages: () => ({
          messages: [{
            id: 'db-user',
            kind: 'text',
            role: 'user',
            content: 'Run the scheduled check.',
            timestamp: '2026-07-27T01:00:00.000Z',
            provider: 'claude',
            sessionId: 's1',
          }],
          total: 1,
          hasMore: false,
          offset: 0,
          limit: null,
        }),
      },
    },
    providerSessions: {
      fetchHistory: async (_provider, _sessionId, options) => {
        historyOptions = options;
        return {
          messages: [{
            id: 'jsonl-assistant',
            kind: 'text',
            role: 'assistant',
            content: 'Scheduled check complete.',
            timestamp: '2026-07-27T01:00:01.000Z',
            provider: 'claude',
            sessionId: 's1',
          }],
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
      metadata_json: JSON.stringify({ scheduledTaskId: 42 }),
    },
    limit: 50,
    offset: 0,
  });

  assert.equal(historyOptions.limit, null);
  assert.equal(historyOptions.offset, 0);
  assert.equal(result.total, 2);
  assert.deepEqual(result.messages.map((message) => message.id), ['db-user', 'jsonl-assistant']);
});

test('scheduled Claude history does not duplicate a query already present in JSONL', async () => {
  const databasePrompt = {
    id: 'db-user',
    kind: 'text',
    role: 'user',
    content: 'Run the scheduled check.',
    timestamp: '2026-07-27T01:00:00.000Z',
    provider: 'claude',
    sessionId: 's1',
  };
  const service = createSessionMessageHistoryService({
    multitenancy: {
      runtimes: {
        findByProviderSession: () => ({ runtime_home_path: '/tmp/runtime/home' }),
      },
      sessionMessages: {
        listMessages: () => ({
          messages: [databasePrompt],
          total: 1,
          hasMore: false,
          offset: 0,
          limit: null,
        }),
      },
    },
    providerSessions: {
      fetchHistory: async () => ({
        messages: [
          { ...databasePrompt, id: 'jsonl-user', timestamp: '2026-07-27T01:00:01.000Z' },
          {
            id: 'jsonl-assistant',
            kind: 'text',
            role: 'assistant',
            content: 'Scheduled check complete.',
            timestamp: '2026-07-27T01:00:02.000Z',
            provider: 'claude',
            sessionId: 's1',
          },
        ],
        total: 2,
        hasMore: false,
        offset: 0,
        limit: null,
      }),
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
      metadata_json: JSON.stringify({ scheduledTaskId: 42 }),
    },
  });

  assert.equal(result.total, 2);
  assert.deepEqual(result.messages.map((message) => message.id), ['jsonl-user', 'jsonl-assistant']);
});

test('Claude session history falls back to legacy DB when runtime JSONL is unavailable', async () => {
  let fallbackCalled = false;
  const service = createSessionMessageHistoryService({
    multitenancy: {
      runtimes: {
        findByProviderSession: () => null,
      },
      sessionMessages: {
        listMessages: () => ({
          messages: [{ id: 'legacy-msg', kind: 'text', provider: 'claude', sessionId: 's1' }],
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

  assert.equal(fallbackCalled, false);
  assert.equal(result.messages[0].id, 'legacy-msg');
});

test('interactive Claude user and assistant messages are not persisted to the database', () => {
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

  assert.deepEqual(history.messages, []);
});

test('Claude background task user queries are persisted as a history fallback', () => {
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
    },
  };

  const changed = persistUserPromptMessage({
    multitenancy,
    options: {
      tenantId: 1,
      workspaceId: 3,
      userId: 2,
      backgroundTask: true,
    },
    provider: 'claude',
    providerSessionId: 'pending:scheduled-run',
    runtimeId: 'runtime-1',
    command: 'Run the scheduled check.',
    timestamp: '2026-07-27T01:00:00.000Z',
    messageId: 'scheduled-user-1',
  });

  assert.equal(changed, 1);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].role, 'user');
  assert.equal(persisted[0].content, 'Run the scheduled check.');
});

test('streaming control messages are not persisted into durable session history', () => {
  const persisted = [];
  const multitenancy = {
    sessionMessages: {
      upsertMessages: ({ messages }) => {
        persisted.push(...messages);
        return messages.length;
      },
    },
  };

  const changed = persistNormalizedMessages({
    multitenancy,
    options: { tenantId: 1, workspaceId: 3, userId: 2 },
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    runtimeId: 'runtime-1',
    messages: [
      {
        id: 'stream-1',
        sessionId: 'claude-session-1',
        timestamp: '2026-04-26T00:00:00.100Z',
        provider: 'claude',
        kind: 'stream_delta',
        content: 'Hel',
      },
      {
        id: 'stream-end-1',
        sessionId: 'claude-session-1',
        timestamp: '2026-04-26T00:00:00.200Z',
        provider: 'claude',
        kind: 'stream_end',
      },
      {
        id: 'assistant-1',
        sessionId: 'claude-session-1',
        timestamp: '2026-04-26T00:00:01.000Z',
        provider: 'claude',
        kind: 'text',
        role: 'assistant',
        content: 'Hello',
      },
    ],
  });

  assert.equal(changed, 0);
  assert.deepEqual(persisted, []);
});

test('Claude meta and sidechain messages are not persisted into durable session history', () => {
  const persisted = [];
  const multitenancy = {
    sessionMessages: {
      upsertMessages: ({ messages }) => {
        persisted.push(...messages);
        return messages.length;
      },
    },
  };

  const changed = persistNormalizedMessages({
    multitenancy,
    options: { tenantId: 1, workspaceId: 3, userId: 2 },
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    runtimeId: 'runtime-1',
    messages: [
      {
        id: 'skill-meta-1',
        sessionId: 'claude-session-1',
        timestamp: '2026-05-12T00:00:00.000Z',
        provider: 'claude',
        kind: 'text',
        role: 'user',
        isMeta: true,
        content: 'Base directory for this skill: /Users/song/.claude/skills/find-skills\n\n# Find Skills',
      },
      {
        id: 'sidechain-1',
        sessionId: 'claude-session-1',
        timestamp: '2026-05-12T00:00:01.000Z',
        provider: 'claude',
        kind: 'text',
        role: 'user',
        isSidechain: true,
        content: 'Search the workspace for skill files.',
      },
      {
        id: 'assistant-1',
        sessionId: 'claude-session-1',
        timestamp: '2026-05-12T00:00:02.000Z',
        provider: 'claude',
        kind: 'text',
        role: 'assistant',
        content: 'Done',
      },
    ],
  });

  assert.equal(changed, 0);
  assert.deepEqual(persisted, []);
});
