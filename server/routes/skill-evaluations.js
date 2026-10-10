import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import multer from 'multer';
import express from 'express';

import { tenantContext } from '../middleware/tenant-context.js';
import { workspaceAccess } from '../services/workspace-access.js';
import { getRequestUserId, getRequestWorkspaceId, handleWorkspaceError } from '../services/workspace-request.js';
import { skillEvaluationService } from '../services/skill-evals/index.js';
import { invocationForMessage, saveInvocation } from '../services/skill-evals/invocations.js';
import { fail, inputFileName, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from '../services/skill-evals/contracts.js';
import { withSkillLock } from '../services/skill-evals/coordination.js';
import { syncManagedSkillAfterMutation } from '../services/workspace-skills.js';

export function createSkillEvaluationsRouter({ access = workspaceAccess, service = skillEvaluationService, tenantMiddleware = tenantContext } = {}) {
  const router = express.Router();
  router.use(tenantMiddleware);
  function scope(req, edit = false) {
    const args = { tenantId: req.tenant?.id, userId: getRequestUserId(req), workspaceId: getRequestWorkspaceId(req) };
    const { workspace, accessRole } = access.requireWorkspace({ ...args, requireEdit: edit });
    return { ...args, workspacePath: workspace.path, name: req.params.name, accessRole };
  }
  const route = (method, url, edit, handler) => router[method](url, async (req, res) => {
    try { await handler(req, res, scope(req, edit)); } catch (error) { handleWorkspaceError(res, error); }
  });
  const base = '/:workspaceId/skills/:name';
  route('get', '/:workspaceId/skill-invocations', false, async (req, res, s) => res.json({ invocation: s.accessRole === 'view' ? null : invocationForMessage(s, String(req.query.messageId || '')) }));
  route('post', `${base}/eval-cases/from-invocation`, true, async (req, res, s) => res.json(await saveInvocation(s, req.body.invocationId, req.body.expectedRevision)));
  route('get', `${base}/eval-cases`, false, async (req, res, s) => res.json({ ...await service.listCases(s), canManage: s.accessRole !== 'view' }));
  route('post', `${base}/eval-cases`, true, async (req, res, s) => {
    await service.mutateCases(s, req.body.expectedRevision, (doc, id) => doc.evals.push({ ...req.body.case, id }));
    res.status(201).json(await service.listCases(s));
  });
  route('patch', `${base}/eval-cases/:caseId`, true, async (req, res, s) => {
    await service.mutateCases(s, req.body.expectedRevision, (doc) => {
      const entry = doc.evals.find((c) => c.id === Number(req.params.caseId));
      if (!entry) throw fail('Case not found', 'EVAL_NOT_FOUND', 404);
      Object.assign(entry, req.body.case, { id: entry.id });
    });
    res.json(await service.listCases(s));
  });
  route('delete', `${base}/eval-cases/:caseId`, true, async (req, res, s) => {
    await service.mutateCases(s, req.body.expectedRevision, (doc) => { doc.evals = doc.evals.filter((c) => c.id !== Number(req.params.caseId)); });
    res.json(await service.listCases(s));
  });
  route('post', `${base}/eval-case-jobs`, true, async (req, res, s) => {
    res.status(202).json({ job: await service.generateCases(s, req.body.expectedRevision, req.body.requestId) });
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
  router.post(`${base}/eval-inputs`, (req, res, next) => {
    try { scope(req, true); next(); } catch (e) { handleWorkspaceError(res, e); }
  }, (req, res, next) => upload.single('file')(req, res, (e) => e ? handleWorkspaceError(res, fail('Input upload failed or exceeded the size limit', 'EVAL_LIMIT_EXCEEDED', 413)) : next()), async (req, res) => {
    try {
      const s = scope(req, true);
      if (!req.file) throw fail('A file is required');
      let relative;
      await withSkillLock(s.workspacePath, s.name, async () => {
        const current = await service.files.load(s);
        if (Object.values(current.files).reduce((sum, value) => sum + Buffer.from(value, 'base64').length, 0) + req.file.size > MAX_TOTAL_BYTES) throw fail('Total input size limit exceeded', 'EVAL_LIMIT_EXCEEDED', 413);
        relative = `evals/files/${randomUUID()}/${inputFileName(typeof req.body.fileName === 'string' ? req.body.fileName : req.file.originalname)}`;
        const destination = path.join(current.context.rootPath, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, req.file.buffer, { flag: 'wx', mode: 0o600 });
        await syncManagedSkillAfterMutation(current.context, s.workspacePath);
      });
      res.status(201).json({ path: relative });
    } catch (e) { handleWorkspaceError(res, e); }
  });
  route('post', `${base}/evaluations`, true, async (req, res, s) => res.status(202).json({ job: await service.start(s, req.body) }));
  route('get', `${base}/evaluations/latest`, false, async (req, res, s) => res.json({ job: await service.latest(s) }));
  const jobs = '/:workspaceId/skill-jobs/:jobId';
  route('get', jobs, false, async (req, res, s) => res.json({ job: service.get(s, req.params.jobId) }));
  route('post', `${jobs}/cancel`, true, async (req, res, s) => res.json({ job: await service.cancel(s, req.params.jobId) }));
  route('get', `${jobs}/cases/:caseId`, false, async (req, res, s) => res.json(await service.report(s, req.params.jobId, Number(req.query.round || 0), Number(req.params.caseId))));
  route('get', `${jobs}/diff`, false, async (req, res, s) => res.json(await service.diff(s, req.params.jobId)));
  route('get', `${jobs}/artifacts/:caseId`, false, async (req, res, s) => {
    const buffer = await service.artifact(s, req.params.jobId, Number(req.query.round || 0), Number(req.params.caseId), String(req.query.name || ''));
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }).send(buffer);
  });
  return router;
}
export default createSkillEvaluationsRouter();
