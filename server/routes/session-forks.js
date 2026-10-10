import express from 'express';

import { getRequestTenantId, getRequestUserId, getRequestWorkspaceId } from '../services/workspace-request.js';

export function createSessionForkRouter(forkService, middleware = []) {
  const router = express.Router();
  router.post('/:sessionId/fork', ...middleware, async (req, res) => {
    try {
      const result = await forkService.fork({
        tenantId: getRequestTenantId(req),
        userId: getRequestUserId(req),
        workspaceId: getRequestWorkspaceId(req),
        sourceSessionId: req.params.sessionId,
        provider: req.body?.provider || 'claude',
        sourceMessageUuid: req.body?.sourceMessageUuid,
        requestId: req.body?.requestId,
      });
      res.status(201).json(result);
    } catch (error) {
      if (!error.statusCode || error.statusCode >= 500) console.error('[SessionFork]', error);
      res.status(error.statusCode || 500).json({
        error: error.statusCode && error.statusCode < 500 ? error.message : 'Failed to branch this conversation',
        code: error.code || 'SESSION_FORK_FAILED',
      });
    }
  });
  return router;
}
