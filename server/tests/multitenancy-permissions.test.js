import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { DATABASE_SCHEMA_SQL } from '../database/schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';
import { createMultitenancyDb } from '../database/multitenancy-db.js';
import { createWorkspaceAccessService } from '../services/workspace-access.js';

function setup() {
  const database = new Database(':memory:');
  database.exec(DATABASE_SCHEMA_SQL);
  database.exec(MULTITENANCY_SCHEMA_SQL);
  const mt = createMultitenancyDb(database);
  const user = (username) =>
    Number(database.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, 'hash').lastInsertRowid);
  return { database, mt, user, access: createWorkspaceAccessService(mt) };
}

test('shared edit workspace can be edited but sessions stay private', () => {
  const { mt, user, access } = setup();
  const ownerId = user('owner');
  const editorId = user('editor');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: editorId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/team/owner/repo',
  });
  mt.workspaceAcl.replaceAcl({
    workspaceId: workspace.id,
    ownerUserId: ownerId,
    entries: [{ userId: editorId, permission: 'edit' }],
  });

  assert.equal(access.canEditWorkspace({ tenantId: tenant.id, userId: editorId, workspaceId: workspace.id }), true);

  mt.sessions.upsertSession({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'owner-session',
    summary: 'Owner',
  });

  assert.equal(mt.sessions.findOwnedSession({
    tenantId: tenant.id,
    userId: editorId,
    provider: 'claude',
    providerSessionId: 'owner-session',
  }), null);
});

test('shared view workspace can be viewed but not edited', () => {
  const { mt, user, access } = setup();
  const ownerId = user('owner');
  const viewerId = user('viewer');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: viewerId, role: 'member', permission: 'view', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/team/owner/repo',
  });
  mt.workspaceAcl.replaceAcl({
    workspaceId: workspace.id,
    ownerUserId: ownerId,
    entries: [{ userId: viewerId, permission: 'view' }],
  });

  assert.equal(access.canViewWorkspace({ tenantId: tenant.id, userId: viewerId, workspaceId: workspace.id }), true);
  assert.equal(access.canEditWorkspace({ tenantId: tenant.id, userId: viewerId, workspaceId: workspace.id }), false);
});
