import assert from 'node:assert/strict';
import test from 'node:test';

import {
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

test('scheduled task events show the skill invocation instead of the expanded skill body', () => {
  const expandedSkill = '# Daily check\n\nInspect billing and return a report.';
  const event = sanitizeScheduledTaskEvent({
    data: { kind: 'text', role: 'user', content: expandedSkill },
    displayPrompt: '/daily-check billing',
    modelPrompt: expandedSkill,
  });

  assert.equal(event.content, '/daily-check billing');
});
