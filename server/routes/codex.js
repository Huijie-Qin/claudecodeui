import express from 'express';
import { deleteCodexSession } from '../projects.js';
import { sessionNamesDb } from '../database/db.js';
import { multitenancyDb } from '../database/multitenancy-db.js';

const router = express.Router();

router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const tenantId = Number(req.query.tenantId || req.headers['x-tenant-id']);
    const userId = req.user?.id ?? req.user?.userId;
    const ownedSession = multitenancyDb.sessions.findOwnedSession({
      tenantId,
      userId,
      provider: 'codex',
      providerSessionId: sessionId,
    });
    if (!ownedSession) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    await deleteCodexSession(sessionId);
    sessionNamesDb.deleteName(sessionId, 'codex');
    multitenancyDb.sessions.markDeleted({ tenantId, userId, provider: 'codex', providerSessionId: sessionId });
    res.json({ success: true });
  } catch (error) {
    console.error(`Error deleting Codex session ${req.params.sessionId}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
