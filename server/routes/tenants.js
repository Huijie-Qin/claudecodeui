import express from 'express';

import { multitenancyDb } from '../database/multitenancy-db.js';

export function createTenantsRouter(multitenancy = multitenancyDb) {
  const router = express.Router();

  router.get('/me', (req, res) => {
    const tenants = multitenancy.tenants.listTenantsForUser(req.user.id);
    res.json({ tenants });
  });

  router.get('/:tenantId/validate', (req, res) => {
    const tenantId = Number(req.params.tenantId);
    const membership = multitenancy.memberships.getActiveMembership(req.user.id, tenantId);
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
