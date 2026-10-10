import express from 'express';

import { createAiUsageAccessService, aiUsageError } from '../services/ai-usage-access.js';
import { createAiUsageQueryService } from '../services/ai-usage-query.js';
import { createAiUsageExportService } from '../services/ai-usage-exports.js';

export function createAiUsageRouter({ db, getScheduleStatus = () => ({}), accessService = createAiUsageAccessService({ db }), queryService = createAiUsageQueryService({ db, getScheduleStatus }), exportService = createAiUsageExportService({ db, accessService, queryService }) } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    try {
      const tenantId = req.query.tenantId ?? req.headers['x-tenant-id'] ?? req.tenant?.id;
      req.aiUsageAccess = accessService.resolve({ userId: req.user?.id ?? req.user?.userId, tenantId, scope: req.query.scope ?? req.body?.scope });
      res.setHeader('Cache-Control', 'private, no-store');
      next();
    } catch (error) { next(error); }
  });
  router.get('/capabilities', (req, res) => res.json({ ...req.aiUsageAccess, exportConfigured: exportService.configured(), codeReportAvailable: true }));
  router.get('/status', (req, res) => res.json(queryService.status(req.aiUsageAccess, req.query.batchId)));
  for (const endpoint of ['overview', 'summary', 'trend', 'users', 'skills', 'hooks', 'templates', 'analysis', 'code']) {
    router.get(`/${endpoint}`, (req, res) => res.json(queryService[endpoint](req.aiUsageAccess, req.query)));
  }
  router.get('/code-records', (req, res) => res.json(queryService.codeRecords(req.aiUsageAccess, req.query)));
  router.get('/hook-field-statistics', (req, res) => res.json(queryService.hookFieldStatistics(req.aiUsageAccess, req.query)));
  router.get('/hook-executions', (req, res) => res.json(queryService.hookExecutions(req.aiUsageAccess, req.query)));
  router.get('/hook-executions/:id/records', (req, res) => res.json(queryService.hookExecutionRecords(req.aiUsageAccess, req.params.id, req.query)));
  router.get('/hooks/:id/records', (req, res) => res.json(queryService.hookRecords(req.aiUsageAccess, req.params.id, req.query)));
  router.get('/hooks/:id/statistics', (req, res) => res.json(queryService.hookStatistics(req.aiUsageAccess, req.params.id, req.query)));
  router.get('/hooks/:id/field-statistics', (req, res) => res.json(queryService.hookStatistics(req.aiUsageAccess, req.params.id, req.query, true, true)));
  router.get('/templates/:id/applications', (req, res) => res.json(queryService.templateApplications(req.aiUsageAccess, req.params.id, req.query)));
  router.get('/templates/:id/sessions', (req, res) => res.json(queryService.templateSessions(req.aiUsageAccess, req.params.id, req.query)));
  router.get('/agent-templates', (req, res) => res.json(queryService.templates(req.aiUsageAccess, req.query)));
  router.get('/agent-templates/:id/applications', (req, res) => res.json(queryService.templateApplications(req.aiUsageAccess, req.params.id, req.query)));
  router.get('/agent-templates/:id/sessions', (req, res) => res.json(queryService.templateSessions(req.aiUsageAccess, req.params.id, req.query)));
  router.get('/exports', (req, res) => res.json(exportService.list(req.aiUsageAccess)));
  router.post('/exports', (req, res) => res.status(202).json({ job: exportService.enqueue(req.aiUsageAccess, req.body) }));
  router.get('/exports/:id', (req, res) => res.json({ job: exportService.get(req.aiUsageAccess, req.params.id) }));
  router.get('/exports/:id/download', async (req, res, next) => {
    try {
      const file = await exportService.download(req.aiUsageAccess, req.params.id);
      res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.download(file.path, file.filename, (error) => { if (error) next(res.headersSent ? error : aiUsageError(410, 'exportExpired', 'Export file is unavailable')); });
    } catch (error) { next(error); }
  });
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.statusCode || 500;
    return res.status(status).json({ error: status === 500 ? 'AI report unavailable' : error.message, code: error.code || 'reportUnavailable' });
  });
  return router;
}
