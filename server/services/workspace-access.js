import path from 'path';

import { multitenancyDb } from '../database/multitenancy-db.js';

function isUnderRoot(rootPath, targetPath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function createWorkspaceAccessService(multitenancy = multitenancyDb) {
  function getWorkspaceOrNull(workspaceId) {
    return multitenancy.workspaces.getWorkspaceById(workspaceId);
  }

  function getAccessRole({ tenantId, userId, workspaceId }) {
    const workspace = getWorkspaceOrNull(workspaceId);
    if (!workspace || workspace.status !== 'active' || Number(workspace.tenant_id) !== Number(tenantId)) {
      return null;
    }
    if (Number(workspace.owner_user_id) === Number(userId)) {
      return 'owner';
    }

    const acl = multitenancy.workspaceAcl.getAclEntry(workspaceId, userId);
    return acl?.permission || null;
  }

  function canViewWorkspace(args) {
    return Boolean(getAccessRole(args));
  }

  function canEditWorkspace(args) {
    const role = getAccessRole(args);
    return role === 'owner' || role === 'edit';
  }

  function requireWorkspace({ tenantId, userId, workspaceId, requireEdit = false }) {
    const workspace = getWorkspaceOrNull(workspaceId);
    if (!workspace || workspace.status !== 'active' || Number(workspace.tenant_id) !== Number(tenantId)) {
      const error = new Error('Workspace not found');
      error.statusCode = 404;
      throw error;
    }

    const role = getAccessRole({ tenantId, userId, workspaceId });
    if (!role) {
      const error = new Error('Workspace not found');
      error.statusCode = 404;
      throw error;
    }
    if (requireEdit && role !== 'owner' && role !== 'edit') {
      const error = new Error('Workspace edit access denied');
      error.statusCode = 403;
      throw error;
    }

    return { workspace, accessRole: role };
  }

  function resolvePath({ tenantId, userId, workspaceId, requestedPath = '', requireEdit = false }) {
    const { workspace, accessRole } = requireWorkspace({ tenantId, userId, workspaceId, requireEdit });
    const stringPath = String(requestedPath || '');
    const resolvedPath = path.isAbsolute(stringPath)
      ? path.resolve(stringPath)
      : path.resolve(workspace.path, stringPath);

    if (!isUnderRoot(workspace.path, resolvedPath)) {
      const error = new Error('Path must be under workspace root');
      error.statusCode = 403;
      throw error;
    }

    return { workspace, accessRole, resolvedPath };
  }

  return {
    getAccessRole,
    canViewWorkspace,
    canEditWorkspace,
    requireWorkspace,
    resolvePath,
  };
}

export const workspaceAccess = createWorkspaceAccessService(multitenancyDb);
