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
