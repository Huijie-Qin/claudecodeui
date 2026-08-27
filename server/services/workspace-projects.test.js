import assert from 'node:assert/strict';
import path from 'path';
import test from 'node:test';

import {
  buildTenantWorkspacePath,
  mapWorkspaceRowsToProjects,
  resolveCloneDestinationPath,
  resolveWorkspaceTarget,
  slugifyWorkspaceName,
} from './workspace-projects.js';

test('slugifyWorkspaceName creates DB-compatible workspace slugs', () => {
  assert.equal(slugifyWorkspaceName(' My_App!! '), 'my-app');
  assert.equal(slugifyWorkspaceName('repo'), 'repo');
  assert.equal(slugifyWorkspaceName('---'), '');
});

test('slugifyWorkspaceName supports Chinese display names with safe stable slugs', () => {
  const chineseSlug = slugifyWorkspaceName('市场分析专家');

  assert.match(chineseSlug, /^agent-[a-f0-9]{8}$/);
  assert.equal(slugifyWorkspaceName('市场分析专家'), chineseSlug);
  assert.notEqual(slugifyWorkspaceName('竞品分析专家'), chineseSlug);
});

test('slugifyWorkspaceName keeps mixed-language names distinct', () => {
  const marketAnalysisSlug = slugifyWorkspaceName('市场分析1');
  const competitorAnalysisSlug = slugifyWorkspaceName('竞品分析1');

  assert.match(marketAnalysisSlug, /^1-[a-f0-9]{8}$/);
  assert.match(competitorAnalysisSlug, /^1-[a-f0-9]{8}$/);
  assert.notEqual(marketAnalysisSlug, competitorAnalysisSlug);
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

test('resolveWorkspaceTarget keeps new workspaces inside tenant isolation root', () => {
  const target = resolveWorkspaceTarget({
    workspaceType: 'new',
    workspacesRoot: '/tmp/cloudcli',
    tenantId: 2,
    userId: 7,
    requestedPath: '/Users/example/Projects/Team App',
  });

  assert.equal(target.requestedName, 'Team App');
  assert.equal(target.workspaceSlug, 'team-app');
  assert.equal(target.targetPath, path.join('/tmp/cloudcli', '2', '7', 'team-app'));
});

test('resolveWorkspaceTarget preserves a Chinese display name while using an ASCII path', () => {
  const target = resolveWorkspaceTarget({
    workspaceType: 'new',
    workspacesRoot: '/tmp/cloudcli',
    tenantId: 2,
    userId: 7,
    requestedPath: '市场分析专家',
  });

  assert.equal(target.requestedName, '市场分析专家');
  assert.match(target.workspaceSlug, /^agent-[a-f0-9]{8}$/);
  assert.equal(target.targetPath, path.join('/tmp/cloudcli', '2', '7', target.workspaceSlug));
});

test('resolveWorkspaceTarget keeps existing workspace paths user selected', () => {
  const target = resolveWorkspaceTarget({
    workspaceType: 'existing',
    workspacesRoot: '/tmp/cloudcli',
    tenantId: 2,
    userId: 7,
    requestedPath: '/Users/example/Projects/Team App',
  });

  assert.equal(target.requestedName, 'Team App');
  assert.equal(target.workspaceSlug, 'team-app');
  assert.equal(target.targetPath, '/Users/example/Projects/Team App');
});

test('resolveCloneDestinationPath clones matching repos into the workspace root', () => {
  assert.equal(
    resolveCloneDestinationPath({
      workspaceType: 'new',
      workspaceRootPath: '/tmp/cloudcli/2/7/team-app',
      workspaceSlug: 'team-app',
      repoName: 'Team-App',
    }),
    '/tmp/cloudcli/2/7/team-app',
  );
});

test('resolveCloneDestinationPath keeps distinct repo names in a child folder', () => {
  assert.equal(
    resolveCloneDestinationPath({
      workspaceType: 'new',
      workspaceRootPath: '/tmp/cloudcli/2/7/customer-portal',
      workspaceSlug: 'customer-portal',
      repoName: 'api-service',
    }),
    path.join('/tmp/cloudcli/2/7/customer-portal', 'api-service'),
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
      listScheduledTasks: () => [],
      getScheduledTaskMap: () => new Map(),
    },
  );

  assert.equal(projects[0].workspaceId, 10);
  assert.equal(projects[0].accessRole, 'owner');
  assert.deepEqual(projects[0].sessions.map((session) => session.id), ['c1']);
  assert.deepEqual(projects[0].codexSessions.map((session) => session.id), ['x1']);
  assert.equal(projects[0].sessionMeta.total, 2);
});

test('mapWorkspaceRowsToProjects exposes scheduled task folders and groups run sessions', () => {
  const scheduledTask = {
    id: 42,
    name: 'Daily check',
    enabled: true,
    provider: 'claude',
    sessionMode: 'new',
  };
  const projects = mapWorkspaceRowsToProjects(
    [{
      id: 10,
      tenant_id: 2,
      owner_user_id: 7,
      slug: 'repo',
      display_name: 'Repo',
      path: '/tmp/cloudcli/2/7/repo',
      accessRole: 'owner',
    }],
    {
      tenantId: 2,
      userId: 7,
      listSessions: () => [
        { provider: 'claude', provider_session_id: 'run-1', summary: 'Daily check run', updated_at: '2026-07-20' },
      ],
      listScheduledTasks: () => [scheduledTask],
      getScheduledTaskMap: () => new Map([['run-1', scheduledTask]]),
    },
  );

  assert.deepEqual(projects[0].scheduledTasks, [scheduledTask]);
  assert.equal(projects[0].sessions[0].isScheduledTaskSession, true);
  assert.equal(projects[0].sessions[0].scheduledTask.id, 42);
});
