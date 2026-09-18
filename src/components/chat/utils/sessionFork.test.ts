import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project, ProjectSession } from '../../../types/app';
import type { ChatMessage } from '../types/types';

import { addForkedSessionToProjects, canForkMessage } from './sessionFork';

const completedReply: ChatMessage = {
  id: 'text_normalized-id',
  type: 'assistant',
  timestamp: '2026-09-18T00:00:00Z',
  content: 'Done',
  sourceMessageUuid: 'raw-assistant-uuid',
  canFork: true,
};

test('only an explicit Claude checkpoint exposes branching', () => {
  assert.equal(canForkMessage(completedReply, 'claude'), true);
  for (const provider of ['codex', 'cursor', 'gemini']) {
    assert.equal(canForkMessage(completedReply, provider), false);
  }
  for (const overrides of [
    { canFork: undefined }, { canFork: false }, { sourceMessageUuid: undefined },
    { type: 'user' }, { type: 'hook' }, { type: 'error' },
    { isStreaming: true }, { isThinking: true }, { isToolUse: true },
    { isInteractivePrompt: true }, { isTaskNotification: true }, { isHookActivity: true },
  ]) {
    assert.equal(canForkMessage({ ...completedReply, ...overrides }, 'claude'), false, JSON.stringify(overrides));
  }
});

test('registering a fork preserves its parent and the correct workspace before navigation', () => {
  const parent = { id: 'parent-session', summary: 'Original' };
  const project: Project = {
    name: 'same-project', displayName: 'Workspace A', fullPath: '/workspace', workspaceId: 10,
    sessions: [parent], sessionMeta: { total: 20, hasMore: true },
  };
  const otherWorkspace: Project = { ...project, workspaceId: 20, sessions: [{ id: 'other-session' }] };
  const fork: ProjectSession = { id: 'fork-session', parentSessionId: parent.id, __provider: 'claude' };
  const updated = addForkedSessionToProjects([project, otherWorkspace], project, fork);

  assert.deepEqual(updated[0].sessions?.map((session) => session.id), ['fork-session', 'parent-session']);
  assert.equal(updated[0].sessions?.[0].parentSessionId, parent.id);
  assert.equal(updated[0].sessionMeta?.total, 21);
  assert.equal(updated[0].sessionMeta?.hasMore, true);
  assert.equal(updated[1], otherWorkspace);
  assert.deepEqual(project.sessions, [parent], 'The source snapshot must not be mutated');

  const retried = addForkedSessionToProjects(updated, project, { ...fork, summary: 'Updated title' });
  assert.equal(retried[0].sessionMeta?.total, 21, 'An idempotent response must not count the session twice');
  assert.equal(retried[0].sessions?.length, 2);
  assert.equal(retried[0].sessions?.[0].summary, 'Updated title');
});
