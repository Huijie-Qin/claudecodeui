import assert from 'node:assert/strict';
import test from 'node:test';
import { createHookChatVisibilityStore } from './hookChatVisibilityStore';

test('visibility changes are immediate, scoped, idempotent, and reversible', () => {
  const store = createHookChatVisibilityStore();
  let calls = 0;
  const unsubscribe = store.subscribe(() => calls++);
  store.set(1, 'loop', false);
  assert.equal(store.visible(1, 'loop'), false);
  assert.equal(store.visible(2, 'loop'), true);
  assert.equal(store.visible(1, 'another-hook'), true);
  assert.equal(store.revision(1), 1);
  store.set(1, 'loop', false);
  assert.equal(calls, 1);
  store.set(1, 'loop', true);
  assert.equal(store.visible(1, 'loop'), true);
  assert.equal(calls, 2);
  unsubscribe();
  store.set(1, 'loop', false);
  assert.equal(calls, 2);
  assert.equal(createHookChatVisibilityStore().visible(1, 'loop'), true);
});
