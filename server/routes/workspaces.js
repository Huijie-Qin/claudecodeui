import express from 'express';

import { multitenancyDb } from '../database/multitenancy-db.js';
import { tenantContext } from '../middleware/tenant-context.js';
import { hookConfigService } from '../services/hook-configs.js';
import { hookWorkspaceResourcesService } from '../services/hook-workspace-resources.js';
import { workspaceAccess } from '../services/workspace-access.js';

function sendRouteError(res, error) {
  const statusCode = error.statusCode || 500;
  res.status(statusCode).json({ error: error.message || 'Internal server error' });
}

export function createWorkspacesRouter({
  multitenancy = multitenancyDb,
  access = workspaceAccess,
  tenantMiddleware = tenantContext,
  hookConfigs = hookConfigService,
  hookResources = hookWorkspaceResourcesService,
} = {}) {
  const router = express.Router();
  router.use(tenantMiddleware);

  router.get('/:workspaceId/share', (req, res) => {
    try {
      const workspaceId = Number(req.params.workspaceId);
      const { workspace, accessRole } = access.requireWorkspace({
        tenantId: req.tenant.id,
        userId: req.user.id,
        workspaceId,
      });
      if (accessRole !== 'owner') {
        return res.status(403).json({ error: 'Only workspace owner can view share settings' });
      }
      return res.json({ workspace, acl: multitenancy.workspaceAcl.listAcl(workspaceId) });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.put('/:workspaceId/share', (req, res) => {
    try {
      const workspaceId = Number(req.params.workspaceId);
      const { workspace, accessRole } = access.requireWorkspace({
        tenantId: req.tenant.id,
        userId: req.user.id,
        workspaceId,
        requireEdit: true,
      });
      if (accessRole !== 'owner') {
        return res.status(403).json({ error: 'Only workspace owner can update share settings' });
      }

      const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
      for (const entry of entries) {
        const membership = multitenancy.memberships.getActiveMembership(Number(entry.userId), workspace.tenant_id);
        if (!membership) {
          return res.status(422).json({ error: 'Workspace ACL users must belong to the workspace tenant' });
        }
      }

      const acl = multitenancy.workspaceAcl.replaceAcl({
        workspaceId,
        ownerUserId: req.user.id,
        entries,
      });
      return res.json({ acl });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.get('/:workspaceId/sql-check', (req, res) => {
    try {
      if (typeof multitenancy.sqlCheck?.resolveUserConfig !== 'function') {
        return res.status(501).json({ error: 'SQL check configuration is not available' });
      }

      const workspaceId = Number(req.params.workspaceId);
      const { workspace, accessRole } = access.requireWorkspace({
        tenantId: req.tenant.id,
        userId: req.user.id,
        workspaceId,
      });
      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        enforcement: hookConfigs.getSqlCheckEnforcement({ userId: req.user.id }),
        ...multitenancy.sqlCheck.resolveUserConfig({
          tenantId: workspace.tenant_id,
          workspaceId: workspace.id,
          userId: req.user.id,
        }),
      });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.put('/:workspaceId/sql-check', (req, res) => {
    try {
      if (typeof multitenancy.sqlCheck?.setUserPreference !== 'function') {
        return res.status(501).json({ error: 'SQL check configuration is not available' });
      }

      const workspaceId = Number(req.params.workspaceId);
      const { workspace, accessRole } = access.requireWorkspace({
        tenantId: req.tenant.id,
        userId: req.user.id,
        workspaceId,
      });
      multitenancy.sqlCheck.setUserPreference({
        tenantId: workspace.tenant_id,
        workspaceId: workspace.id,
        userId: req.user.id,
        customEnabled: req.body?.customEnabled ?? req.body?.custom_enabled ?? false,
        ruleIds: req.body?.ruleIds ?? req.body?.rule_ids ?? [],
      });

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        enforcement: hookConfigs.getSqlCheckEnforcement({ userId: req.user.id }),
        ...multitenancy.sqlCheck.resolveUserConfig({
          tenantId: workspace.tenant_id,
          workspaceId: workspace.id,
          userId: req.user.id,
        }),
      });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.get('/:workspaceId/hooks', (req, res) => {
    try {
      const workspaceId = Number(req.params.workspaceId);
      const { workspace, accessRole } = access.requireWorkspace({
        tenantId: req.tenant.id,
        userId: req.user.id,
        workspaceId,
      });
      return res.json({
        workspaceId: workspace.id,
        accessRole,
        hooks: hookConfigs.listAvailableHooksForUser(req.user.id),
      });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.put('/:workspaceId/hooks/:hookId', async (req, res) => {
    try {
      const workspaceId = Number(req.params.workspaceId);
      const { workspace, accessRole } = access.requireWorkspace({
        tenantId: req.tenant.id,
        userId: req.user.id,
        workspaceId,
      });
      const availableHook = hookConfigs.listAvailableHooksForUser(req.user.id)
        .find((hook) => hook.id === req.params.hookId);
      if (!availableHook) {
        const error = new Error('Hook is not available to this user');
        error.statusCode = 403;
        throw error;
      }
      if (req.body?.enabled === true) {
        const hook = hookConfigs.getHook(req.params.hookId);
        await hookResources.materializeHook({ hook, workspacePath: workspace.path });
      }
      const result = hookConfigs.setUserHookEnabled({
        userId: req.user.id,
        hookId: req.params.hookId,
        enabled: req.body?.enabled,
      });
      return res.json({ workspaceId: workspace.id, accessRole, ...result });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.put('/:workspaceId/sql-check/enforcement', async (req, res) => {
    try {
      if (typeof hookConfigs?.setSqlCheckEnforcement !== 'function') {
        return res.status(501).json({ error: 'SQL Check enforcement is not available' });
      }

      const workspaceId = Number(req.params.workspaceId);
      const { workspace, accessRole } = access.requireWorkspace({
        tenantId: req.tenant.id,
        userId: req.user.id,
        workspaceId,
      });
      if (req.body?.enabled === true) {
        const enforcement = hookConfigs.getSqlCheckEnforcement({ userId: req.user.id });
        const hook = enforcement.hookId && typeof hookConfigs.getHook === 'function'
          ? hookConfigs.getHook(enforcement.hookId)
          : null;
        if (hook) await hookResources.materializeHook({ hook, workspacePath: workspace.path });
      }
      const enforcement = hookConfigs.setSqlCheckEnforcement({
        userId: req.user.id,
        enabled: req.body?.enabled,
      });
      return res.json({
        workspaceId: workspace.id,
        accessRole,
        enforcement,
      });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  return router;
}

export default createWorkspacesRouter();
