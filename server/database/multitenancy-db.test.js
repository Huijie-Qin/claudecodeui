import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { DATABASE_SCHEMA_SQL } from './schema.js';
import { MULTITENANCY_SCHEMA_SQL } from './multitenancy-schema.js';
import { createMultitenancyDb } from './multitenancy-db.js';

function createTestDb() {
  const database = new Database(':memory:');
  database.exec(DATABASE_SCHEMA_SQL);
  database.exec(MULTITENANCY_SCHEMA_SQL);
  return database;
}

function seedUser(database, username) {
  const result = database
    .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username, `hash-${username}`);
  return Number(result.lastInsertRowid);
}

test('tenant membership controls visible tenants', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const userId = seedUser(database, 'alice');
  const otherUserId = seedUser(database, 'bob');
  const tenant = mt.tenants.createTenant({ code: 'acme', name: 'Acme' });
  const hiddenTenant = mt.tenants.createTenant({ code: 'hidden', name: 'Hidden' });

  mt.memberships.upsertMembership({
    tenantId: tenant.id,
    userId,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  mt.memberships.upsertMembership({
    tenantId: hiddenTenant.id,
    userId: otherUserId,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });

  assert.deepEqual(
    mt.tenants.listTenantsForUser(userId).map((row) => row.code),
    ['acme'],
  );
  assert.equal(mt.memberships.getActiveMembership(userId, tenant.id).permission, 'edit');
  assert.equal(mt.memberships.getActiveMembership(userId, hiddenTenant.id), null);
});

test('system admin access can be granted across active tenants', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const activeTenant = mt.tenants.createTenant({ code: 'active', name: 'Active' });
  const disabledTenant = mt.tenants.createTenant({ code: 'disabled', name: 'Disabled', status: 'disabled' });

  const memberships = mt.memberships.grantSystemAdminAccessToAllTenants(adminId);

  assert.deepEqual(memberships.map((row) => row.tenant_id), [activeTenant.id]);
  assert.equal(mt.memberships.getActiveMembership(adminId, activeTenant.id).permission, 'edit');
  assert.equal(mt.memberships.getMembership(adminId, disabledTenant.id), null);
});

test('workspace ACL grants access only inside the same tenant', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const ownerId = seedUser(database, 'owner');
  const editorId = seedUser(database, 'editor');
  const outsiderId = seedUser(database, 'outsider');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  const otherTenant = mt.tenants.createTenant({ code: 'other', name: 'Other' });

  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: editorId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: otherTenant.id, userId: outsiderId, role: 'member', permission: 'edit', status: 'active' });

  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'app',
    displayName: 'App',
    path: '/tmp/cloudcli/team/owner/app',
  });

  mt.workspaceAcl.replaceAcl({
    workspaceId: workspace.id,
    ownerUserId: ownerId,
    entries: [{ userId: editorId, permission: 'edit' }],
  });

  assert.deepEqual(mt.workspaces.listVisibleWorkspaces({ tenantId: tenant.id, userId: ownerId }).map((row) => row.accessRole), ['owner']);
  assert.deepEqual(mt.workspaces.listVisibleWorkspaces({ tenantId: tenant.id, userId: editorId }).map((row) => row.accessRole), ['edit']);
  assert.deepEqual(mt.workspaces.listVisibleWorkspaces({ tenantId: tenant.id, userId: outsiderId }), []);
});

test('session index keeps shared workspace sessions private per user', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const ownerId = seedUser(database, 'owner');
  const editorId = seedUser(database, 'editor');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: editorId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/owner/repo',
  });
  mt.workspaceAcl.replaceAcl({
    workspaceId: workspace.id,
    ownerUserId: ownerId,
    entries: [{ userId: editorId, permission: 'edit' }],
  });

  mt.sessions.upsertSession({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'owner-session',
    summary: 'Owner session',
    status: 'active',
  });
  mt.sessions.upsertSession({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: editorId,
    provider: 'claude',
    providerSessionId: 'editor-session',
    summary: 'Editor session',
    status: 'active',
  });

  assert.deepEqual(mt.sessions.listSessions({ tenantId: tenant.id, workspaceId: workspace.id, userId: ownerId }).map((row) => row.provider_session_id), ['owner-session']);
  assert.deepEqual(mt.sessions.listSessions({ tenantId: tenant.id, workspaceId: workspace.id, userId: editorId }).map((row) => row.provider_session_id), ['editor-session']);
  assert.equal(mt.sessions.findOwnedSession({ tenantId: tenant.id, userId: editorId, provider: 'claude', providerSessionId: 'owner-session' }), null);
});

test('agent session runtime binds provider session id for resume', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const userId = seedUser(database, 'alice');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: userId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/alice/repo',
  });

  const runtime = mt.runtimes.createRuntime({
    runtimeId: 'runtime-1',
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    containerName: 'cloudcli-claude-t1-u1-w1-r1',
    image: 'cloudcli/test:claude',
    workspaceHostPath: workspace.path,
    runtimeHomePath: '/tmp/cloudcli/runtimes/runtime-1/home',
  });
  assert.equal(runtime.status, 'pending');
  assert.equal(runtime.provider_session_id, null);

  const bound = mt.runtimes.bindProviderSession({
    runtimeId: 'runtime-1',
    providerSessionId: 'claude-session-1',
  });

  assert.equal(bound.provider_session_id, 'claude-session-1');
  assert.equal(bound.status, 'active');
  assert.equal(
    mt.runtimes.findByProviderSession({
      tenantId: tenant.id,
      userId,
      workspaceId: workspace.id,
      provider: 'claude',
      providerSessionId: 'claude-session-1',
    }).runtime_id,
    'runtime-1',
  );
});

test('agent session messages persist normalized history idempotently', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const userId = seedUser(database, 'alice');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: userId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/alice/repo',
  });

  mt.runtimes.createRuntime({
    runtimeId: 'runtime-1',
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    containerName: 'cloudcli-claude-t1-u1-w1-r1',
    image: 'cloudcli/test:claude',
    workspaceHostPath: workspace.path,
    runtimeHomePath: '/tmp/cloudcli/runtimes/runtime-1/home',
  });

  const messages = [
    {
      id: 'msg-1',
      sessionId: 'claude-session-1',
      timestamp: '2026-04-26T00:00:00.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: 'hello',
    },
    {
      id: 'msg-2',
      sessionId: 'claude-session-1',
      timestamp: '2026-04-26T00:00:01.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: 'hi<|assistant|>',
    },
  ];

  mt.sessionMessages.upsertMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    runtimeId: 'runtime-1',
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    messages,
  });
  mt.sessionMessages.upsertMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    runtimeId: 'runtime-1',
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    messages,
  });

  const history = mt.sessionMessages.listMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    limit: null,
    offset: 0,
  });

  assert.equal(history.total, 2);
  assert.equal(history.hasMore, false);
  assert.deepEqual(history.messages.map((message) => message.id), ['msg-1', 'msg-2']);
  assert.equal(history.messages[1].content, 'hi');
});

test('agent session message pagination returns recent messages in chronological order', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const userId = seedUser(database, 'alice');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: userId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/alice/repo',
  });

  mt.runtimes.createRuntime({
    runtimeId: 'runtime-1',
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    containerName: 'cloudcli-claude-t1-u1-w1-r1',
    image: 'cloudcli/test:claude',
    workspaceHostPath: workspace.path,
    runtimeHomePath: '/tmp/cloudcli/runtimes/runtime-1/home',
  });

  mt.sessionMessages.upsertMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    runtimeId: 'runtime-1',
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    messages: ['1', '2', '3', '4'].map((id) => ({
      id: `msg-${id}`,
      sessionId: 'claude-session-1',
      timestamp: `2026-04-26T00:00:0${id}.000Z`,
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: `message ${id}`,
    })),
  });

  const page = mt.sessionMessages.listMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    limit: 2,
    offset: 1,
  });

  assert.equal(page.total, 4);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.messages.map((message) => message.id), ['msg-2', 'msg-3']);
});
