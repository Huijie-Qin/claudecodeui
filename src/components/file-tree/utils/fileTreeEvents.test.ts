import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dispatchProjectFilesChanged,
  subscribeProjectFilesChanged,
} from './fileTreeEvents';

test('project file change listeners receive matching file updates', () => {
  const received: unknown[] = [];
  const unsubscribe = subscribeProjectFilesChanged((event) => {
    received.push(event);
  });

  dispatchProjectFilesChanged({
    projectName: 'demo',
    workspaceId: 12,
    changedPath: 'notes.md',
    reason: 'upload',
  });
  unsubscribe();
  dispatchProjectFilesChanged({
    projectName: 'demo',
    workspaceId: 12,
    changedPath: 'ignored.md',
    reason: 'upload',
  });

  assert.deepEqual(received, [
    {
      projectName: 'demo',
      workspaceId: 12,
      changedPath: 'notes.md',
      reason: 'upload',
    },
  ]);
});
