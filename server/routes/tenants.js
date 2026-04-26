import express from 'express';

import { multitenancyDb } from '../database/multitenancy-db.js';

function isSystemAdmin(user) {
  return user?.is_system_admin === 1 || user?.is_system_admin === true;
}

function withSystemAdminTenantAccess(tenant) {
  return {
    ...tenant,
    role: 'system_admin',
    permission: 'edit',
  };
}

export function createTenantsRouter(multitenancy = multitenancyDb) {
  const router = express.Router();

  router.get('/me', (req, res) => {
    if (isSystemAdmin(req.user)) {
      multitenancy.memberships.grantSystemAdminAccessToAllTenants?.(req.user.id);
      const tenants = multitenancy.tenants
        .listTenants()
        .filter((tenant) => tenant.status === 'active')
        .map(withSystemAdminTenantAccess);
      return res.json({ tenants });
    }

    const tenants = multitenancy.tenants.listTenantsForUser(req.user.id);
    return res.json({ tenants });
  });

  router.get('/:tenantId/validate', (req, res) => {
    const tenantId = Number(req.params.tenantId);
    let membership = multitenancy.memberships.getActiveMembership(req.user.id, tenantId);
    if (!membership && isSystemAdmin(req.user)) {
      membership = multitenancy.memberships.grantSystemAdminAccessToTenant?.({
        userId: req.user.id,
        tenantId,
      }) ?? null;
    }

    if (!membership) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    return res.json({ valid: true, membership });
  });

  router.post('/:tenantId/join-requests', (req, res) => {
    const tenantId = Number(req.params.tenantId);
    const request = multitenancy.joinRequests.createJoinRequest({
      tenantId,
      userId: req.user.id,
      message: typeof req.body?.message === 'string' ? req.body.message.trim() : null,
    });
    res.status(201).json({ request });
  });

  return router;
}

export default createTenantsRouter(multitenancyDb);
