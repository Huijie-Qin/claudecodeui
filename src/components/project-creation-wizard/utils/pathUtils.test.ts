import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldUseFilesystemPicker } from './pathUtils';

test('new workspaces do not expose the filesystem picker', () => {
  assert.equal(shouldUseFilesystemPicker('new'), false);
});

test('existing workspace imports do not expose the filesystem picker', () => {
  assert.equal(shouldUseFilesystemPicker('existing'), false);
});
