/**
 * Unified messages endpoint.
 *
 * GET /api/sessions/:sessionId/messages?provider=claude&projectName=foo&limit=50&offset=0
 *
 * Replaces the four provider-specific session message endpoints with a single route
 * that delegates to the appropriate adapter via the provider registry.
 *
 * @module routes/messages
 */

import express from 'express';
import { multitenancyDb } from '../database/multitenancy-db.js';
import { sessionsService } from '../modules/providers/services/sessions.service.js';
import { createSessionMessageHistoryService } from '../services/session-message-history.js';

const router = express.Router();
const sessionMessageHistoryService = createSessionMessageHistoryService({
  multitenancy: multitenancyDb,
  providerSessions: sessionsService,
});

/**
 * GET /api/sessions/:sessionId/messages
 *
 * Auth: authenticateToken applied at mount level in index.js
 *
 * Query params:
 *   provider    - 'claude' | 'cursor' | 'codex' | 'gemini' (default: 'claude')
 *   projectName - required for claude provider
 *   projectPath - required for cursor provider (absolute path used for cwdId hash)
 *   limit       - page size (omit or null for all)
 *   offset      - pagination offset (default: 0)
 */
router.get('/:sessionId/messages', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const provider = String(req.query.provider || 'claude').trim().toLowerCase();
    const tenantId = Number(req.query.tenantId || req.headers['x-tenant-id']);
    const workspaceId = Number(req.query.workspaceId);
    const userId = req.user?.id ?? req.user?.userId;
    const normalizedWorkspaceId = Number.isInteger(workspaceId) && workspaceId > 0 ? workspaceId : null;
    const limitParam = req.query.limit;
    const limit = limitParam !== undefined && limitParam !== null && limitParam !== ''
      ? parseInt(limitParam, 10)
      : null;
    const offset = parseInt(req.query.offset || '0', 10);

    const availableProviders = sessionsService.listProviderIds();
    if (!availableProviders.includes(provider)) {
      const available = availableProviders.join(', ');
      return res.status(400).json({ error: `Unknown provider: ${provider}. Available: ${available}` });
    }

    if (!tenantId || !userId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const ownedSession = multitenancyDb.sessions.findOwnedSession({
      tenantId,
      userId,
      provider,
      providerSessionId: sessionId,
      ...(normalizedWorkspaceId != null ? { workspaceId: normalizedWorkspaceId } : {}),
    });
    if (!ownedSession) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const result = await sessionMessageHistoryService.fetchHistory({
      tenantId,
      userId,
      provider,
      providerSessionId: sessionId,
      ownedSession,
      limit,
      offset,
    });

    return res.json(result);
  } catch (error) {
    console.error('Error fetching unified messages:', error);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

export default router;
