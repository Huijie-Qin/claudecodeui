import express from 'express';

import { multitenancyDb } from '../database/multitenancy-db.js';
import { tenantContext } from '../middleware/tenant-context.js';
import { workspaceAccess } from '../services/workspace-access.js';

function sendRouteError(res, error) {
  const statusCode = error.statusCode || 500;
  res.status(statusCode).json({ error: error.message || 'Internal server error' });
}

export function createWorkspacesRouter({
  multitenancy = multitenancyDb,
  access = workspaceAccess,
  tenantMiddleware = tenantContext,
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

  return router;
}

export default createWorkspacesRouter();
