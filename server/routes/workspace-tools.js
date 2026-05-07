import express from 'express';

import { tenantContext } from '../middleware/tenant-context.js';
import { workspaceAccess } from '../services/workspace-access.js';
import * as workspaceToolsService from '../services/workspace-tools.js';
import {
  getRequestTenantId,
  getRequestUserId,
  getRequestWorkspaceId,
  handleWorkspaceError,
} from '../services/workspace-request.js';

export function createWorkspaceToolsRouter({
  access = workspaceAccess,
  tenantMiddleware = tenantContext,
  toolsService = workspaceToolsService,
} = {}) {
  const router = express.Router();
  router.use(tenantMiddleware);

  router.get('/:workspaceId/tools', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: false });
      const inventory = await toolsService.listWorkspaceTools(workspace.path, { accessRole });

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: accessRole === 'owner' || accessRole === 'edit',
        ...inventory,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.post('/:workspaceId/tools/mcp/probe', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const probe = await toolsService.probeWorkspaceMcpServer({
        workspacePath: workspace.path,
        server: req.body,
      });

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        probe,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.post('/:workspaceId/tools/mcp', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const result = await toolsService.upsertWorkspaceMcpServer({
        workspacePath: workspace.path,
        server: req.body,
      });
      const inventory = await toolsService.listWorkspaceTools(workspace.path, { accessRole });

      return res.status(result.savedAsDraft ? 202 : 201).json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        ...result,
        ...inventory,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.delete('/:workspaceId/tools/mcp/:name', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const removed = await toolsService.removeWorkspaceMcpServer({
        workspacePath: workspace.path,
        name: req.params.name,
      });
      const inventory = await toolsService.listWorkspaceTools(workspace.path, { accessRole });

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        removed,
        ...inventory,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.post('/:workspaceId/tools/mcp/import-preview', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const preview = await toolsService.previewWorkspaceMcpJsonImport({
        workspacePath: workspace.path,
        json: req.body?.json,
      });

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        preview,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  return router;
}

function resolveWorkspace(req, access, { requireEdit }) {
  const tenantId = req.tenant?.id ?? getRequestTenantId(req);
  const userId = getRequestUserId(req);
  const workspaceId = getRequestWorkspaceId(req);

  if (!tenantId || !workspaceId || !userId) {
    const error = new Error('tenantId and workspaceId are required');
    error.statusCode = 400;
    throw error;
  }

  return access.requireWorkspace({
    tenantId,
    userId,
    workspaceId,
    requireEdit,
  });
}

export default createWorkspaceToolsRouter();
