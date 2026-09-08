import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// Imports of the normal route defaults initialize the database. Never let this
// test migrate the developer's auth.db or copy its contents into a test database.
const databaseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'session-skill-route-db-'));
const databasePath = path.join(databaseDirectory, 'auth.db');
await fs.writeFile(databasePath, '');
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = databasePath;
const { createSessionSkillJobsRouter } = await import('./session-skill-jobs.js');
if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
else process.env.DATABASE_PATH = originalDatabasePath;
after(() => fs.rm(databaseDirectory, { recursive: true, force: true }));

async function request(router, url, body, userId = 7) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId }; next(); });
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, payload: await response.json() };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const body = { provider: 'claude', sessionId: 'session-1', operation: 'generate', skillName: 'add-numbers', maxIterations: 3 };
const messages = [{ id: 'u1', role: 'user', content: 'Add 1 and 2.' }, { id: 'a1', role: 'assistant', content: '3' }];

function fixture(overrides = {}) {
  const seen = {};
  const router = createSessionSkillJobsRouter({
    tenantMiddleware: (req, res, next) => { req.tenant = { id: 2 }; next(); },
    access: { requireWorkspace: (args) => { seen.access = args; return { workspace: { id: 10, path: '/tmp/workspace' } }; } },
    multitenancy: { sessions: { findOwnedSession: (args) => { seen.owned = args; return { workspace_id: 10, status: 'completed' }; } } },
    historyService: { fetchHistory: async (args) => { seen.history = args; return { messages, total: 50, hasMore: false }; } },
    jobsService: {
      startJob: async (args) => { seen.start = args; return { id: 'job-1', status: 'queued' }; },
      getJob: (args) => { seen.get = args; return { id: 'job-1', status: 'running' }; },
    },
    ...overrides,
  });
  return { router, seen };
}

test('POST requires editing and owned-session scope, and fetches the entire persisted history', async () => {
  const { router, seen } = fixture();
  const response = await request(router, '/10/session-skill-jobs?workspaceId=999', { ...body, workspaceId: 999 });
  assert.equal(response.status, 202);
  assert.deepEqual(response.payload, { job: { id: 'job-1', status: 'queued' } });
  assert.deepEqual(seen.access, { tenantId: 2, userId: 7, workspaceId: 10, requireEdit: true });
  assert.deepEqual(seen.owned, { tenantId: 2, userId: 7, workspaceId: 10, provider: 'claude', providerSessionId: 'session-1' });
  assert.equal(seen.history.limit, null);
  assert.equal(seen.history.offset, 0);
  assert.equal(seen.start.workspacePath, '/tmp/workspace');
  assert.equal(seen.start.workspaceId, 10);
  assert.deepEqual(seen.start.messages, messages);
});

test('a foreign session cannot be read or submitted', async () => {
  const { router, seen } = fixture({ multitenancy: { sessions: { findOwnedSession: () => null } } });
  const response = await request(router, '/10/session-skill-jobs', body);
  assert.equal(response.status, 404);
  assert.equal(seen.history, undefined);
  assert.equal(seen.start, undefined);
});

test('view-only users cannot generate or poll learning jobs', async () => {
  const { router, seen } = fixture({ access: { requireWorkspace: () => { throw Object.assign(new Error('Workspace edit access required'), { statusCode: 403 }); } } });
  assert.equal((await request(router, '/10/session-skill-jobs', body)).status, 403);
  assert.equal((await request(router, '/10/session-skill-jobs/job-1')).status, 403);
  assert.equal(seen.start, undefined);
  assert.equal(seen.get, undefined);
});

test('active responses cannot produce a partially captured learning example', async () => {
  const { router, seen } = fixture({ isSessionActive: () => true });
  assert.equal((await request(router, '/10/session-skill-jobs', body)).status, 409);
  assert.equal(seen.history, undefined);
});

test('history indicating another page is rejected', async () => {
  const { router, seen } = fixture({ historyService: { fetchHistory: async () => ({ messages, hasMore: true }) } });
  assert.equal((await request(router, '/10/session-skill-jobs', body)).status, 422);
  assert.equal(seen.start, undefined);
});

test('GET always scopes job access by tenant, user, and path workspace', async () => {
  const { router, seen } = fixture();
  const response = await request(router, '/10/session-skill-jobs/job-1?workspaceId=999', null, 9);
  assert.equal(response.status, 200);
  assert.deepEqual(seen.get, { tenantId: 2, userId: 9, workspaceId: 10, jobId: 'job-1' });
});

test('invalid request identifiers are rejected before history is fetched', async () => {
  const { router, seen } = fixture();
  assert.equal((await request(router, '/0/session-skill-jobs', body)).status, 400);
  assert.equal((await request(router, '/10/session-skill-jobs', { ...body, provider: 'unknown' })).status, 400);
  assert.equal((await request(router, '/10/session-skill-jobs', { ...body, sessionId: '' })).status, 400);
  assert.equal(seen.history, undefined);
});

test('job conflicts and foreign job lookups preserve their service status codes', async () => {
  const { router } = fixture({ jobsService: {
    startJob: async () => { throw Object.assign(new Error('Skill already exists'), { statusCode: 409 }); },
    getJob: () => { throw Object.assign(new Error('Skill learning job not found'), { statusCode: 404 }); },
  } });
  assert.equal((await request(router, '/10/session-skill-jobs', body)).status, 409);
  assert.equal((await request(router, '/10/session-skill-jobs/job-other')).status, 404);
});
