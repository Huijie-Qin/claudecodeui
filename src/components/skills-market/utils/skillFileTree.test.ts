import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkspaceSkillEntry } from './skillFormatting';
import {
  buildChildPath,
  buildRenamedPath,
  createSkillTreeNodes,
  getNewEntryParentPath,
  getSkillDirectoryPaths,
  getVisibleSkillTreeNodes,
  validateSkillEntryName,
} from './skillFileTree';

const entries: WorkspaceSkillEntry[] = [
  { path: 'SKILL.md', type: 'file' },
  { path: 'references/checklist.md', type: 'file' },
  { path: 'references/nested/notes.md', type: 'file' },
  { path: 'scripts', type: 'directory' },
];

test('createSkillTreeNodes creates explicit and implied directory nodes', () => {
  const nodes = createSkillTreeNodes(entries);
  assert.deepEqual(nodes.map(({ path, type, depth }) => ({ path, type, depth })), [
    { path: 'references', type: 'directory', depth: 0 },
    { path: 'references/nested', type: 'directory', depth: 1 },
    { path: 'references/nested/notes.md', type: 'file', depth: 2 },
    { path: 'references/checklist.md', type: 'file', depth: 1 },
    { path: 'scripts', type: 'directory', depth: 0 },
    { path: 'SKILL.md', type: 'file', depth: 0 },
  ]);
  assert.deepEqual(getSkillDirectoryPaths(nodes), ['references', 'references/nested', 'scripts']);
});

test('getVisibleSkillTreeNodes hides every descendant of collapsed directories', () => {
  const nodes = createSkillTreeNodes(entries);
  assert.deepEqual(
    getVisibleSkillTreeNodes(nodes, new Set(['references'])).map((node) => node.path),
    ['references', 'references/nested', 'references/checklist.md', 'scripts', 'SKILL.md'],
  );
  assert.deepEqual(
    getVisibleSkillTreeNodes(nodes, new Set()).map((node) => node.path),
    ['references', 'scripts', 'SKILL.md'],
  );
});

test('getNewEntryParentPath follows folder, file sibling, and root rules', () => {
  const nodes = createSkillTreeNodes(entries);
  assert.equal(getNewEntryParentPath(nodes, 'references'), 'references');
  assert.equal(getNewEntryParentPath(nodes, 'references/checklist.md'), 'references');
  assert.equal(getNewEntryParentPath(nodes, 'SKILL.md'), '');
  assert.equal(getNewEntryParentPath(nodes, null), '');
});

test('path helpers preserve the parent and only replace the basename', () => {
  assert.equal(buildChildPath('references', 'new.md'), 'references/new.md');
  assert.equal(buildChildPath('', 'new.md'), 'new.md');
  assert.equal(buildRenamedPath('references/checklist.md', 'review.md'), 'references/review.md');
  assert.equal(buildRenamedPath('scripts', 'tools'), 'tools');
});

test('validateSkillEntryName rejects unsafe names', () => {
  assert.equal(validateSkillEntryName(''), '名称不能为空。');
  assert.equal(validateSkillEntryName('..'), '名称不能是 . 或 ..。');
  assert.equal(validateSkillEntryName('nested/file.md'), '名称不能包含路径分隔符。');
  assert.equal(validateSkillEntryName('nested\\file.md'), '名称不能包含路径分隔符。');
  assert.equal(validateSkillEntryName('bad\u0000name'), '名称不能包含控制字符。');
  assert.equal(validateSkillEntryName('valid-name.md'), null);
});
