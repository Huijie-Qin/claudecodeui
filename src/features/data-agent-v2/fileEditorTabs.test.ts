import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../../types/app';
import {
  createFileEditorTab,
  fileEditorTabsReducer,
  getFileTabsStorageKey,
  isFileTabWithinPath,
  parsePersistedFileEditorTabs,
  replaceFileTabPathPrefix,
  serializeFileEditorTabs,
  type FileEditorTabsState,
} from './fileEditorTabs';

const project = {
  name: 'demo',
  displayName: 'Demo',
  path: '/srv/workspaces/demo',
  fullPath: '/srv/workspaces/demo',
  workspaceId: 42,
} as Project;

function open(state: FileEditorTabsState, path: string) {
  return fileEditorTabsReducer(state, { type: 'open', tab: createFileEditorTab(project, path) });
}

test('opening an existing path activates it without creating a duplicate tab', () => {
  let state: FileEditorTabsState = { tabs: [], activeId: null };
  state = open(state, '/workspace/src/a.ts');
  state = open(state, '/workspace/src/b.ts');
  state = open(state, '/workspace/src/a.ts');

  assert.equal(state.tabs.length, 2);
  assert.equal(state.activeId, state.tabs[0].id);
  assert.equal(state.tabs[0].file.path, '/srv/workspaces/demo/src/a.ts');

  const absoluteTab = createFileEditorTab(project, '/srv/workspaces/demo/src/absolute.ts');
  assert.equal(absoluteTab.file.path, '/srv/workspaces/demo/src/absolute.ts');
  assert.equal(absoluteTab.displayPath, '/workspace/src/absolute.ts');
});

test('closing the active tab selects the right neighbor before the left neighbor', () => {
  let state: FileEditorTabsState = { tabs: [], activeId: null };
  state = open(state, 'a.ts');
  state = open(state, 'b.ts');
  state = open(state, 'c.ts');
  state = fileEditorTabsReducer(state, { type: 'activate', id: state.tabs[1].id });
  state = fileEditorTabsReducer(state, { type: 'close', ids: [state.tabs[1].id] });
  assert.equal(state.tabs.find((tab) => tab.id === state.activeId)?.file.name, 'c.ts');

  state = fileEditorTabsReducer(state, { type: 'close', ids: [state.activeId!] });
  assert.equal(state.tabs.find((tab) => tab.id === state.activeId)?.file.name, 'a.ts');
});

test('tab order is stable and serializes without dirty content', () => {
  let state: FileEditorTabsState = { tabs: [], activeId: null };
  state = open(state, 'a.ts');
  state = open(state, 'b.ts');
  state = open(state, 'c.ts');
  state = fileEditorTabsReducer(state, { type: 'reorder', sourceId: state.tabs[2].id, targetId: state.tabs[0].id });
  state = fileEditorTabsReducer(state, { type: 'dirty', id: state.tabs[0].id, dirty: true });

  const persisted = serializeFileEditorTabs(state);
  assert.deepEqual(persisted.paths, ['/workspace/c.ts', '/workspace/a.ts', '/workspace/b.ts']);
  assert.equal(JSON.stringify(persisted).includes('dirty'), false);
});

test('bulk close operations retain their intended active tab', () => {
  let state: FileEditorTabsState = { tabs: [], activeId: null };
  state = open(state, 'a.ts');
  state = open(state, 'b.ts');
  state = open(state, 'c.ts');
  state = open(state, 'd.ts');

  const bId = state.tabs[1].id;
  state = fileEditorTabsReducer(state, { type: 'activate', id: bId });
  state = fileEditorTabsReducer(state, { type: 'close', ids: state.tabs.slice(2).map((tab) => tab.id) });
  assert.deepEqual(state.tabs.map((tab) => tab.file.name), ['a.ts', 'b.ts']);
  assert.equal(state.activeId, bId);

  state = fileEditorTabsReducer(state, { type: 'close', ids: [state.tabs[0].id] });
  assert.deepEqual(state.tabs.map((tab) => tab.file.name), ['b.ts']);
  assert.equal(state.activeId, bId);
});

test('persistence keys isolate workspaces', () => {
  assert.notEqual(getFileTabsStorageKey(project), getFileTabsStorageKey({ ...project, workspaceId: 43 }));
});

test('persisted tabs reject damaged data and normalize duplicate paths', () => {
  assert.equal(parsePersistedFileEditorTabs('{broken'), null);
  assert.equal(parsePersistedFileEditorTabs(JSON.stringify({ version: 2, paths: [] })), null);

  const parsed = parsePersistedFileEditorTabs(JSON.stringify({
    version: 1,
    paths: ['src/a.ts', '/workspace/src/a.ts', '/workspace/src/b.ts'],
    activePath: '/workspace/missing.ts',
  }));
  assert.deepEqual(parsed, {
    version: 1,
    paths: ['/workspace/src/a.ts', '/workspace/src/b.ts'],
    activePath: '/workspace/src/a.ts',
  });
});

test('directory rename and delete matching include descendant tabs', () => {
  assert.equal(
    replaceFileTabPathPrefix('/workspace/src/utils/a.ts', '/workspace/src', '/workspace/lib'),
    '/workspace/lib/utils/a.ts',
  );
  assert.equal(isFileTabWithinPath('/workspace/src/utils/a.ts', '/workspace/src'), true);
  assert.equal(isFileTabWithinPath('/workspace/source/a.ts', '/workspace/src'), false);
});
