import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { forkClaudeSessionFiles, readClaudeForkSource } from './claude-session-fork-files.js';

async function fixture(t, extraEntries = []) {
  const runtimeHomePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-fork-files-'));
  t.after(() => fs.rm(runtimeHomePath, { recursive: true, force: true }));
  const sourceSessionId = randomUUID();
  const projectDirectory = path.join(runtimeHomePath, '.claude', 'projects', '-workspace');
  await fs.mkdir(projectDirectory, { recursive: true });
  const ids = Array.from({ length: 8 }, () => randomUUID());
  const sourceEntries = [
    { type: 'user', uuid: ids[0], parentUuid: null, message: { role: 'user', content: 'first question' } },
    { type: 'assistant', uuid: ids[1], parentUuid: ids[0], message: { id: 'msg_tool', role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: 'README.md' } }] } },
    { type: 'user', uuid: ids[2], parentUuid: ids[1], message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'old file content' }] } },
    { type: 'assistant', uuid: ids[3], parentUuid: ids[2], isSidechain: true, message: { role: 'assistant', content: 'private child trace' } },
    ...extraEntries.map((entry) => typeof entry === 'function' ? entry(ids) : entry),
    { type: 'assistant', uuid: ids[4], parentUuid: ids[2], message: { id: 'msg_answer', role: 'assistant', content: 'first answer', stop_reason: 'end_turn' } },
    { type: 'user', uuid: ids[5], parentUuid: ids[4], message: { role: 'user', content: 'later question' } },
    { type: 'assistant', uuid: ids[6], parentUuid: ids[5], message: { role: 'assistant', content: 'later answer', stop_reason: 'end_turn' } },
    { type: 'file-history-snapshot', uuid: ids[7], snapshot: { trackedFileBackups: { secret: 'backup' } } },
  ].map((entry) => ({ sessionId: sourceSessionId, timestamp: '2026-09-18T01:00:00.000Z', ...entry }));
  const filePath = path.join(projectDirectory, `${sourceSessionId}.jsonl`);
  const write = async () => fs.writeFile(filePath, `${sourceEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  await write();
  return { runtimeHomePath, projectDirectory, sourceSessionId, sourceMessageUuid: ids[4], sourceEntries, ids, filePath, write };
}

test('actual SDK forks a cutoff snapshot with tool results, fresh links, private ownership, and cleanup', async (t) => {
  const context = await fixture(t);
  const original = await fs.readFile(context.filePath, 'utf8');
  const envBefore = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  const result = await forkClaudeSessionFiles({ ...context, title: 'A new direction' });
  assert.notEqual(result.sessionId, context.sourceSessionId);
  assert.deepEqual({ HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }, envBefore);
  assert.equal(await fs.readFile(context.filePath, 'utf8'), original);
  assert.equal(result.messageUuidMap.size, 4);
  assert.equal(result.forkEntries.length, 5);
  const messages = result.forkEntries.filter((entry) => entry.forkedFrom);
  assert.equal(messages[0].parentUuid, null);
  assert.equal(messages[1].parentUuid, messages[0].uuid);
  assert.equal(messages[2].parentUuid, messages[1].uuid);
  assert.equal(messages[3].parentUuid, messages[2].uuid);
  assert.equal(messages[2].message.content[0].content, 'old file content');
  assert.equal(messages[3].message.content, 'first answer');
  assert.equal(result.forkEntries.at(-1).customTitle, 'A new direction');
  assert.ok(messages.every((entry) => entry.sessionId === result.sessionId && !entry.isSidechain));
  assert.ok(!JSON.stringify(result.forkEntries).includes('later question'));
  assert.ok(!JSON.stringify(result.forkEntries).includes('private child trace'));
  assert.ok(!JSON.stringify(result.forkEntries).includes('trackedFileBackups'));
  const forkPath = path.join(result.projectDirectory, `${result.sessionId}.jsonl`);
  const sourceStat = await fs.stat(context.filePath);
  const forkStat = await fs.stat(forkPath);
  assert.equal(forkStat.mode & 0o777, 0o600);
  assert.equal(forkStat.uid, sourceStat.uid);
  assert.equal(forkStat.gid, sourceStat.gid);
  await result.cleanup();
  await result.cleanup();
  await assert.rejects(fs.stat(forkPath), { code: 'ENOENT' });
  assert.equal(await fs.readFile(context.filePath, 'utf8'), original);
});

test('remaps preserved compaction UUIDs and excludes replacements written after the cutoff', async (t) => {
  const context = await fixture(t, [
    (ids) => ({ type: 'system', subtype: 'compact_boundary', uuid: randomUUID(), parentUuid: ids[2],
      compactMetadata: { preservedMessages: { anchorUuid: ids[0], uuids: [ids[1], ids[2]] } } }),
    (ids) => ({ type: 'content-replacement', uuid: randomUUID(), replacements: [{ messageUuid: ids[2], content: 'replacement before fork' }] }),
  ]);
  context.sourceEntries.push({ type: 'content-replacement', sessionId: context.sourceSessionId,
    replacements: [{ messageUuid: context.ids[2], content: 'secret future replacement' }] });
  await context.write();
  const result = await forkClaudeSessionFiles(context);
  const compact = result.forkEntries.find((entry) => entry.subtype === 'compact_boundary');
  assert.deepEqual(compact.compactMetadata.preservedMessages, {
    anchorUuid: result.messageUuidMap.get(context.ids[0]),
    uuids: [result.messageUuidMap.get(context.ids[1]), result.messageUuidMap.get(context.ids[2])],
  });
  const replacements = result.forkEntries.filter((entry) => entry.type === 'content-replacement');
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].replacements[0].messageUuid, result.messageUuidMap.get(context.ids[2]));
  assert.equal(replacements[0].forkedFrom.sessionId, context.sourceSessionId);
  assert.ok(!JSON.stringify(result.forkEntries).includes('secret future replacement'));
});

test('copies only inherited display commands and maps user UUIDs and assistant anchors', async (t) => {
  const context = await fixture(t);
  const sourceDirectory = path.join(context.projectDirectory, context.sourceSessionId);
  await fs.mkdir(sourceDirectory);
  await fs.writeFile(path.join(sourceDirectory, 'display-commands.jsonl'), [
    { version: 1, messageId: context.ids[0], displayCommand: '/skill' },
    { version: 1, messageId: context.ids[2], displayAfterAssistantId: 'msg_tool', supplementSequence: 1 },
    { version: 1, messageId: context.ids[5], displayCommand: '/future' },
    { version: 1, messageId: context.ids[3], displayCommand: '/child' },
  ].map((entry) => JSON.stringify(entry)).join('\n'));
  await fs.mkdir(path.join(sourceDirectory, 'subagents'));
  await fs.writeFile(path.join(sourceDirectory, 'subagents', 'agent-future.jsonl'), 'future subagent');
  const result = await forkClaudeSessionFiles(context);
  const forkDirectory = path.join(result.projectDirectory, result.sessionId);
  const entries = (await fs.readFile(path.join(forkDirectory, 'display-commands.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].messageId, result.messageUuidMap.get(context.ids[0]));
  assert.equal(entries[1].messageId, result.messageUuidMap.get(context.ids[2]));
  assert.equal(entries[1].displayAfterAssistantId, 'msg_tool');
  assert.ok(entries.every((entry) => entry.forkedFrom.sessionId === context.sourceSessionId));
  assert.equal((await fs.stat(forkDirectory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(forkDirectory, 'display-commands.jsonl'))).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(path.join(forkDirectory, 'subagents')), { code: 'ENOENT' });
  await result.cleanup();
  await assert.rejects(fs.stat(forkDirectory), { code: 'ENOENT' });
});

test('rejects stale snapshots, invalid IDs, missing replies, sidechain replies, and forged snapshots', async (t) => {
  const context = await fixture(t);
  await assert.rejects(forkClaudeSessionFiles({ ...context, sourceSessionId: '../escape' }), { statusCode: 400 });
  await assert.rejects(forkClaudeSessionFiles({ ...context, sourceMessageUuid: randomUUID() }), { statusCode: 400 });
  await assert.rejects(forkClaudeSessionFiles({ ...context, sourceMessageUuid: context.ids[3] }), { statusCode: 400 });
  await assert.rejects(forkClaudeSessionFiles({ ...context, source: {} }), { statusCode: 400 });
  const source = await readClaudeForkSource(context);
  await fs.appendFile(context.filePath, '\n');
  await assert.rejects(forkClaudeSessionFiles({ ...context, source }), /changed/);
  assert.deepEqual(await fs.readdir(context.projectDirectory), [`${context.sourceSessionId}.jsonl`]);
});

test('rejects symlink files and symlinked projects and ambiguous session paths', async (t) => {
  const context = await fixture(t);
  const realFile = path.join(context.runtimeHomePath, 'outside.jsonl');
  await fs.rename(context.filePath, realFile);
  await fs.symlink(realFile, context.filePath);
  await assert.rejects(readClaudeForkSource(context), /unsafe/);
  await fs.unlink(context.filePath);
  await fs.rename(realFile, context.filePath);
  const linkedProject = `${context.projectDirectory}-linked`;
  await fs.rename(context.projectDirectory, linkedProject);
  await fs.symlink(linkedProject, context.projectDirectory);
  // A direct real project remains readable, while the symlink is never followed.
  const source = await readClaudeForkSource(context);
  assert.equal(source.projectDirectory, await fs.realpath(linkedProject));
  await fs.unlink(context.projectDirectory);
  await fs.mkdir(context.projectDirectory);
  await fs.copyFile(path.join(linkedProject, `${context.sourceSessionId}.jsonl`), context.filePath);
  await assert.rejects(readClaudeForkSource(context), /ambiguous/);
});

test('rejects symlinked display metadata and invalid preserved compaction references before writing', async (t) => {
  const context = await fixture(t, [() => ({ type: 'system', subtype: 'compact_boundary', uuid: randomUUID(),
    compactMetadata: { preservedSegment: { anchorUuid: randomUUID(), headUuid: randomUUID(), tailUuid: randomUUID() } } })]);
  await assert.rejects(forkClaudeSessionFiles(context), /incomplete preserved messages/);
  assert.equal((await fs.readdir(context.projectDirectory)).length, 1);
  context.sourceEntries.splice(4, 1);
  await context.write();
  await fs.symlink(context.runtimeHomePath, path.join(context.projectDirectory, context.sourceSessionId));
  await assert.rejects(forkClaudeSessionFiles(context), /unsafe/);
  assert.equal((await fs.readdir(context.projectDirectory)).length, 2);
});

test('failed publication removes its temporary file and sidecar without altering existing sessions', async (t) => {
  const context = await fixture(t);
  const sourceDirectory = path.join(context.projectDirectory, context.sourceSessionId);
  await fs.mkdir(sourceDirectory);
  await fs.writeFile(path.join(sourceDirectory, 'display-commands.jsonl'), JSON.stringify({
    messageId: context.ids[0], displayCommand: '/skill',
  }));
  const original = await fs.readFile(context.filePath, 'utf8');
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('Simulated publication failure'), { code: 'EIO' }); });
  await assert.rejects(forkClaudeSessionFiles(context), /Simulated publication failure/);
  assert.deepEqual((await fs.readdir(context.projectDirectory)).sort(), [context.sourceSessionId, `${context.sourceSessionId}.jsonl`].sort());
  assert.equal(await fs.readFile(context.filePath, 'utf8'), original);
});

test('missing runtime histories return a not-found error', async (t) => {
  const context = await fixture(t);
  await fs.rm(path.join(context.runtimeHomePath, '.claude'), { recursive: true });
  await assert.rejects(readClaudeForkSource(context), { statusCode: 404, code: 'CLAUDE_FORK_NOT_FOUND' });
});

test('inherits completed reply markers by UUID including the selected reply completed after its message timestamp', async (t) => {
  const context = await fixture(t);
  const sourceDirectory = path.join(context.projectDirectory, context.sourceSessionId);
  await fs.mkdir(sourceDirectory);
  const completedAt = '2026-09-18T01:00:03.000Z';
  await fs.writeFile(path.join(sourceDirectory, 'completed-replies.jsonl'), [
    { version: 1, sourceMessageUuid: context.sourceMessageUuid, completedAt },
    { version: 1, sourceMessageUuid: context.ids[6], completedAt: '2026-09-18T01:00:10.000Z' },
    { version: 1, sourceMessageUuid: context.ids[3], completedAt },
    { version: 1, sourceMessageUuid: context.sourceMessageUuid, completedAt: 'invalid' },
  ].map((entry) => JSON.stringify(entry)).join('\n'));
  const result = await forkClaudeSessionFiles(context);
  const forkDirectory = path.join(result.projectDirectory, result.sessionId);
  const markerPath = path.join(forkDirectory, 'completed-replies.jsonl');
  const records = (await fs.readFile(markerPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records, [{ version: 1,
    sourceMessageUuid: result.messageUuidMap.get(context.sourceMessageUuid),
    completedAt,
    forkedFrom: { sessionId: context.sourceSessionId, messageUuid: context.sourceMessageUuid },
  }]);
  assert.equal((await fs.stat(markerPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(forkDirectory)).mode & 0o777, 0o700);
  await result.cleanup();
  await assert.rejects(fs.stat(forkDirectory), { code: 'ENOENT' });
});
