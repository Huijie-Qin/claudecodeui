import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { DATABASE_SCHEMA_SQL } from '../../database/schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../../database/multitenancy-schema.js';
import { createMultitenancyDb } from '../../database/multitenancy-db.js';
import { createWorkspaceAccessService } from '../workspace-access.js';

import { createConversationRegistrar } from './conversations.js';
import { createSkillCreationService } from './service.js';

async function fixture(t) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'creation-conversation-'));
  const db = new Database(':memory:');
  t.after(async () => { db.close(); await fs.rm(workspacePath, { recursive: true, force: true }); });
  db.exec(DATABASE_SCHEMA_SQL); db.exec(MULTITENANCY_SCHEMA_SQL);
  const mt = createMultitenancyDb(db);
  const userId = Number(db.prepare('INSERT INTO users (username,password_hash) VALUES (?,?)').run('creator', 'test-only').lastInsertRowid);
  const tenant = mt.tenants.createTenant({ code: 'test', name: 'Test' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({ tenantId: tenant.id, ownerUserId: userId, slug: 'test', displayName: 'Test', path: workspacePath });
  const scope = { tenantId: tenant.id, workspaceId: workspace.id, userId, workspacePath };
  const access = createWorkspaceAccessService(mt);
  const register = createConversationRegistrar({ db, sessions: mt.sessions, access });
  return { db, mt, scope, access, register };
}

test('new creation request registers its queued job with real session validation and completes', async (t) => {
  const f = await fixture(t);
  const service = createSkillCreationService({ db: f.db, listSnippets: () => [],
    creator: async () => ({ markdown: '---\nname: example\ndescription: Test skill\n---\nReturn a greeting.' }),
    own: async () => {}, authorize: (scope, requireEdit) => f.access.requireWorkspace({ ...scope, requireEdit }),
    authorizeSession: job => { if (job.sessionId) assert.ok(f.mt.sessions.findOwnedSession({ ...job, providerSessionId: job.sessionId })); },
    registerConversation: f.register,
  });
  try {
    const request = { intent: 'create-skill', description: '创建问候技能', provider: 'claude', conversationKey: 'claude:draft-new', requestId: randomUUID() };
    const started = await service.start(f.scope, request);
    assert.match(started.sessionId, /^skill-creation:/);
    const session = f.mt.sessions.findOwnedSession({ ...f.scope, provider: 'claude', providerSessionId: started.sessionId });
    assert.equal(session.status, 'active');
    assert.equal(JSON.parse(session.metadata_json).skillCreation, true);
    for (let i = 0; i < 100 && service.get(f.scope, started.id).status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(service.get(f.scope, started.id).status, 'completed');
    assert.equal((await service.start(f.scope, request)).id, started.id);
    assert.equal(service.list(f.scope, started.conversationKey).length, 1);
  } finally { await service.stop(); }
});

test('tagging existing pending conversations preserves session status, summary and metadata', async (t) => {
  const { mt, scope, register } = await fixture(t);
  for (const status of ['active', 'completed', 'aborted', 'failed']) {
    const providerSessionId = `pending:${status}`;
    mt.sessions.upsertSession({ ...scope, provider: 'claude', providerSessionId, status, summary: 'Keep this title', metadata: { retained: true } });
    assert.equal(register({ ...scope, provider: 'claude', sessionId: providerSessionId, status: 'queued', description: 'New skill' }), providerSessionId);
    const session = mt.sessions.findOwnedSession({ ...scope, provider: 'claude', providerSessionId });
    assert.equal(session.status, status);
    assert.equal(session.summary, 'Keep this title');
    assert.deepEqual(JSON.parse(session.metadata_json), { retained: true, skillCreation: true });
  }
});

test('recovery accepts creation phases without resurrecting deleted sessions', async (t) => {
  const { db, mt, scope, register } = await fixture(t);
  for (const status of ['queued', 'selecting', 'generating', 'saving', 'cancelling', 'cancelled', 'completed', 'failed']) {
    const job = { ...scope, provider: 'claude', status, description: 'Recovered skill', conversationKey: `claude:draft-${status}` };
    const providerSessionId = register(job);
    assert.equal(mt.sessions.findOwnedSession({ ...scope, provider: 'claude', providerSessionId }).status, 'active');
    mt.sessions.markDeleted({ ...scope, provider: 'claude', providerSessionId });
    assert.equal(register(job), null);
    assert.equal(db.prepare('SELECT status FROM session_index WHERE provider_session_id=?').get(providerSessionId).status, 'deleted');
  }
});
