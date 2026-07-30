import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  deleteSessionFromProjectsRoot,
  getSessionMessagesFromProjectsRoot,
} from './projects.js';

async function writeJsonl(filePath, rows, trailing = '') {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n${trailing}`, 'utf8');
}

test('runtime Claude history finds the session JSONL and ignores other sessions and an incomplete tail', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-history-'));
  const projectsRoot = path.join(root, '.claude', 'projects');
  const projectDir = path.join(projectsRoot, '-workspace');
  const sessionId = 'session-1';
  await writeJsonl(path.join(projectDir, `${sessionId}.jsonl`), [
    { sessionId, uuid: 'm2', type: 'assistant', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', content: 'two' } },
    { sessionId: 'other-session', uuid: 'other', type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'ignore' } },
    { sessionId, uuid: 'm1', type: 'user', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'one' } },
  ], '{"sessionId":"session-1"');

  const result = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, null, 0);

  assert.equal(result.total, 2);
  assert.deepEqual(result.messages.map((message) => message.uuid), ['m1', 'm2']);
});

test('runtime Claude history reads only the directly named transcript when it exists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-history-direct-'));
  const projectsRoot = path.join(root, '.claude', 'projects');
  const projectDir = path.join(projectsRoot, '-workspace');
  const sessionId = 'session-direct';
  await writeJsonl(path.join(projectDir, `${sessionId}.jsonl`), [{
    sessionId,
    uuid: 'direct-message',
    type: 'user',
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'user', content: 'direct' },
  }]);
  await writeJsonl(path.join(projectDir, 'unrelated.jsonl'), [{
    sessionId,
    uuid: 'must-not-be-read',
    type: 'assistant',
    timestamp: '2026-01-01T00:00:02.000Z',
    message: { role: 'assistant', content: 'legacy duplicate' },
  }]);

  const result = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, null, 0);

  assert.deepEqual(result.messages.map((message) => message.uuid), ['direct-message']);
});

test('runtime Claude history scans legacy transcript names only when the direct file is absent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-history-legacy-'));
  const projectsRoot = path.join(root, '.claude', 'projects');
  const projectDir = path.join(projectsRoot, '-workspace');
  const sessionId = 'session-legacy';
  await writeJsonl(path.join(projectDir, 'legacy-layout.jsonl'), [{
    sessionId,
    uuid: 'legacy-message',
    type: 'user',
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'user', content: 'legacy' },
  }]);

  const result = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, null, 0);

  assert.deepEqual(result.messages.map((message) => message.uuid), ['legacy-message']);
});

test('runtime Claude history keeps newest-first pagination semantics', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-history-page-'));
  const projectsRoot = path.join(root, '.claude', 'projects');
  const projectDir = path.join(projectsRoot, '-workspace');
  const sessionId = 'session-page';
  await writeJsonl(path.join(projectDir, `${sessionId}.jsonl`), [1, 2, 3].map((sequence) => ({
    sessionId,
    uuid: `m${sequence}`,
    type: 'assistant',
    timestamp: `2026-01-01T00:00:0${sequence}.000Z`,
    message: { role: 'assistant', content: String(sequence) },
  })));

  const recent = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, 2, 0);
  const older = await getSessionMessagesFromProjectsRoot(projectsRoot, sessionId, 2, 2);

  assert.deepEqual(recent.messages.map((message) => message.uuid), ['m2', 'm3']);
  assert.equal(recent.hasMore, true);
  assert.deepEqual(older.messages.map((message) => message.uuid), ['m1']);
  assert.equal(older.hasMore, false);
});

test('runtime Claude session deletion removes only the target transcript and session data directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-history-delete-'));
  const projectsRoot = path.join(root, '.claude', 'projects');
  const projectDir = path.join(projectsRoot, '-workspace');
  await writeJsonl(path.join(projectDir, 'session-delete.jsonl'), []);
  await writeJsonl(path.join(projectDir, 'session-keep.jsonl'), []);
  await fs.mkdir(path.join(projectDir, 'session-delete', 'tool-results'), { recursive: true });
  await fs.mkdir(path.join(projectDir, 'session-delete', 'subagents'), { recursive: true });
  await writeJsonl(
    path.join(projectDir, 'session-delete', 'display-commands.jsonl'),
    [{ version: 1, messageId: 'message-1', displayCommand: '/report-skill' }],
  );

  assert.equal(await deleteSessionFromProjectsRoot(projectsRoot, 'session-delete'), true);
  await assert.rejects(fs.access(path.join(projectDir, 'session-delete.jsonl')));
  await assert.rejects(fs.access(path.join(projectDir, 'session-delete')));
  await fs.access(path.join(projectDir, 'session-keep.jsonl'));
});
