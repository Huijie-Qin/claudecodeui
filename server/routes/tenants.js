import express from 'express';

import { multitenancyDb } from '../database/multitenancy-db.js';
import { checkOpenApiAgentList } from '../services/openapi-agent.js';

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

function getTenantMembership(multitenancy, user, tenantId) {
  let membership = multitenancy.memberships.getActiveMembership(user.id, tenantId);
  if (!membership && isSystemAdmin(user)) {
    membership = multitenancy.memberships.grantSystemAdminAccessToTenant?.({
      userId: user.id,
      tenantId,
    }) ?? null;
  }
  return membership;
}

export function createTenantsRouter(
  multitenancy = multitenancyDb,
  openApiAgent = { checkOpenApiAgentList },
) {
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
    const membership = getTenantMembership(multitenancy, req.user, tenantId);

    if (!membership) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    return res.json({ valid: true, membership });
  });

  router.post('/:tenantId/agent-list-check', async (req, res) => {
    try {
      const tenantId = Number(req.params.tenantId);
      const membership = getTenantMembership(multitenancy, req.user, tenantId);

      if (!membership) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const tenant = multitenancy.tenants.getTenantById?.(tenantId);
      const tenantCode = tenant?.prod_code;
      const accountId = req.user?.username;
      if (!tenantCode || !accountId) {
        return res.status(400).json({ error: 'prod_code and username are required' });
      }

      const result = await openApiAgent.checkOpenApiAgentList({ tenantCode, accountId });
      return res.json(result);
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        error: error.message || 'Failed to check OpenAPI agent list',
      });
    }
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
