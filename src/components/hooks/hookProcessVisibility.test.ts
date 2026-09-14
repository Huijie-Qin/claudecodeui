import assert from 'node:assert/strict';
import test from 'node:test';

import { getHookProcessVisibility } from './hookProcessVisibility';

const execution = { isExecution: true, hasPostActions: true, showScriptPreference: false, hasExecutionContext: true };

test('disabling script details does not hide post-actions or their unified entry', () => {
  assert.deepEqual(getHookProcessVisibility(execution), { showProcess: true, showScript: false, showPostActions: true });
});

test('enabling script details adds one section to the same process', () => {
  assert.deepEqual(getHookProcessVisibility({ ...execution, showScriptPreference: true }), {
    showProcess: true, showScript: true, showPostActions: true,
  });
});

test('script-only Hooks hide the empty entry by default and expose it when enabled', () => {
  assert.deepEqual(getHookProcessVisibility({ ...execution, hasPostActions: false }), {
    showProcess: false, showScript: false, showPostActions: false,
  });
  assert.deepEqual(getHookProcessVisibility({ ...execution, hasPostActions: false, showScriptPreference: true }), {
    showProcess: true, showScript: true, showPostActions: false,
  });
});

test('missing audit context does not hide the existing post-action results', () => {
  assert.deepEqual(getHookProcessVisibility({ ...execution, hasExecutionContext: false, showScriptPreference: true }), {
    showProcess: true, showScript: false, showPostActions: true,
  });
});

test('standalone legacy followups do not acquire a second execution wrapper', () => {
  assert.deepEqual(getHookProcessVisibility({ ...execution, isExecution: false, showScriptPreference: true }), {
    showProcess: false, showScript: false, showPostActions: false,
  });
});
