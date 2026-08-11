import assert from 'node:assert/strict';
import test from 'node:test';

import { createHookItemId } from './editorUtils';

test('createHookItemId uses randomUUID when the browser supports it', () => {
  assert.equal(createHookItemId({ randomUUID: () => 'generated-uuid' }), 'generated-uuid');
});

test('createHookItemId falls back when randomUUID is unavailable', () => {
  assert.equal(
    createHookItemId({
      now: () => 1_700_000_000_000,
      random: () => 0.123456789,
    }),
    'hook_item_loyw3v28_4fzzzxjy',
  );
});
