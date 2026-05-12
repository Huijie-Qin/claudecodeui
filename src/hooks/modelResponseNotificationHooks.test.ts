import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MODEL_RESPONSE_HOOK_CONFIG,
  buildModelResponseHookNotification,
  normalizeModelResponseHookConfig,
} from './modelResponseNotificationHooks';

const enabledConfig = normalizeModelResponseHookConfig({
  ...DEFAULT_MODEL_RESPONSE_HOOK_CONFIG,
  enabled: true,
});

test('model response hook notifies for user confirmation requests', () => {
  const notification = buildModelResponseHookNotification({
    kind: 'permission_request',
    provider: 'claude',
    sessionId: 'session-1',
    requestId: 'request-1',
    toolName: 'AskUserQuestion',
    input: {
      questions: [{ header: 'Confirm action', question: 'Should I continue?' }],
    },
  }, enabledConfig);

  assert.equal(notification?.trigger, 'userConfirmation');
  assert.equal(notification?.sessionId, 'session-1');
  assert.match(notification?.body || '', /Should I continue/);
});

test('model response hook matches custom keywords in tool output', () => {
  const notification = buildModelResponseHookNotification({
    id: 'tool-result-1',
    kind: 'tool_result',
    provider: 'claude',
    sessionId: 'session-1',
    toolId: 'tool-1',
    content: 'Query finished. 5 rows returned.',
  }, {
    ...enabledConfig,
    triggers: {
      ...enabledConfig.triggers,
      assistantKeyword: true,
    },
    keywordPatterns: ['rows returned'],
  });

  assert.equal(notification?.trigger, 'assistantKeyword');
  assert.match(notification?.body || '', /5 rows returned/);
});

test('model response hook does not notify for streaming keyword chunks', () => {
  const notification = buildModelResponseHookNotification({
    id: 'delta-1',
    kind: 'stream_delta',
    provider: 'claude',
    sessionId: 'session-1',
    content: '天气',
  }, {
    ...enabledConfig,
    triggers: {
      ...enabledConfig.triggers,
      assistantKeyword: true,
    },
    keywordPatterns: ['天气'],
  });

  assert.equal(notification, null);
});

test('model response hook does not match keywords inside thinking messages', () => {
  const notification = buildModelResponseHookNotification({
    id: 'thinking-1',
    kind: 'thinking',
    provider: 'claude',
    sessionId: 'session-1',
    content: '天气 appears in private reasoning and should not notify.',
  }, {
    ...enabledConfig,
    triggers: {
      ...enabledConfig.triggers,
      assistantKeyword: true,
    },
    keywordPatterns: ['天气'],
  });

  assert.equal(notification, null);
});

test('model response hook creates a distinct run completed tag per completion event', () => {
  const config = {
    ...enabledConfig,
    triggers: {
      ...enabledConfig.triggers,
      runCompleted: true,
    },
  };

  const firstNotification = buildModelResponseHookNotification({
    id: 'complete-1',
    kind: 'complete',
    provider: 'claude',
    sessionId: 'session-1',
  }, config);
  const secondNotification = buildModelResponseHookNotification({
    id: 'complete-2',
    kind: 'complete',
    provider: 'claude',
    sessionId: 'session-1',
  }, config);

  assert.equal(firstNotification?.trigger, 'runCompleted');
  assert.equal(secondNotification?.trigger, 'runCompleted');
  assert.notEqual(firstNotification?.tag, secondNotification?.tag);
});

test('model response hook ignores disabled config', () => {
  const notification = buildModelResponseHookNotification({
    kind: 'permission_request',
    provider: 'claude',
    sessionId: 'session-1',
    requestId: 'request-1',
    toolName: 'AskUserQuestion',
  }, DEFAULT_MODEL_RESPONSE_HOOK_CONFIG);

  assert.equal(notification, null);
});
