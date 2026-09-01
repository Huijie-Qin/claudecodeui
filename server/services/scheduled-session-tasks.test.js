import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildScheduledTaskRunSessionSummary,
  resolveScheduledTaskResumeSession,
  sanitizeScheduledTaskEvent,
} from './scheduled-task-execution.js';

test('scheduled tasks start a new session by default', () => {
  const sessionId = resolveScheduledTaskResumeSession({
    sessionMode: 'new',
    sessionId: 'previous-session',
  });

  assert.equal(sessionId, null);
});

test('scheduled tasks resume the last session only in merge mode', () => {
  const sessionId = resolveScheduledTaskResumeSession({
    sessionMode: 'merge',
    sessionId: 'previous-session',
  });

  assert.equal(sessionId, 'previous-session');
});

test('merge mode does not depend on the runtime current-session binding', () => {
  const sessionId = resolveScheduledTaskResumeSession({
    sessionMode: 'merge',
    sessionId: 'scheduled-session',
    canResume: () => false,
  });

  assert.equal(sessionId, 'scheduled-session');
});

test('legacy scheduled tasks without a session mode start a new session', () => {
  const sessionId = resolveScheduledTaskResumeSession({
    sessionId: 'legacy-session',
  });

  assert.equal(sessionId, null);
});

test('new scheduled task session titles use Shanghai time without a UTC marker', () => {
  const summary = buildScheduledTaskRunSessionSummary({
    taskName: 'Billing check',
    sessionMode: 'new',
    runStartedAt: '2026-07-23T02:03:04.000Z',
  });

  assert.equal(summary, 'Billing check - 2026-07-23 10:03:04');
  assert.equal(summary.includes('UTC'), false);
});

test('legacy scheduled task session titles default to Shanghai run timestamps', () => {
  const summary = buildScheduledTaskRunSessionSummary({
    taskName: 'Billing check',
    sessionMode: null,
    runStartedAt: '2026-07-23T02:03:04.000Z',
  });

  assert.equal(summary, 'Billing check - 2026-07-23 10:03:04');
});

test('scheduled task events show the skill invocation instead of the expanded skill body', () => {
  const expandedSkill = '# Daily check\n\nInspect billing and return a report.';
  const event = sanitizeScheduledTaskEvent({
    data: { kind: 'text', role: 'user', content: expandedSkill },
    displayPrompt: '/daily-check billing',
    modelPrompt: expandedSkill,
  });

  assert.equal(event.content, '/daily-check billing');
});
