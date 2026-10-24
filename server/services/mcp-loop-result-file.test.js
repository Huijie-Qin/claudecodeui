import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeMcpLoopResultFile } from './mcp-loop-result-file.js';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-loop-result-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  await fs.mkdir(workspaceRoot);
  const job = { id: 'job-1', workspaceRoot, toolUseId: 'tool-1', status: 'succeeded',
    attemptCount: 3, startedAtMs: 1_000, completedAtMs: 2_500, lastResult: { value: 'PRIVATE_RESULT' } };
  return { root, workspaceRoot, job };
}

test('terminal results retain business payload and status only in the file', async (t) => {
  for (const status of ['succeeded', 'failed', 'timed_out', 'cancelled']) {
    await t.test(status, async (subtest) => {
      const { job } = await fixture(subtest);
      job.status = status;
      if (status !== 'succeeded') job.error = `PRIVATE_${status}`;
      const reference = await writeMcpLoopResultFile(job);
      assert.deepEqual(Object.keys(reference), ['resultFile']);
      assert.equal(JSON.stringify(reference).includes('PRIVATE'), false);
      assert.deepEqual(JSON.parse(await fs.readFile(reference.resultFile, 'utf8')), {
        mcpLoop: true, replacesToolUseId: 'tool-1', status, attempts: 3, elapsedMs: 1_500,
        result: { value: 'PRIVATE_RESULT' }, ...(job.error ? { error: job.error } : {}),
      });
    });
  }
});

test('repeated writes retain the same path and different jobs cannot overwrite each other', async (t) => {
  const { job } = await fixture(t);
  const first = await writeMcpLoopResultFile(job);
  const second = await writeMcpLoopResultFile({ ...job, lastResult: { value: 'updated' } });
  const other = await writeMcpLoopResultFile({ ...job, id: 'job-2' });
  assert.deepEqual(second, first);
  assert.notEqual(other.resultFile, first.resultFile);
  assert.equal(JSON.parse(await fs.readFile(first.resultFile, 'utf8')).result.value, 'updated');
  assert.equal(JSON.parse(await fs.readFile(other.resultFile, 'utf8')).result.value, 'PRIVATE_RESULT');
  assert.deepEqual((await fs.readdir(path.dirname(first.resultFile))).sort(), ['job-1.json', 'job-2.json']);
});

test('Docker references use the mounted workspace and persisted files are runtime-readable', async (t) => {
  const { workspaceRoot, job } = await fixture(t);
  await fs.mkdir(path.join(workspaceRoot, '.cloudcli'), { mode: 0o700 });
  const reference = await writeMcpLoopResultFile(job, { mode: 'docker' });
  assert.equal(reference.resultFile, '/workspace/.cloudcli/hook-results/mcp-loops/job-1.json');
  const hostDirectory = path.join(workspaceRoot, '.cloudcli', 'hook-results', 'mcp-loops');
  assert.equal((await fs.stat(path.join(hostDirectory, 'job-1.json'))).mode & 0o777, 0o644);
  assert.equal((await fs.stat(hostDirectory)).mode & 0o777, 0o755);
  assert.equal((await fs.stat(path.dirname(hostDirectory))).mode & 0o777, 0o755);
  assert.equal((await fs.stat(path.join(workspaceRoot, '.cloudcli'))).mode & 0o777, 0o711);
  assert.equal(JSON.parse(await fs.readFile(path.join(hostDirectory, 'job-1.json'), 'utf8')).result.value, 'PRIVATE_RESULT');
});

test('unsafe job IDs, relative roots, and nonterminal jobs cannot create result files', async (t) => {
  const { workspaceRoot, job } = await fixture(t);
  for (const id of ['', '.', '..', '../escape', '/escape', 'a/b', 'a\\b', 'job\nfake', 'a'.repeat(129)]) {
    await assert.rejects(writeMcpLoopResultFile({ ...job, id }), /safe job ID/);
  }
  await assert.rejects(writeMcpLoopResultFile({ ...job, workspaceRoot: '.' }), /absolute workspace root/);
  await assert.rejects(writeMcpLoopResultFile({ ...job, status: 'running' }), /not terminal/);
  await assert.rejects(writeMcpLoopResultFile(job, { mode: 'unknown' }), /runtime mode/);
  assert.deepEqual(await fs.readdir(workspaceRoot), []);
});

test('symlinked result ancestors and destinations cannot redirect writes', async (t) => {
  for (const segments of [['.cloudcli'], ['.cloudcli', 'hook-results'], ['.cloudcli', 'hook-results', 'mcp-loops']]) {
    await t.test(segments.join('/'), async (subtest) => {
      const { root, workspaceRoot, job } = await fixture(subtest);
      const outside = path.join(root, 'outside');
      await fs.mkdir(outside);
      const target = path.join(workspaceRoot, ...segments);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(outside, target);
      await assert.rejects(writeMcpLoopResultFile(job), /not a safe directory/);
      assert.deepEqual(await fs.readdir(outside), []);
    });
  }
  await t.test('workspace root', async (subtest) => {
    const { root, workspaceRoot, job } = await fixture(subtest);
    const link = path.join(root, 'workspace-link');
    await fs.symlink(workspaceRoot, link);
    await assert.rejects(writeMcpLoopResultFile({ ...job, workspaceRoot: link }), /not a safe directory/);
    assert.deepEqual(await fs.readdir(workspaceRoot), []);
  });
  await t.test('destination', async (subtest) => {
    const { root, job } = await fixture(subtest);
    const first = await writeMcpLoopResultFile(job);
    const outside = path.join(root, 'outside.json');
    await fs.writeFile(outside, 'unchanged');
    await fs.unlink(first.resultFile);
    await fs.symlink(outside, first.resultFile);
    await assert.rejects(writeMcpLoopResultFile(job), /not a safe file/);
    assert.equal(await fs.readFile(outside, 'utf8'), 'unchanged');
  });
});

test('failed serialization never produces a result reference or partial file', async (t) => {
  const { workspaceRoot, job } = await fixture(t);
  const circular = {};
  circular.self = circular;
  await assert.rejects(writeMcpLoopResultFile({ ...job, lastResult: circular }), /circular/i);
  assert.deepEqual(await fs.readdir(workspaceRoot), []);
});

test('an unwritable workspace fails without claiming a saved result', { skip: process.getuid?.() === 0 }, async (t) => {
  const { workspaceRoot, job } = await fixture(t);
  await fs.chmod(workspaceRoot, 0o555);
  try {
    await assert.rejects(writeMcpLoopResultFile(job), { code: 'EACCES' });
    assert.deepEqual(await fs.readdir(workspaceRoot), []);
  } finally {
    await fs.chmod(workspaceRoot, 0o700);
  }
});
