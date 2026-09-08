import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getFileTree } from './workspace-file-tree.js';

test('getFileTree returns sorted metadata without following directory symlinks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-file-tree-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.mkdir(path.join(root, 'z-dir'));
  await fs.writeFile(path.join(root, 'z-dir', 'nested.txt'), 'nested');
  await fs.writeFile(path.join(root, 'a.txt'), 'hello');
  await fs.symlink(path.join(root, 'z-dir'), path.join(root, 'linked-dir'));
  await fs.mkdir(path.join(root, '.cloudcli'));
  await fs.writeFile(path.join(root, '.cloudcli', 'hidden.txt'), 'hidden');

  const tree = await getFileTree(root, 10);

  assert.deepEqual(tree.map((item) => item.name), ['z-dir', 'a.txt', 'linked-dir']);
  assert.equal(tree[0].type, 'directory');
  assert.deepEqual(tree[0].children.map((item) => item.name), ['nested.txt']);
  assert.equal(tree[1].size, 5);
  assert.equal(tree[2].type, 'file');
  assert.equal('children' in tree[2], false);
});

test('getFileTree stops promptly when its signal is aborted', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    getFileTree(process.cwd(), 10, 0, false, { signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  );
});
