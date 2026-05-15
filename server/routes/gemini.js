import express from 'express';
import { IS_PLATFORM } from '../constants/config.js';
import sessionManager from '../sessionManager.js';
import { sessionNamesDb } from '../database/db.js';
import { multitenancyDb } from '../database/multitenancy-db.js';
import { resolveWorkspaceForRequest } from '../services/workspace-request.js';

const router = express.Router();

router.delete('/sessions/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;

        if (!sessionId || typeof sessionId !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(sessionId)) {
            return res.status(400).json({ success: false, error: 'Invalid session ID format' });
        }

        const userId = req.user?.id ?? req.user?.userId;
        let tenantId = Number(req.query.tenantId || req.headers['x-tenant-id']);
        let workspaceId;

        if (IS_PLATFORM) {
            const { workspace } = resolveWorkspaceForRequest(req, { requireEdit: true });
            tenantId = workspace.tenant_id;
            workspaceId = workspace.id;
        }

        if (!tenantId || !userId) {
            return res.status(400).json({ success: false, error: 'tenantId and userId are required' });
        }

        const queryArgs = {
          tenantId,
          userId,
          provider: 'gemini',
          providerSessionId: sessionId,
        };
        if (workspaceId) {
          queryArgs.workspaceId = workspaceId;
        }

        const ownedSession = multitenancyDb.sessions.findOwnedSession(queryArgs);
        if (!ownedSession) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

    await sessionManager.deleteSession(sessionId);
    sessionNamesDb.deleteName(sessionId, 'gemini');
    multitenancyDb.sessions.markDeleted({
      tenantId,
      userId,
      provider: 'gemini',
      providerSessionId: sessionId,
      workspaceId: ownedSession.workspace_id,
    });
    res.json({ success: true });
    } catch (error) {
        console.error(`Error deleting Gemini session ${req.params.sessionId}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
