import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldAdoptCreatedSession } from './sessionCreatedRouting';

test('creation-only conversation adopts a real session only for its own pending foreground turn', () => {
  const args = { newSessionId: 'native', currentSessionId: 'skill-creation:123', selectedSessionId: 'skill-creation:123', hasPendingViewSession: true };
  assert.equal(shouldAdoptCreatedSession(args), true);
  assert.equal(shouldAdoptCreatedSession({ ...args, hasPendingViewSession: false }), false);
  assert.equal(shouldAdoptCreatedSession({ ...args, isBackgroundSession: true }), false);
  assert.equal(shouldAdoptCreatedSession({ ...args, selectedSessionId: 'another-session' }), false);
  assert.equal(shouldAdoptCreatedSession({ ...args, selectedSessionId: null, currentSessionId: 'native-existing' }), false);
});
