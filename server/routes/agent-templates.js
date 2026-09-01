import express from 'express';

import { multitenancyDb } from '../database/multitenancy-db.js';
import { agentTemplateService } from '../services/agent-templates.js';

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const tenantId = Number(req.query.tenantId || req.headers['x-tenant-id']);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    if (!req.user?.id || !multitenancyDb.memberships.getActiveMembership(req.user.id, tenantId)) {
      return res.status(403).json({ error: 'Tenant access denied' });
    }
    return res.json({ templates: agentTemplateService.listAvailableTemplates({ tenantId }) });
  } catch (error) {
    const statusCode = error?.statusCode || 400;
    return res.status(statusCode).json({
      error: error instanceof Error ? error.message : 'Failed to list Agent templates',
    });
  }
});

export default router;

