import express from 'express';

import { tenantContext } from '../middleware/tenant-context.js';
import { workspaceAccess } from '../services/workspace-access.js';
import { workspaceMcpToolsService } from '../services/workspace-mcp-tools.js';
import {
  getRequestTenantId,
  getRequestUserId,
  getRequestWorkspaceId,
  handleWorkspaceError,
} from '../services/workspace-request.js';

export function createWorkspaceMcpToolsRouter({
  access = workspaceAccess,
  tenantMiddleware = tenantContext,
  mcpToolsService = workspaceMcpToolsService,
} = {}) {
  const router = express.Router();
  router.use(tenantMiddleware);

  router.get('/:workspaceId/mcp-tools', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: false });
      const catalog = await mcpToolsService.listWorkspaceMcpPresetCatalog({
        tenantId: workspace.tenant_id,
        workspaceId: workspace.id,
        accessRole,
      });

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: accessRole === 'owner' || accessRole === 'edit',
        ...catalog,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.post('/:workspaceId/mcp-tools/:presetId/install', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const result = await mcpToolsService.installWorkspaceMcpPreset({
        tenantId: workspace.tenant_id,
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        workspaceDisplayName: workspace.display_name || workspace.slug || String(workspace.id),
        presetId: Number(req.params.presetId),
        userId: getRequestUserId(req),
      });

      return res.status(201).json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        ...result,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.delete('/:workspaceId/mcp-tools/:presetId', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const result = await mcpToolsService.removeWorkspaceMcpPreset({
        tenantId: workspace.tenant_id,
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        presetId: Number(req.params.presetId),
      });

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        ...result,
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

export default createWorkspaceMcpToolsRouter();
