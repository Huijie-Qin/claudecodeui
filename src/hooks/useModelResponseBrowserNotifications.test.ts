import assert from 'node:assert/strict';
import test from 'node:test';

import {
  shouldSuppressRunCompletedAfterUserConfirmation,
} from './modelResponseNotificationHooks';
import type { ModelResponseHookNotification } from './modelResponseNotificationHooks';

const baseNotification = {
  title: 'Assistant notification',
  body: 'A model response event occurred.',
  sessionId: 'session-1',
} satisfies Omit<ModelResponseHookNotification, 'tag' | 'trigger'>;

test('model response hook suppresses the next run completed notification after user confirmation', () => {
  const promptedRunKeys = new Set<string>();
  const runKey = 'claude:session-1';

  const userConfirmation = {
    ...baseNotification,
    trigger: 'userConfirmation',
    tag: 'confirm-1',
  } satisfies ModelResponseHookNotification;
  const runCompleted = {
    ...baseNotification,
    trigger: 'runCompleted',
    tag: 'complete-1',
  } satisfies ModelResponseHookNotification;

  assert.equal(shouldSuppressRunCompletedAfterUserConfirmation(
    userConfirmation,
    runKey,
    promptedRunKeys,
  ), false);
  assert.equal(promptedRunKeys.has(runKey), true);

  assert.equal(shouldSuppressRunCompletedAfterUserConfirmation(
    runCompleted,
    runKey,
    promptedRunKeys,
  ), true);
  assert.equal(promptedRunKeys.has(runKey), false);

  assert.equal(shouldSuppressRunCompletedAfterUserConfirmation(
    { ...runCompleted, tag: 'complete-2' },
    runKey,
    promptedRunKeys,
  ), false);
});

test('model response hook keeps run completed notifications for other sessions', () => {
  const promptedRunKeys = new Set<string>(['claude:session-1']);
  const runCompleted = {
    ...baseNotification,
    trigger: 'runCompleted',
    tag: 'complete-2',
  } satisfies ModelResponseHookNotification;

  assert.equal(shouldSuppressRunCompletedAfterUserConfirmation(
    runCompleted,
    'claude:session-2',
    promptedRunKeys,
  ), false);
  assert.equal(promptedRunKeys.has('claude:session-1'), true);
});
