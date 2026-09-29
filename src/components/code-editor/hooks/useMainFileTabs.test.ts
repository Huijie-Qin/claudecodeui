import assert from 'node:assert/strict';
import test from 'node:test';

import type { CodeEditorFile } from '../types/types';

import { displayPathFor, replacePathPrefix, tabsReducer, type MainFileTab } from './useMainFileTabs';

function tab(name: string): MainFileTab {
  const path = `/project/src/${name}`;
  return {
    id: `workspace:${path}`,
    file: { name, path, displayPath: `/workspace/src/${name}` },
    displayPath: `/workspace/src/${name}`,
    kind: 'editor',
    dirty: false,
    isReadOnly: false,
    workspaceRoot: '/project',
  };
}

test('opening the same file focuses its existing tab without losing unsaved state', () => {
  const first = tab('one.ts');
  const second = tab('two.ts');
  let state = tabsReducer({ tabs: [], activeId: null }, { type: 'open', tab: first });
  state = tabsReducer(state, { type: 'dirty', id: first.id, dirty: true });
  assert.strictEqual(tabsReducer(state, { type: 'dirty', id: first.id, dirty: true }), state);
  state = tabsReducer(state, { type: 'open', tab: second });
  state = tabsReducer(state, { type: 'open', tab: tab('one.ts') });
  assert.equal(state.tabs.length, 2);
  assert.equal(state.activeId, first.id);
  assert.equal(state.tabs[0].dirty, true);
});

test('closing the active tab selects its right neighbor, then its left neighbor', () => {
  const first = tab('one.ts');
  const second = tab('two.ts');
  const third = tab('three.ts');
  const state = { tabs: [first, second, third], activeId: second.id };
  const afterMiddle = tabsReducer(state, { type: 'close', ids: [second.id] });
  assert.equal(afterMiddle.activeId, third.id);
  const afterRight = tabsReducer(afterMiddle, { type: 'close', ids: [third.id] });
  assert.equal(afterRight.activeId, first.id);
});

test('leaving a module clears its tab list and active selection', () => {
  const opened = tabsReducer({ tabs: [], activeId: null }, { type: 'open', tab: tab('one.ts') });
  const cleared = tabsReducer(opened, { type: 'clear' });
  assert.deepEqual(cleared, { tabs: [], activeId: null });
});

test('display paths and directory renames retain the workspace-relative identity', () => {
  const file: CodeEditorFile = { name: 'view.tsx', path: '/project/src/views/view.tsx' };
  assert.equal(displayPathFor(file, '/project'), '/workspace/src/views/view.tsx');
  assert.equal(
    replacePathPrefix('/workspace/src/views/view.tsx', '/workspace/src/views', '/workspace/src/screens'),
    '/workspace/src/screens/view.tsx',
  );
  assert.equal(
    replacePathPrefix('/workspace/src/views-old/view.tsx', '/workspace/src/views', '/workspace/src/screens'),
    '/workspace/src/views-old/view.tsx',
  );
});
