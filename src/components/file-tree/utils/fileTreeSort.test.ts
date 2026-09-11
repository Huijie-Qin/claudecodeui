import assert from 'node:assert/strict';
import test from 'node:test';

import type { FileTreeNode, FileTreeSort } from '../types/types';

import { nextFileTreeSort, sortFileTree } from './fileTreeSort';

const files: FileTreeNode[] = [
  { name: 'beta.txt', path: '/beta.txt', type: 'file', modified: '2026-09-11T08:00:00Z' },
  { name: 'zebra.txt', path: '/zebra.txt', type: 'file', modified: '2026-09-11T12:00:00+08:00' },
  { name: 'alpha.txt', path: '/alpha.txt', type: 'file', modified: '2026-09-11T10:00:00Z' },
];
const names = (items: FileTreeNode[]) => items.map((item) => item.name);

test('column clicks switch to defaults and repeated clicks reverse direction', () => {
  let sort: FileTreeSort = { field: 'name', direction: 'asc' };
  for (const [field, direction] of [
    ['modified', 'desc'], ['modified', 'asc'], ['name', 'asc'], ['name', 'desc'], ['modified', 'desc'],
  ] as const) {
    sort = nextFileTreeSort(sort, field);
    assert.deepEqual(sort, { field, direction });
  }
});

test('name and timestamp sorting use only the selected column, in either direction', () => {
  assert.deepEqual(names(sortFileTree(files, { field: 'name', direction: 'asc' })),
    ['alpha.txt', 'beta.txt', 'zebra.txt']);
  assert.deepEqual(names(sortFileTree(files, { field: 'name', direction: 'desc' })),
    ['zebra.txt', 'beta.txt', 'alpha.txt']);
  assert.deepEqual(names(sortFileTree(files, { field: 'modified', direction: 'desc' })),
    ['alpha.txt', 'beta.txt', 'zebra.txt']);
  assert.deepEqual(names(sortFileTree(files, { field: 'modified', direction: 'asc' })),
    ['zebra.txt', 'beta.txt', 'alpha.txt']);
});

test('sorting reaches nested directories, keeps directories first, and leaves source data intact', () => {
  const tree: FileTreeNode[] = [...files, {
    name: 'folder', path: '/folder', type: 'directory', children: files,
  }];
  const original = structuredClone(tree);
  const sorted = sortFileTree(tree, { field: 'modified', direction: 'desc' });
  assert.equal(sorted[0].name, 'folder');
  assert.deepEqual(names(sorted[0].children!), ['alpha.txt', 'beta.txt', 'zebra.txt']);
  assert.deepEqual(tree, original);
});

test('missing or invalid timestamps stay last and equal timestamps keep their input order', () => {
  const items: FileTreeNode[] = [
    { name: 'missing', path: '/missing', type: 'file' },
    files[1],
    { name: 'invalid', path: '/invalid', type: 'file', modified: 'invalid' },
    { ...files[1], name: 'equal', path: '/equal' },
  ];
  for (const direction of ['asc', 'desc'] as const) {
    assert.deepEqual(names(sortFileTree(items, { field: 'modified', direction })),
      ['zebra.txt', 'equal', 'missing', 'invalid']);
  }
});
