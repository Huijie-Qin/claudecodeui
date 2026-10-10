import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveWorkspaceFileReadPath } from './workspace-file-read-path.js';

async function fixture(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-file-read-path-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, 'workspace');
  const privateWorkspace = path.join(temporary, 'workspace-private');
  await Promise.all([fs.mkdir(path.join(workspace, 'nested'), { recursive: true }), fs.mkdir(privateWorkspace)]);
  const file = path.join(workspace, 'nested', '报表.xlsx');
  const privateFile = path.join(privateWorkspace, 'private.xlsx');
  await Promise.all([fs.writeFile(file, 'public workbook bytes'), fs.writeFile(privateFile, 'private workbook bytes')]);
  return { temporary, workspace, privateWorkspace, file, privateFile };
}

test('resolves ordinary absolute and relative file paths', async (t) => {
  const f = await fixture(t);
  assert.equal(await resolveWorkspaceFileReadPath(f.workspace, f.file), f.file);
  assert.equal(await resolveWorkspaceFileReadPath(f.workspace, 'nested/报表.xlsx'), f.file);
});

test('follows file and ancestor symlinks that stay inside the workspace', async (t) => {
  const f = await fixture(t);
  const fileAlias = path.join(f.workspace, 'sample.xlsx');
  const directoryAlias = path.join(f.workspace, 'linked-directory');
  await fs.symlink(f.file, fileAlias);
  await fs.symlink(path.dirname(f.file), directoryAlias, 'dir');
  assert.equal(await resolveWorkspaceFileReadPath(f.workspace, fileAlias), f.file);
  assert.equal(await resolveWorkspaceFileReadPath(f.workspace, path.join(directoryAlias, '报表.xlsx')), f.file);
});

test('rejects file symlinks into another workspace', async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.workspace, 'escape.xlsx');
  await fs.symlink(f.privateFile, alias);
  await assert.rejects(resolveWorkspaceFileReadPath(f.workspace, alias), { statusCode: 403 });
});

test('rejects ancestor directory symlinks into another workspace', async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.workspace, 'escape-directory');
  await fs.symlink(f.privateWorkspace, alias, 'dir');
  await assert.rejects(resolveWorkspaceFileReadPath(f.workspace, path.join(alias, 'private.xlsx')), { statusCode: 403 });
});

test('supports an authorized workspace root that itself has a filesystem alias', async (t) => {
  const f = await fixture(t);
  const rootAlias = path.join(f.temporary, 'workspace-alias');
  await fs.symlink(f.workspace, rootAlias, 'dir');
  assert.equal(await resolveWorkspaceFileReadPath(rootAlias, path.join(rootAlias, 'nested/报表.xlsx')), f.file);
});

test('rejects lexical traversal and sibling paths sharing a root prefix', async (t) => {
  const f = await fixture(t);
  await assert.rejects(resolveWorkspaceFileReadPath(f.workspace, '../workspace-private/private.xlsx'), { statusCode: 403 });
  await assert.rejects(resolveWorkspaceFileReadPath(f.workspace, f.privateFile), { statusCode: 403 });
});

test('returns 404 for missing files and broken internal symlinks', async (t) => {
  const f = await fixture(t);
  const missing = path.join(f.workspace, 'missing.xlsx');
  const broken = path.join(f.workspace, 'broken.xlsx');
  await fs.symlink(missing, broken);
  await assert.rejects(resolveWorkspaceFileReadPath(f.workspace, missing), { statusCode: 404 });
  await assert.rejects(resolveWorkspaceFileReadPath(f.workspace, broken), { statusCode: 404 });
});

test('confines runtime-mounted previews to the chosen runtime projects boundary', async (t) => {
  const f = await fixture(t);
  const runtimeRoot = path.join(f.temporary, 'runtime', 'tenant', 'user', 'workspace', 'home', '.claude', 'projects');
  await fs.mkdir(runtimeRoot, { recursive: true });
  const runtimeFile = path.join(runtimeRoot, 'result.png');
  await fs.writeFile(runtimeFile, 'runtime image bytes');
  assert.equal(await resolveWorkspaceFileReadPath(runtimeRoot, runtimeFile), runtimeFile);
  const escape = path.join(runtimeRoot, 'escape.png');
  await fs.symlink(f.privateFile, escape);
  await assert.rejects(resolveWorkspaceFileReadPath(runtimeRoot, escape), { statusCode: 403 });
});
