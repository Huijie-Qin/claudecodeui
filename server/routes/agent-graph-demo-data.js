import express from 'express';

import { agentGraphDemoDataService } from '../services/agent-graph-demo-data.js';
import { FEATURE_FLAGS, featureFlagsService } from '../services/feature-flags.js';

function sendError(res, error) {
  return res.status(error?.statusCode || 500).json({
    error: error?.message || 'Demo data request failed',
  });
}

export function createAgentGraphDemoDataRouter({
  service = agentGraphDemoDataService,
  featureFlags = featureFlagsService,
} = {}) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!featureFlags.isEnabled(FEATURE_FLAGS.AGENT_GRAPH)) {
      return res.status(404).json({ error: 'Agent Graph demo data is not enabled' });
    }
    return next();
  });

  router.get('/catalog', (req, res) => {
    try {
      return res.json(service.getDemoDataCatalog());
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/music-reports/schema', (req, res) => {
    try {
      return res.json(service.getMusicReportSchema());
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/music-reports/query', (req, res) => {
    try {
      return res.json(service.queryMusicReports(req.query));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/audience-profiles/schema', (req, res) => {
    try {
      return res.json(service.getAudienceSchema());
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/audience-profiles/analyze', (req, res) => {
    try {
      return res.json(service.analyzeAudience(req.body));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/audience-profiles/sample', (req, res) => {
    try {
      return res.json(service.sampleAudience(req.body));
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

export default createAgentGraphDemoDataRouter();
