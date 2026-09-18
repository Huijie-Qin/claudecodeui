import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appendClaudeCompletedReply, readClaudeCompletedReplies } from './claude-fork-checkpoint-store.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const first = '22222222-2222-4222-8222-222222222222';
const second = '33333333-3333-4333-8333-333333333333';

async function fixture(t) {
  const runtimeHomePath = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-checkpoint-store-'));
  t.after(() => fs.rm(runtimeHomePath, { recursive: true, force: true }));
  return { runtimeHomePath, projectPath: '/workspace', sessionId };
}

test('completion markers survive concurrent writes before the native transcript flushes', async t => {
  const options = await fixture(t);
  await Promise.all([first, second, first].map(sourceMessageUuid => appendClaudeCompletedReply({ ...options, sourceMessageUuid })));
  assert.deepEqual([...await readClaudeCompletedReplies(options)].sort(), [first, second].sort());
  const directory = path.join(options.runtimeHomePath, '.claude', 'projects', '-workspace', sessionId);
  const filePath = path.join(directory, 'completed-replies.jsonl');
  const homeStat = await fs.stat(options.runtimeHomePath);
  const fileStat = await fs.stat(filePath);
  assert.equal(fileStat.mode & 0o777, 0o600);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal(fileStat.uid, homeStat.uid);
  assert.equal(fileStat.gid, homeStat.gid);
  await fs.appendFile(filePath, '\n{"version":');
  assert.deepEqual([...await readClaudeCompletedReplies(options)].sort(), [first, second].sort());
  assert.deepEqual([...await readClaudeCompletedReplies({ ...options, sessionId: second })], []);
});

test('checkpoint storage rejects traversal identifiers and symlinked files or directories', async t => {
  const options = await fixture(t);
  assert.equal(await appendClaudeCompletedReply({ ...options, sourceMessageUuid: first, sessionId: '../outside' }), false);
  await appendClaudeCompletedReply({ ...options, sourceMessageUuid: first });
  const directory = path.join(options.runtimeHomePath, '.claude', 'projects', '-workspace', sessionId);
  const filePath = path.join(directory, 'completed-replies.jsonl');
  const outside = path.join(options.runtimeHomePath, 'outside');
  await fs.writeFile(outside, 'unchanged');
  await fs.unlink(filePath);
  await fs.symlink(outside, filePath);
  await assert.rejects(appendClaudeCompletedReply({ ...options, sourceMessageUuid: second }));
  await assert.rejects(readClaudeCompletedReplies(options));
  assert.equal(await fs.readFile(outside, 'utf8'), 'unchanged');
  await fs.unlink(filePath);
  await fs.rmdir(directory);
  await fs.symlink(options.runtimeHomePath, directory);
  await assert.rejects(appendClaudeCompletedReply({ ...options, sourceMessageUuid: second }));
  await assert.rejects(readClaudeCompletedReplies(options));
});
