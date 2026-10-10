import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';
import express from 'express';

import { DATABASE_SCHEMA_SQL } from '../database/schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';
import { createMultitenancyDb } from '../database/multitenancy-db.js';
import { ClaudeSessionsProvider } from '../modules/providers/list/claude/claude-sessions.provider.js';
import { createSessionForkRouter } from '../routes/session-forks.js';

import { createWorkspaceAccessService } from './workspace-access.js';
import { createSessionMessageHistoryService } from './session-message-history.js';
import { createSessionForkService } from './session-fork.js';
import { mapWorkspaceRowsToProjects } from './workspace-projects.js';
import { createClaudeSessionExecutionQueue } from './claude-session-execution.js';

test('fork API persists an independently reloadable history, preserves source rows, and isolates users', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-fork-integration-'));
  const database = new Database(':memory:');
  t.after(async () => { database.close(); await fs.rm(root, { recursive: true, force: true }); });
  database.exec(DATABASE_SCHEMA_SQL);
  database.exec(MULTITENANCY_SCHEMA_SQL);
  database.prepare('INSERT INTO users(id,username,password_hash) VALUES(1,?,?),(2,?,?)').run('fork-owner', 'dummy', 'fork-editor', 'dummy');
  const mt = createMultitenancyDb(database);
  const tenant = mt.tenants.createTenant({ code: 'fork-test', name: 'Fork Test' });
  for (const userId of [1, 2]) mt.memberships.upsertMembership({ tenantId: tenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({ tenantId: tenant.id, ownerUserId: 1, slug: 'fork-workspace', displayName: 'Fork Workspace', path: path.join(root, 'workspace') });
  mt.workspaceAcl.replaceAcl({ workspaceId: workspace.id, ownerUserId: 1, entries: [{ userId: 2, permission: 'edit' }] });
  const scope = { tenantId: tenant.id, userId: 1, workspaceId: workspace.id, provider: 'claude' };
  const sessionId = randomUUID();
  const runtimeHomePath = path.join(root, 'home');
  const projectDirectory = path.join(runtimeHomePath, '.claude', 'projects', '-workspace');
  await fs.mkdir(projectDirectory, { recursive: true });
  const ids = Array.from({ length: 6 }, () => randomUUID());
  const rows = [
    { type: 'user', message: { role: 'user', content: 'Remember the chosen color: blue.' } },
    { type: 'assistant', message: { id: 'msg-tool', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool-a', name: 'Read', input: { file_path: '/workspace/color.txt' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-a', content: 'blue' }] } },
    { type: 'assistant', message: { id: 'msg-answer', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The chosen color is blue.' }] } },
    { type: 'user', message: { role: 'user', content: 'Later change: red.' } },
    { type: 'assistant', message: { id: 'msg-later', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Changed to red.' }] } },
  ].map((row, index) => ({ ...row, sessionId, uuid: ids[index], parentUuid: ids[index - 1] || null, cwd: '/workspace', timestamp: new Date(Date.UTC(2026, 8, 18, 1, 0, index)).toISOString() }));
  const originalBytes = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const sourcePath = path.join(projectDirectory, `${sessionId}.jsonl`);
  await fs.writeFile(sourcePath, originalBytes);
  const originalSession = mt.sessions.upsertSession({ ...scope, providerSessionId: sessionId, summary: 'Original conversation', status: 'completed', metadata: { scheduledTaskId: 'do-not-inherit' } });
  mt.runtimes.createRuntime({ ...scope, runtimeId: 'fork-runtime', containerName: 'fork-container', image: 'local', workspaceHostPath: workspace.path, runtimeHomePath });
  mt.runtimes.bindProviderSession({ runtimeId: 'fork-runtime', providerSessionId: sessionId });
  mt.runtimes.updateStatus({ runtimeId: 'fork-runtime', status: 'idle' });
  mt.sessionMessages.upsertMessages({ ...scope, providerSessionId: sessionId, runtimeId: 'fork-runtime', messages: [
    { id: 'hook-old', sessionId, provider: 'claude', kind: 'hook_activity', origin: 'hook', jobId: 'hook-old', status: 'succeeded', timestamp: rows[2].timestamp, content: 'Earlier hook' },
    { id: 'hook-future', sessionId, provider: 'claude', kind: 'hook_activity', origin: 'hook', status: 'succeeded', timestamp: rows[5].timestamp, content: 'Later hook' },
  ] });
  const provider = new ClaudeSessionsProvider();
  const history = createSessionMessageHistoryService({ multitenancy: mt, hookConfigs: {}, providerSessions: {
    fetchHistory: (_provider, id, options) => provider.fetchHistory(id, options),
  } });
  const queue = createClaudeSessionExecutionQueue();
  const service = createSessionForkService({ multitenancy: mt, access: createWorkspaceAccessService(mt), history,
    withSessionLock: (options, operation) => queue.run(options.sessionId, operation),
    registerFork: ({ session, runtimeId, messages }) => database.transaction(() => {
      const row = mt.sessions.upsertSession(session);
      mt.sessionMessages.upsertMessages({ ...scope, providerSessionId: session.providerSessionId, runtimeId, messages });
      return row;
    })(),
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: Number(req.headers['x-test-user'] || 1) }; next(); });
  app.use('/api/sessions', createSessionForkRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const port = server.address().port;
  const requestId = randomUUID();
  const post = (userId = 1, overrides = {}) => fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/fork?tenantId=${tenant.id}&workspaceId=${workspace.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': String(userId) },
    body: JSON.stringify({ sourceMessageUuid: ids[3], requestId, ...overrides }),
  });
  assert.equal((await post(2)).status, 404, 'a workspace editor cannot fork another user’s conversation');
  const response = await post();
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  assert.equal(result.session.id, result.sessionId);
  assert.equal(result.session.parentSessionId, sessionId);
  assert.notEqual(result.sessionId, sessionId);
  assert.deepEqual(await (await post()).json(), result, 'request retry reuses the same new conversation');
  assert.equal((await post(1, { sourceMessageUuid: ids[5] })).status, 409, 'request ids cannot be reused for a different checkpoint');
  assert.equal((await post(1, { requestId: randomUUID(), sourceMessageUuid: ids[1] })).status, 409, 'tool-use is not a completed reply');
  const branch = mt.sessions.findOwnedSession({ ...scope, providerSessionId: result.sessionId });
  assert.equal(JSON.parse(branch.metadata_json).scheduledTaskId, undefined);
  // A newer active runtime must not steal the branch's original history home.
  mt.runtimes.createRuntime({ ...scope, runtimeId: 'newer-runtime', containerName: 'newer-container', image: 'local', workspaceHostPath: workspace.path, runtimeHomePath: path.join(root, 'other-home'), status: 'active' });
  assert.equal(mt.runtimes.findByProviderSession({ ...scope, providerSessionId: result.sessionId })?.runtime_id, 'fork-runtime');
  const loaded = await history.fetchHistory({ ...scope, providerSessionId: result.sessionId, ownedSession: branch });
  assert.ok(loaded.messages.some(message => message.content === 'The chosen color is blue.'));
  assert.ok(loaded.messages.some(message => message.kind === 'tool_use' && message.toolResult?.content === 'blue'));
  assert.ok(loaded.messages.some(message => message.id === `fork_${result.sessionId}_hook-old` && message.inherited));
  assert.equal(JSON.stringify(loaded).includes('red'), false);
  assert.equal(JSON.stringify(loaded).includes('Later hook'), false);
  assert.equal(await fs.readFile(sourcePath, 'utf8'), originalBytes);
  assert.deepEqual(mt.sessions.listSessions(scope).find(row => row.provider_session_id === sessionId)?.summary, originalSession.summary);
  assert.deepEqual(mt.sessionMessages.listMessages({ ...scope, providerSessionId: sessionId }).messages.map(message => message.id), ['hook-old', 'hook-future']);
  assert.equal(mt.runtimes.findByProviderSession({ ...scope, providerSessionId: sessionId })?.status, 'idle');
  const projects = mapWorkspaceRowsToProjects([{ ...workspace, accessRole: 'owner' }], { tenantId: tenant.id, userId: 1, listSessions: mt.sessions.listSessions, listScheduledTasks: () => [], getScheduledTaskMap: () => new Map() });
  assert.equal(projects[0].sessions.find(session => session.id === result.sessionId)?.parentSessionId, sessionId);
  // Appending a new branch turn cannot affect the original transcript.
  await fs.appendFile(path.join(projectDirectory, `${result.sessionId}.jsonl`), JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: result.sessionId, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Continue with blue.' } }) + '\n');
  assert.equal(await fs.readFile(sourcePath, 'utf8'), originalBytes);
  assert.ok((await history.fetchHistory({ ...scope, providerSessionId: result.sessionId, ownedSession: branch })).messages.some(message => message.content === 'Continue with blue.'));
});
