import assert from 'node:assert/strict';
import path from 'path';
import test from 'node:test';

import {
  buildTenantWorkspacePath,
  mapWorkspaceRowsToProjects,
  slugifyWorkspaceName,
} from './workspace-projects.js';

test('slugifyWorkspaceName creates DB-compatible workspace slugs', () => {
  assert.equal(slugifyWorkspaceName(' My_App!! '), 'my-app');
  assert.equal(slugifyWorkspaceName('repo'), 'repo');
  assert.equal(slugifyWorkspaceName('---'), '');
});

test('buildTenantWorkspacePath isolates tenant and owner paths under workspace root', () => {
  assert.equal(
    buildTenantWorkspacePath({
      workspacesRoot: '/tmp/cloudcli',
      tenantId: 2,
      userId: 7,
      requestedPath: '/Users/example/My App',
    }),
    path.join('/tmp/cloudcli', '2', '7', 'my-app'),
  );
});

test('mapWorkspaceRowsToProjects groups private sessions by provider', () => {
  const projects = mapWorkspaceRowsToProjects(
    [
      {
        id: 10,
        tenant_id: 2,
        owner_user_id: 7,
        slug: 'repo',
        display_name: 'Repo',
        path: '/tmp/cloudcli/2/7/repo',
        accessRole: 'owner',
      },
    ],
    {
      tenantId: 2,
      userId: 7,
      listSessions: () => [
        { provider: 'claude', provider_session_id: 'c1', summary: 'Claude', updated_at: '2026-04-26' },
        { provider: 'codex', provider_session_id: 'x1', summary: 'Codex', updated_at: '2026-04-26' },
      ],
    },
  );

  assert.equal(projects[0].workspaceId, 10);
  assert.equal(projects[0].accessRole, 'owner');
  assert.deepEqual(projects[0].sessions.map((session) => session.id), ['c1']);
  assert.deepEqual(projects[0].codexSessions.map((session) => session.id), ['x1']);
  assert.equal(projects[0].sessionMeta.total, 2);
});
