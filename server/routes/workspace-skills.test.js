import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createWorkspaceSkillsRouter } from './workspace-skills.js';

async function requestJson(
  router,
  path,
  { method = 'GET', body = null, user = { id: 7, is_system_admin: 0 } } = {},
) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = user;
      next();
    });
    app.use(router);

    const server = app.listen(0, async () => {
      try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const payload = await response.json();
        server.close(() => resolve({ response, payload }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

async function requestFormData(
  router,
  path,
  { method = 'POST', formData, user = { id: 7, is_system_admin: 0 } } = {},
) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = user;
      next();
    });
    app.use(router);

    const server = app.listen(0, async () => {
      try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          body: formData,
        });
        const payload = await response.json();
        server.close(() => resolve({ response, payload }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

function createRouter({
  accessRole = 'view',
  createWorkspaceSkill,
  getWorkspaceSkillDetail,
  installGithubSkill,
  listWorkspaceSkills,
  previewGithubSkillInstall,
  previewLocalSkillUpload,
  reconcileManagedSkills,
  requireWorkspace,
  setSkillEnabled,
  uninstallManagedSkill,
  updateWorkspaceSkillFile,
} = {}) {
  return createWorkspaceSkillsRouter({
    marketImports: {
      listForWorkspace: () => [],
    },
    tenantMiddleware: (req, res, next) => {
      req.tenant = { id: 2, permission: 'edit' };
      next();
    },
    access: {
      requireWorkspace: requireWorkspace || (() => ({
        workspace: { id: 10, tenant_id: 2, path: '/tmp/workspace' },
        accessRole,
      })),
    },
    skillsService: {
      listWorkspaceSkills: listWorkspaceSkills || (async () => ({
        skills: [],
        summary: {
          total: 0,
          managed: 0,
          unmanaged: 0,
          system: 0,
          enabled: 0,
          disabled: 0,
          invalid: 0,
        },
      })),
      getWorkspaceSkillDetail: getWorkspaceSkillDetail || (async () => ({
        name: 'local-skill',
        origin: 'local',
        files: [],
      })),
      createWorkspaceSkill: createWorkspaceSkill || (async () => ({
        name: 'local-skill',
        origin: 'local',
        files: [{ path: 'SKILL.md', type: 'file' }],
      })),
      updateWorkspaceSkillFile: updateWorkspaceSkillFile || (async () => ({
        path: 'SKILL.md',
        content: 'updated',
        revision: 'next-revision',
      })),
      previewGithubSkillInstall: previewGithubSkillInstall || (async () => ({
        previewId: 'preview-one',
        name: 'grill-me',
      })),
      previewLocalSkillUpload: previewLocalSkillUpload || (async () => ({
        previewId: 'upload-preview-one',
        name: 'local-skill',
      })),
      installGithubSkill: installGithubSkill || (async () => ({
        name: 'grill-me',
        status: 'enabled',
      })),
      setSkillEnabled: setSkillEnabled || (async () => ({
        name: 'grill-me',
        status: 'disabled',
      })),
      uninstallManagedSkill: uninstallManagedSkill || (async () => {}),
      reconcileManagedSkills: reconcileManagedSkills || (async () => ({
        materialized: [],
        removed: [],
        failures: [],
      })),
    },
  });
}

test('GET /:workspaceId/skills returns inventory for view-only workspace access', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'view',
    requireWorkspace: (args) => {
      seen.accessArgs = args;
      return {
        workspace: { id: args.workspaceId, tenant_id: args.tenantId, path: '/tmp/view-workspace' },
        accessRole: 'view',
      };
    },
    listWorkspaceSkills: async (workspacePath) => {
      seen.workspacePath = workspacePath;
      return {
        skills: [{ name: 'unmanaged-one', kind: 'unmanaged', status: 'available' }],
        summary: { total: 1, managed: 0, unmanaged: 1, system: 0, enabled: 0, disabled: 0, invalid: 0 },
      };
    },
  });

  const { response, payload } = await requestJson(router, '/10/skills?tenantId=2');

  assert.equal(response.status, 200);
  assert.deepEqual(seen.accessArgs, {
    tenantId: 2,
    userId: 7,
    workspaceId: 10,
    requireEdit: false,
  });
  assert.equal(seen.workspacePath, '/tmp/view-workspace');
  assert.deepEqual(payload, {
    workspaceId: 10,
    accessRole: 'view',
    canManage: false,
    skills: [{ name: 'unmanaged-one', kind: 'unmanaged', status: 'available' }],
    summary: { total: 1, managed: 0, unmanaged: 1, system: 0, enabled: 0, disabled: 0, invalid: 0 },
  });
});

test('GET /:workspaceId/skills marks owner and edit workspaces as manageable', async () => {
  const router = createRouter({ accessRole: 'edit' });

  const { response, payload } = await requestJson(router, '/10/skills?tenantId=2');

  assert.equal(response.status, 200);
  assert.equal(payload.accessRole, 'edit');
  assert.equal(payload.canManage, true);
});

test('GET /:workspaceId/skills/:name returns a local skill detail', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'view',
    getWorkspaceSkillDetail: async (args) => {
      seen.detailArgs = args;
      return { name: 'local-skill', origin: 'local', files: [{ path: 'SKILL.md', type: 'file' }] };
    },
  });

  const { response, payload } = await requestJson(router, '/10/skills/local-skill?tenantId=2');

  assert.equal(response.status, 200);
  assert.equal(payload.canManage, false);
  assert.deepEqual(seen.detailArgs, {
    workspacePath: '/tmp/workspace',
    name: 'local-skill',
    marketImports: [],
  });
  assert.equal(payload.skill.origin, 'local');
});

test('PUT /:workspaceId/skills/:name/files saves a local skill file with edit access', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'edit',
    updateWorkspaceSkillFile: async (args) => {
      seen.updateArgs = args;
      return { path: 'SKILL.md', content: args.content, revision: 'next-revision' };
    },
  });

  const { response, payload } = await requestJson(router, '/10/skills/local-skill/files?tenantId=2', {
    method: 'PUT',
    body: { filePath: 'SKILL.md', content: 'updated', revision: 'old-revision' },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(seen.updateArgs, {
    workspacePath: '/tmp/workspace',
    name: 'local-skill',
    filePath: 'SKILL.md',
    content: 'updated',
    revision: 'old-revision',
    marketImports: [],
  });
  assert.equal(payload.file.revision, 'next-revision');
});

test('GET /:workspaceId/skills serializes workspace authorization errors', async () => {
  const router = createRouter({
    requireWorkspace: () => {
      const error = new Error('Workspace not found');
      error.statusCode = 404;
      throw error;
    },
  });

  const { response, payload } = await requestJson(router, '/999/skills?tenantId=2');

  assert.equal(response.status, 404);
  assert.deepEqual(payload, { error: 'Workspace not found' });
});

test('POST /:workspaceId/skills/preview requires edit access and returns a preview', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'edit',
    requireWorkspace: (args) => {
      seen.accessArgs = args;
      return {
        workspace: { id: args.workspaceId, tenant_id: args.tenantId, path: '/tmp/edit-workspace' },
        accessRole: 'edit',
      };
    },
    previewGithubSkillInstall: async (args) => {
      seen.previewArgs = args;
      return {
        previewId: 'preview-one',
        name: 'grill-me',
        conflict: { type: 'none', blocking: false },
      };
    },
  });

  const { response, payload } = await requestJson(router, '/10/skills/preview?tenantId=2', {
    method: 'POST',
    body: { url: 'https://github.com/acme/skills/tree/main/grill-me' },
  });

  assert.equal(response.status, 201);
  assert.deepEqual(seen.accessArgs, {
    tenantId: 2,
    userId: 7,
    workspaceId: 10,
    requireEdit: true,
  });
  assert.deepEqual(seen.previewArgs, {
    workspacePath: '/tmp/edit-workspace',
    url: 'https://github.com/acme/skills/tree/main/grill-me',
  });
  assert.deepEqual(payload, {
    workspaceId: 10,
    accessRole: 'edit',
    canManage: true,
    preview: {
      previewId: 'preview-one',
      name: 'grill-me',
      conflict: { type: 'none', blocking: false },
    },
  });
});

test('POST /:workspaceId/skills/upload requires edit access and returns a local upload preview', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'edit',
    requireWorkspace: (args) => {
      seen.accessArgs = args;
      return {
        workspace: { id: args.workspaceId, tenant_id: args.tenantId, path: '/tmp/edit-workspace' },
        accessRole: 'edit',
      };
    },
    previewLocalSkillUpload: async (args) => {
      seen.uploadArgs = {
        workspacePath: args.workspacePath,
        originalName: args.originalName,
        archiveText: args.archiveBuffer.toString('utf8'),
      };
      return {
        previewId: 'upload-preview-one',
        name: 'local-skill',
        sourceType: 'local-upload',
      };
    },
  });
  const formData = new FormData();
  formData.append('archive', new Blob([Buffer.from('zip-bytes')], { type: 'application/zip' }), 'local-skill.zip');

  const { response, payload } = await requestFormData(router, '/10/skills/upload?tenantId=2', {
    formData,
  });

  assert.equal(response.status, 201);
  assert.deepEqual(seen.accessArgs, {
    tenantId: 2,
    userId: 7,
    workspaceId: 10,
    requireEdit: true,
  });
  assert.deepEqual(seen.uploadArgs, {
    workspacePath: '/tmp/edit-workspace',
    originalName: 'local-skill.zip',
    archiveText: 'zip-bytes',
  });
  assert.deepEqual(payload, {
    workspaceId: 10,
    accessRole: 'edit',
    canManage: true,
    preview: {
      previewId: 'upload-preview-one',
      name: 'local-skill',
      sourceType: 'local-upload',
    },
  });
});

test('POST /:workspaceId/skills installs a preview and returns refreshed inventory', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'owner',
    requireWorkspace: (args) => ({
      workspace: { id: args.workspaceId, tenant_id: args.tenantId, path: '/tmp/owner-workspace' },
      accessRole: 'owner',
    }),
    installGithubSkill: async (args) => {
      seen.installArgs = args;
      return { name: 'grill-me', status: 'enabled' };
    },
    listWorkspaceSkills: async (workspacePath) => {
      seen.listWorkspacePath = workspacePath;
      return {
        skills: [{ name: 'grill-me', kind: 'managed', status: 'enabled' }],
        summary: { total: 1, managed: 1, unmanaged: 0, system: 0, enabled: 1, disabled: 0, invalid: 0 },
      };
    },
  });

  const { response, payload } = await requestJson(router, '/10/skills?tenantId=2', {
    method: 'POST',
    body: { previewId: 'preview-one', enable: true },
  });

  assert.equal(response.status, 201);
  assert.deepEqual(seen.installArgs, {
    workspacePath: '/tmp/owner-workspace',
    previewId: 'preview-one',
    enable: true,
  });
  assert.equal(seen.listWorkspacePath, '/tmp/owner-workspace');
  assert.deepEqual(payload, {
    workspaceId: 10,
    accessRole: 'owner',
    canManage: true,
    skill: { name: 'grill-me', status: 'enabled' },
    skills: [{ name: 'grill-me', kind: 'managed', status: 'enabled' }],
    summary: { total: 1, managed: 1, unmanaged: 0, system: 0, enabled: 1, disabled: 0, invalid: 0 },
  });
});

test('POST /:workspaceId/skills/preview serializes view-only edit denial', async () => {
  const router = createRouter({
    requireWorkspace: () => {
      const error = new Error('Workspace edit access denied');
      error.statusCode = 403;
      throw error;
    },
  });

  const { response, payload } = await requestJson(router, '/10/skills/preview?tenantId=2', {
    method: 'POST',
    body: { url: 'https://github.com/acme/skills' },
  });

  assert.equal(response.status, 403);
  assert.deepEqual(payload, { error: 'Workspace edit access denied' });
});

test('PATCH /:workspaceId/skills/:name toggles a managed skill and returns inventory', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'edit',
    requireWorkspace: (args) => ({
      workspace: { id: args.workspaceId, tenant_id: args.tenantId, path: '/tmp/edit-workspace' },
      accessRole: 'edit',
    }),
    setSkillEnabled: async (args) => {
      seen.setArgs = args;
      return { name: 'grill-me', status: 'disabled' };
    },
    listWorkspaceSkills: async () => ({
      skills: [{ name: 'grill-me', kind: 'managed', status: 'disabled' }],
      summary: { total: 1, managed: 1, unmanaged: 0, system: 0, enabled: 0, disabled: 1, invalid: 0 },
    }),
  });

  const { response, payload } = await requestJson(router, '/10/skills/grill-me?tenantId=2', {
    method: 'PATCH',
    body: { enabled: false },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(seen.setArgs, {
    workspacePath: '/tmp/edit-workspace',
    name: 'grill-me',
    enabled: false,
  });
  assert.equal(payload.skill.status, 'disabled');
  assert.equal(payload.summary.disabled, 1);
});

test('DELETE /:workspaceId/skills/:name uninstalls a managed skill and returns no tombstone', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'owner',
    requireWorkspace: (args) => ({
      workspace: { id: args.workspaceId, tenant_id: args.tenantId, path: '/tmp/owner-workspace' },
      accessRole: 'owner',
    }),
    uninstallManagedSkill: async (args) => {
      seen.uninstallArgs = args;
    },
    listWorkspaceSkills: async () => ({
      skills: [],
      summary: { total: 0, managed: 0, unmanaged: 0, system: 0, enabled: 0, disabled: 0, invalid: 0 },
    }),
  });

  const { response, payload } = await requestJson(router, '/10/skills/grill-me?tenantId=2', {
    method: 'DELETE',
    body: { confirmation: 'yes' },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(seen.uninstallArgs, {
    workspacePath: '/tmp/owner-workspace',
    name: 'grill-me',
  });
  assert.equal(payload.uninstalled, 'grill-me');
  assert.deepEqual(payload.skills, []);
});

test('POST /:workspaceId/skills/reconcile materializes enabled managed skills', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'edit',
    requireWorkspace: (args) => ({
      workspace: { id: args.workspaceId, tenant_id: args.tenantId, path: '/tmp/edit-workspace' },
      accessRole: 'edit',
    }),
    reconcileManagedSkills: async (workspacePath) => {
      seen.reconcileWorkspacePath = workspacePath;
      return { materialized: ['grill-me'], removed: ['old-skill'], failures: [] };
    },
    listWorkspaceSkills: async () => ({
      skills: [{ name: 'grill-me', kind: 'managed', status: 'enabled' }],
      summary: { total: 1, managed: 1, unmanaged: 0, system: 0, enabled: 1, disabled: 0, invalid: 0 },
    }),
  });

  const { response, payload } = await requestJson(router, '/10/skills/reconcile?tenantId=2', {
    method: 'POST',
  });

  assert.equal(response.status, 200);
  assert.equal(seen.reconcileWorkspacePath, '/tmp/edit-workspace');
  assert.deepEqual(payload.reconcile, { materialized: ['grill-me'], removed: ['old-skill'], failures: [] });
});
