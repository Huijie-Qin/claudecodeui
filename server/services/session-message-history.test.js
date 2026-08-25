import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindRuntimeMessagesToProviderSession,
  createSessionMessageHistoryService,
  persistNormalizedMessages,
  persistUserPromptMessage,
  shouldSuppressLiveUserTextMessage,
} from './session-message-history.js';

test('Claude session history keeps legacy DB rows and appends JSONL rows after the DB cutoff', async () => {
  let historyOptions = null;
  const service = createSessionMessageHistoryService({
    multitenancy: {
      runtimes: {
        findByProviderSession: () => ({ runtime_home_path: '/tmp/runtime/home' }),
      },
      sessionMessages: {
        listMessages: () => ({
          messages: [
            {
              id: 'db-user',
              kind: 'text',
              role: 'user',
              content: '/report-skill old request',
              timestamp: '2026-07-29T01:00:00.000Z',
              provider: 'claude',
              sessionId: 's1',
            },
            {
              id: 'db-assistant',
              kind: 'text',
              role: 'assistant',
              content: 'Old response',
              timestamp: '2026-07-29T01:00:01.000Z',
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
    },
    providerSessions: {
      fetchHistory: async (_provider, _sessionId, options) => {
        historyOptions = options;
        return {
          messages: [
            {
              id: 'jsonl-expanded-old-user',
              kind: 'text',
              role: 'user',
              content: '# Expanded old skill instructions',
              timestamp: '2026-07-29T01:00:00.000Z',
              provider: 'claude',
              sessionId: 's1',
            },
            {
              id: 'jsonl-old-assistant',
              kind: 'text',
              role: 'assistant',
              content: 'Old response',
              timestamp: '2026-07-29T01:00:01.000Z',
              provider: 'claude',
              sessionId: 's1',
            },
            {
              id: 'jsonl-new-user',
              kind: 'text',
              role: 'user',
              content: '/report-skill new request',
              timestamp: '2026-07-29T01:00:02.000Z',
              provider: 'claude',
              sessionId: 's1',
            },
            {
              id: 'jsonl-new-assistant',
              kind: 'text',
              role: 'assistant',
              content: 'New response',
              timestamp: '2026-07-29T01:00:03.000Z',
              provider: 'claude',
              sessionId: 's1',
            },
          ],
          total: 4,
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

  assert.equal(result.total, 4);
  assert.deepEqual(
    result.messages.map((message) => message.id),
    ['db-user', 'db-assistant', 'jsonl-new-user', 'jsonl-new-assistant'],
  );
  assert.equal(historyOptions.runtimeHomePath, '/tmp/runtime/home');
  assert.equal(historyOptions.limit, null);
  assert.equal(historyOptions.offset, 0);
});

test('Claude session history reads a new JSONL-only session with provider pagination', async () => {
  let historyOptions = null;
  const service = createSessionMessageHistoryService({
    multitenancy: {
      runtimes: {
        findByProviderSession: () => ({ runtime_home_path: '/tmp/runtime/home' }),
      },
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
      fetchHistory: async (_provider, _sessionId, options) => {
        historyOptions = options;
        return {
          messages: [{ id: 'jsonl-msg', kind: 'text', provider: 'claude', sessionId: 's1' }],
          total: 1,
          hasMore: false,
          offset: options.offset,
          limit: options.limit,
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
    limit: 25,
    offset: 5,
  });

  assert.equal(result.messages[0].id, 'jsonl-msg');
  assert.equal(historyOptions.limit, 25);
  assert.equal(historyOptions.offset, 5);
});

test('Claude mixed history paginates after applying the DB-to-JSONL cutoff', async () => {
  const service = createSessionMessageHistoryService({
    multitenancy: {
      runtimes: {
        findByProviderSession: () => ({ runtime_home_path: '/tmp/runtime/home' }),
      },
      sessionMessages: {
        listMessages: () => ({
          messages: [
            {
              id: 'db-1',
              kind: 'text',
              timestamp: '2026-07-29T01:00:00.000Z',
              provider: 'claude',
              sessionId: 's1',
            },
            {
              id: 'db-2',
              kind: 'text',
              timestamp: '2026-07-29T01:00:01.000Z',
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
    },
    providerSessions: {
      fetchHistory: async () => ({
        messages: [
          {
            id: 'jsonl-overlap',
            kind: 'text',
            timestamp: '2026-07-29T01:00:01.000Z',
            provider: 'claude',
            sessionId: 's1',
          },
          {
            id: 'jsonl-1',
            kind: 'text',
            timestamp: '2026-07-29T01:00:02.000Z',
            provider: 'claude',
            sessionId: 's1',
          },
          {
            id: 'jsonl-2',
            kind: 'text',
            timestamp: '2026-07-29T01:00:03.000Z',
            provider: 'claude',
            sessionId: 's1',
          },
          {
            id: 'jsonl-3',
            kind: 'text',
            timestamp: '2026-07-29T01:00:04.000Z',
            provider: 'claude',
            sessionId: 's1',
          },
        ],
        total: 4,
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
    },
    limit: 2,
    offset: 2,
  });

  assert.equal(result.total, 5);
  assert.equal(result.hasMore, true);
  assert.equal(result.limit, 2);
  assert.equal(result.offset, 2);
  assert.deepEqual(result.messages.map((message) => message.id), ['db-2', 'jsonl-1']);
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

test('scheduled Claude history uses runtime JSONL without database message merging', async () => {
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

  assert.equal(historyOptions.limit, 50);
  assert.equal(historyOptions.offset, 0);
  assert.equal(result.total, 1);
  assert.deepEqual(result.messages.map((message) => message.id), ['jsonl-assistant']);
});

test('scheduled Claude history restores legacy database skill invocations without duplicates or expanded bodies', async () => {
  const databaseInvocation = {
    id: 'db-skill',
    kind: 'text',
    role: 'user',
    content: '/report-skill weekly status',
    timestamp: '2026-07-27T01:00:00.000Z',
    provider: 'claude',
    sessionId: 's1',
  };
  const assistantMessage = {
    id: 'jsonl-assistant',
    kind: 'text',
    role: 'assistant',
    content: 'Scheduled report complete.',
    timestamp: '2026-07-27T01:00:01.000Z',
    provider: 'claude',
    sessionId: 's1',
  };
  let historyOptions = null;
  let databaseMessages = [databaseInvocation];
  let jsonlMessages = [assistantMessage];
  let jsonlTotal = 2;
  const service = createSessionMessageHistoryService({
    multitenancy: {
      runtimes: {
        findByProviderSession: () => ({ runtime_home_path: '/tmp/runtime/home' }),
      },
      sessionMessages: {
        listMessages: () => ({
          messages: databaseMessages,
          total: databaseMessages.length,
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
          messages: jsonlMessages,
          total: jsonlTotal,
          hasMore: false,
          offset: options.offset,
          limit: options.limit,
        };
      },
    },
  });
  const fetchHistory = () => service.fetchHistory({
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

  const missingInvocation = await fetchHistory();
  assert.equal(historyOptions.limit, null);
  assert.equal(historyOptions.offset, 0);
  assert.deepEqual(
    missingInvocation.messages.map((message) => message.id),
    ['db-skill', 'jsonl-assistant'],
  );

  jsonlMessages = [
    {
      ...databaseInvocation,
      id: 'jsonl-skill',
      timestamp: '2026-07-27T01:00:00.100Z',
    },
    assistantMessage,
  ];
  jsonlTotal = 2;
  const restoredInvocation = await fetchHistory();
  assert.deepEqual(
    restoredInvocation.messages.map((message) => message.id),
    ['jsonl-skill', 'jsonl-assistant'],
  );

  jsonlMessages = [
    {
      ...databaseInvocation,
      id: 'jsonl-expanded-skill',
      content: '# Report Skill\n\nExpanded internal instructions.',
      timestamp: '2026-07-27T01:00:00.100Z',
    },
    assistantMessage,
  ];
  const expandedInvocation = await fetchHistory();
  assert.deepEqual(
    expandedInvocation.messages.map((message) => message.id),
    ['db-skill', 'jsonl-assistant'],
  );
  assert.equal(
    expandedInvocation.messages.some((message) => message.content.includes('Expanded internal')),
    false,
  );

  databaseMessages = [
    databaseInvocation,
    {
      ...databaseInvocation,
      id: 'db-skill-repeat',
      timestamp: '2026-07-27T01:00:10.000Z',
    },
  ];
  jsonlMessages = [
    {
      ...databaseInvocation,
      id: 'jsonl-skill',
      timestamp: '2026-07-27T01:00:00.100Z',
    },
    assistantMessage,
  ];
  const repeatedInvocation = await fetchHistory();
  assert.deepEqual(
    repeatedInvocation.messages.map((message) => message.id),
    ['jsonl-skill', 'jsonl-assistant', 'db-skill-repeat'],
  );
});

test('scheduled Claude history returns JSONL messages unchanged', async () => {
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

test('Claude session history restores generic Hook cards from existing execution audits', async () => {
  const service = createSessionMessageHistoryService({
    multitenancy: {
      runtimes: {
        findByProviderSession: () => null,
      },
      sessionMessages: {
        listMessages: () => ({
          messages: [{
            id: 'assistant-1',
            kind: 'text',
            role: 'assistant',
            content: 'Done.',
            timestamp: '2026-08-24T01:00:00.000Z',
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
    hookConfigs: {
      listAllExecutions: ({ sessionId, userId }) => {
        assert.equal(sessionId, 's1');
        assert.equal(userId, 2);
        return [{
          id: 'execution-1',
          hookId: 'sql-check',
          hookName: 'SQL Check 强制校验',
          eventName: 'Stop',
          status: 'succeeded',
          startedAtMs: Date.parse('2026-08-24T01:00:01.000Z'),
        }];
      },
      getHook: () => ({
        id: 'sql-check',
        name: 'SQL Check 强制校验',
        description: '校验模型返回的 SQL。',
        eventName: 'Stop',
        extensionLogic: { code: 'export async function run() {}' },
        postActions: [{ type: 'call_mcp_tool' }],
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
    },
  });

  assert.deepEqual(result.messages.map((message) => message.id), [
    'assistant-1',
    'hook_activity_execution-1_execution',
  ]);
  assert.deepEqual(result.messages[1], {
    id: 'hook_activity_execution-1_execution',
    sessionId: 's1',
    timestamp: '2026-08-24T01:00:01.000Z',
    provider: 'claude',
    kind: 'hook_activity',
    origin: 'hook',
    activityKind: 'execution',
    status: 'succeeded',
    jobId: 'hook_activity_execution-1_execution',
    executionId: 'execution-1',
    hookId: 'sql-check',
    hookName: 'SQL Check 强制校验',
    eventName: 'Stop',
    actionTypes: ['call_mcp_tool'],
    hasScript: true,
    summary: '校验模型返回的 SQL。',
  });
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

test('Claude background task user queries are not persisted to the database', () => {
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

  assert.equal(changed, 0);
  assert.deepEqual(persisted, []);
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

test('Claude persists only synthetic Hook activity alongside its JSONL transcript', () => {
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
        id: 'assistant-1',
        sessionId: 'claude-session-1',
        timestamp: '2026-04-26T00:00:01.000Z',
        provider: 'claude',
        kind: 'text',
        role: 'assistant',
        content: 'Done',
      },
      {
        id: 'hook_activity_execution-1_action-1',
        sessionId: 'claude-session-1',
        timestamp: '2026-04-26T00:00:02.000Z',
        provider: 'claude',
        kind: 'hook_activity',
        status: 'running',
        jobId: 'hook_activity_execution-1_action-1',
      },
    ],
  });

  assert.equal(changed, 1);
  assert.deepEqual(persisted.map((message) => message.id), ['hook_activity_execution-1_action-1']);
});

test('Claude session history merges persisted Hook activity into the JSONL transcript', async () => {
  const service = createSessionMessageHistoryService({
    multitenancy: {
      runtimes: {
        findByProviderSession: () => ({ runtime_home_path: '/tmp/runtime/home' }),
      },
      sessionMessages: {
        listMessages: () => ({
          messages: [{
            id: 'hook_activity_execution-1_action-1',
            kind: 'hook_activity',
            timestamp: '2026-07-29T01:00:02.000Z',
            provider: 'claude',
            sessionId: 's1',
            status: 'succeeded',
            hookId: 'notify-on-stop',
            hookName: '对话正常结束通知',
          }],
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
          {
            id: 'jsonl-user',
            kind: 'text',
            role: 'user',
            content: 'Run the check.',
            timestamp: '2026-07-29T01:00:00.000Z',
            provider: 'claude',
            sessionId: 's1',
          },
          {
            id: 'jsonl-assistant',
            kind: 'text',
            role: 'assistant',
            content: 'Done.',
            timestamp: '2026-07-29T01:00:01.000Z',
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
    },
    limit: 20,
    offset: 0,
  });

  assert.deepEqual(
    result.messages.map((message) => message.id),
    ['jsonl-user', 'jsonl-assistant', 'hook_activity_execution-1_action-1'],
  );
  assert.equal(result.messages[2].status, 'succeeded');
});
