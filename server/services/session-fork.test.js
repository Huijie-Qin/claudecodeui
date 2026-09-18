import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createSessionForkService } from './session-fork.js';

function fixture() {
  const request = {
    tenantId: 1, userId: 2, workspaceId: 3,
    sourceSessionId: randomUUID(), sourceMessageUuid: randomUUID(), requestId: randomUUID(),
  };
  const sourceSession = {
    provider_session_id: request.sourceSessionId, summary: 'Analysis', status: 'completed',
    workspace_id: 3, workspace_path: '/workspace',
  };
  const source = { sourceEntries: [{
    type: 'assistant', uuid: request.sourceMessageUuid, timestamp: '2026-09-18T01:00:00.000Z',
    message: { content: [{ type: 'text', text: 'The completed reply' }], stop_reason: 'end_turn' },
  }] };
  const sourceMessages = [];
  const registered = [];
  const calls = { access: [], owned: [], runtime: [], readSource: [], forkFiles: [], history: [], lock: [], cleanup: 0 };
  let locked = false;
  const deps = {
    multitenancy: {
      sessions: {
        findOwnedSession(scope) { calls.owned.push(scope); return sourceSession; },
        listSessions() { return registered.map(({ row }) => row); },
      },
      runtimes: {
        findByProviderSession(scope) { calls.runtime.push(scope); return { runtime_id: 'runtime-1', runtime_home_path: '/runtime-home' }; },
        findByOwner() { throw new Error('Unexpected fallback'); },
      },
    },
    access: { requireWorkspace(scope) { calls.access.push(scope); } },
    history: { async fetchHistory(scope) { calls.history.push(scope); return { messages: sourceMessages }; } },
    registerFork(input) {
      const row = { provider_session_id: input.session.providerSessionId, summary: input.session.summary,
        workspace_id: input.session.workspaceId, updated_at: '2026-09-18T02:00:00.000Z',
        metadata_json: JSON.stringify(input.session.metadata) };
      registered.push({ input, row });
      return row;
    },
    async withSessionLock(scope, operation) {
      calls.lock.push(scope);
      if (locked) throw Object.assign(new Error('Busy'), { statusCode: 409, code: 'SESSION_BUSY' });
      locked = true;
      try { return await operation(); } finally { locked = false; }
    },
    async readSource(scope) { calls.readSource.push(scope); return source; },
    async readCompletedReplies() { return new Set([request.sourceMessageUuid]); },
    async forkFiles(scope) {
      calls.forkFiles.push(scope);
      return { sessionId: randomUUID(), async cleanup() { calls.cleanup += 1; } };
    },
  };
  return { request, deps, source, sourceSession, sourceMessages, calls, registered };
}

test('fork enforces complete owner scope and gives inherited display rows fresh IDs without mutating source', async () => {
  const context = fixture();
  const before = '2026-09-18T00:59:59.000Z';
  const after = '2026-09-18T01:00:01.000Z';
  context.sourceMessages.push(
    { id: 'hook-old', kind: 'hook_activity', status: 'completed', timestamp: before, sequence: 4, rowid: 12 },
    { id: 'task-old', kind: 'task_notification', syntheticSubagentStop: true, timestamp: before },
    { id: 'loop-old', origin: 'hook', mcpLoopReplacement: true, status: 'completed', timestamp: before },
    { id: 'hook-future', kind: 'hook_activity', status: 'completed', timestamp: after },
    { id: 'hook-completed-later', kind: 'hook_activity', status: 'completed', timestamp: before, completedAt: after },
    { id: 'hook-running', kind: 'hook_activity', status: 'running', timestamp: before },
    { id: 'native-message', kind: 'assistant', timestamp: before },
  );
  const originalSource = JSON.stringify(context.source);
  const originalMessages = JSON.stringify(context.sourceMessages);
  const result = await createSessionForkService(context.deps).fork(context.request);
  assert.equal(result.parentSessionId, context.request.sourceSessionId);
  assert.equal(result.sourceMessageUuid, context.request.sourceMessageUuid);
  assert.equal(result.session.__workspaceId, 3);
  assert.equal(context.calls.cleanup, 0);
  assert.deepEqual(context.calls.readSource, [{ runtimeHomePath: '/runtime-home', sourceSessionId: context.request.sourceSessionId }]);
  assert.equal(context.calls.forkFiles[0].source, context.source);
  for (const call of [...context.calls.owned, ...context.calls.runtime, ...context.calls.access]) {
    assert.equal(call.tenantId, 1);
    assert.equal(call.userId, 2);
    assert.equal(call.workspaceId, 3);
    assert.equal(call.provider, 'claude');
  }
  assert.ok(context.calls.access.every((call) => call.requireEdit === true));
  const { input } = context.registered[0];
  assert.equal(input.runtimeId, 'runtime-1');
  assert.equal(input.session.status, 'completed');
  assert.equal(input.messages.length, 3);
  assert.deepEqual(input.messages.map((message) => message.forkedFrom.messageUuid), ['hook-old', 'task-old', 'loop-old']);
  for (const message of input.messages) {
    assert.ok(message.id.startsWith(`fork_${result.sessionId}_`));
    assert.equal(message.sessionId, result.sessionId);
    assert.equal(message.inherited, true);
    assert.equal(message.forkedFrom.sessionId, context.request.sourceSessionId);
    assert.equal(message.sequence, undefined);
    assert.equal(message.rowid, undefined);
  }
  assert.equal(JSON.stringify(context.source), originalSource);
  assert.equal(JSON.stringify(context.sourceMessages), originalMessages);
});

test('read-only access, another owner, unsupported providers, and incomplete replies do not create files', async () => {
  for (const scenario of ['read-only', 'not-owned', 'provider', 'incomplete']) {
    const context = fixture();
    let code;
    if (scenario === 'read-only') {
      code = 'DENIED';
      context.deps.access.requireWorkspace = () => { throw Object.assign(new Error('Denied'), { statusCode: 403, code }); };
    } else if (scenario === 'not-owned') {
      code = 'FORK_SESSION_NOT_FOUND';
      context.deps.multitenancy.sessions.findOwnedSession = () => null;
    } else if (scenario === 'provider') {
      code = 'FORK_PROVIDER_UNSUPPORTED';
      context.request.provider = 'codex';
    } else {
      code = 'FORK_REPLY_INCOMPLETE';
      context.source.sourceEntries[0].message.stop_reason = 'max_tokens';
    }
    await assert.rejects(createSessionForkService(context.deps).fork(context.request), { code });
    assert.equal(context.calls.forkFiles.length, 0, scenario);
    assert.equal(context.registered.length, 0, scenario);
  }
});

test('runtime unavailable and active sessions fail before filesystem work', async () => {
  for (const scenario of ['runtime', 'active']) {
    const context = fixture();
    if (scenario === 'runtime') {
      context.deps.multitenancy.runtimes.findByProviderSession = () => null;
      context.deps.multitenancy.runtimes.findByOwner = () => null;
    } else context.deps.isSessionActive = () => true;
    await assert.rejects(createSessionForkService(context.deps).fork(context.request), {
      code: scenario === 'runtime' ? 'FORK_HISTORY_UNAVAILABLE' : 'SESSION_BUSY',
    });
    assert.equal(context.calls.readSource.length, 0);
    assert.equal(context.calls.forkFiles.length, 0);
  }
});

test('registration failure and revoked access after copying both clean files and permit retry', async () => {
  for (const scenario of ['register', 'access', 'source-deleted']) {
    const context = fixture();
    const register = context.deps.registerFork;
    const access = context.deps.access.requireWorkspace;
    const owned = context.deps.multitenancy.sessions.findOwnedSession;
    if (scenario === 'register') context.deps.registerFork = () => { throw new Error('Registration failed'); };
    if (scenario === 'access') {
      let calls = 0;
      context.deps.access.requireWorkspace = () => { if (++calls === 2) throw new Error('Access revoked'); };
    }
    if (scenario === 'source-deleted') {
      let calls = 0;
      context.deps.multitenancy.sessions.findOwnedSession = () => ++calls === 1 ? context.sourceSession : null;
    }
    const service = createSessionForkService(context.deps);
    await assert.rejects(service.fork(context.request));
    assert.equal(context.calls.cleanup, 1, scenario);
    assert.equal(context.registered.length, 0, scenario);
    context.deps.registerFork = register;
    context.deps.access.requireWorkspace = access;
    context.deps.multitenancy.sessions.findOwnedSession = owned;
    // registerFork is captured at construction; recreating also models a retry
    // after a server restart while sharing the persistent rows.
    const result = await createSessionForkService(context.deps).fork(context.request);
    assert.ok(result.sessionId);
    assert.equal(context.registered.length, 1, scenario);
  }
});

test('repeated requestId returns the persisted branch even after recreating the service', async () => {
  const context = fixture();
  const first = await createSessionForkService(context.deps).fork(context.request);
  const second = await createSessionForkService(context.deps).fork(context.request);
  assert.deepEqual(second, first);
  assert.equal(context.calls.forkFiles.length, 1);
  assert.equal(context.registered.length, 1);
  await assert.rejects(createSessionForkService(context.deps).fork({ ...context.request, sourceMessageUuid: randomUUID() }), {
    code: 'FORK_REQUEST_CONFLICT',
  });
  assert.equal(context.calls.forkFiles.length, 1);
});

test('concurrent identical requests share one fork; conflicting IDs and other pending operations fail', async () => {
  const context = fixture();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const forkFiles = context.deps.forkFiles;
  context.deps.forkFiles = async (options) => {
    entered.resolve();
    await release.promise;
    return forkFiles(options);
  };
  const service = createSessionForkService(context.deps);
  const first = service.fork(context.request);
  await entered.promise;
  const duplicate = service.fork(context.request);
  await assert.rejects(service.fork({ ...context.request, sourceMessageUuid: randomUUID() }), { code: 'FORK_REQUEST_CONFLICT' });
  await assert.rejects(service.fork({ ...context.request, requestId: randomUUID() }), { code: 'SESSION_BUSY' });
  release.resolve();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
  assert.deepEqual(firstResult, duplicateResult);
  assert.equal(context.calls.forkFiles.length, 1);
  assert.equal(context.registered.length, 1);
});
