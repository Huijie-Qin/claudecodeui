import express from 'express';

import { userDb } from '../database/db.js';
import { multitenancyDb } from '../database/multitenancy-db.js';

function requireSystemAdmin(req, res, next) {
  if (req.user?.is_system_admin !== 1 && req.user?.is_system_admin !== true) {
    return res.status(403).json({ error: 'System admin access required' });
  }
  return next();
}

export function createAdminRouter(multitenancy = multitenancyDb, users = userDb) {
  const router = express.Router();
  router.use(requireSystemAdmin);

  router.get('/tenants', (req, res) => {
    res.json({ tenants: multitenancy.tenants.listTenants() });
  });

  router.post('/tenants', (req, res) => {
    const tenant = multitenancy.tenants.createTenant({
      code: req.body?.code,
      name: req.body?.name,
      status: req.body?.status || 'active',
    });
    res.status(201).json({ tenant });
  });

  router.get('/users', (req, res) => {
    const rows = users.listUsers ? users.listUsers() : [];
    res.json({ users: rows });
  });

  router.put('/tenants/:tenantId/users/:userId', (req, res) => {
    const membership = multitenancy.memberships.upsertMembership({
      tenantId: Number(req.params.tenantId),
      userId: Number(req.params.userId),
      role: req.body?.role || 'member',
      permission: req.body?.permission || 'view',
      status: req.body?.status || 'active',
    });
    res.json({ membership });
  });

  return router;
}

export { requireSystemAdmin };
export default createAdminRouter(multitenancyDb, userDb);
