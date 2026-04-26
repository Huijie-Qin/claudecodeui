import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../../../types/app';
import { getAllSessions } from './utils';

const makeProject = (sessions: Project['sessions']): Project => ({
  name: 'workspace-a',
  displayName: 'Workspace A',
  fullPath: '/tmp/workspace-a',
  sessions,
});

test('getAllSessions drops duplicate Claude sessions loaded again as additional sessions', () => {
  const session = {
    id: 'session-1',
    summary: 'hello',
    lastActivity: '2026-04-26T16:46:17.000Z',
  };

  const sessions = getAllSessions(makeProject([session]), {
    'workspace-a': [{ ...session }],
  });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'session-1');
});

test('getAllSessions keeps same-title Claude sessions when their ids differ', () => {
  const sessions = getAllSessions(makeProject([
    {
      id: 'session-1',
      summary: 'hello',
      lastActivity: '2026-04-26T16:46:17.000Z',
    },
    {
      id: 'session-2',
      summary: 'hello',
      lastActivity: '2026-04-26T16:48:11.000Z',
    },
  ]), {});

  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((session) => session.id), ['session-2', 'session-1']);
});
