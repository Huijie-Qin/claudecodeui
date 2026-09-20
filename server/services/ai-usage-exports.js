import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { aiUsageError } from './ai-usage-access.js';

const DATASETS = new Set(['users', 'hooks', 'templates']);
const ONE_DAY = 86400000;

// Serializers are code-owned presets, not request-controlled formats or file paths.
// No default serializer is installed until product export fields have been approved.
export function createAiUsageExportService({ db, accessService, queryService, directory, serializers = {}, now = () => new Date(), maxBytes = 10 * 1024 * 1024 }) {
  let timer = null;
  let active = false;
  const instant = () => now().toISOString();
  const configured = () => Boolean(directory && [...DATASETS].some((dataset) => typeof serializers[dataset]?.serialize === 'function'));

  function freshAccess(access) {
    return accessService.resolve({ userId: access.userId, tenantId: access.tenantId, scope: access.scope });
  }

  function currentRevision(tenantId) {
    return db.prepare('SELECT data_revision FROM ai_usage_tenant_state WHERE tenant_id = ?').get(tenantId)?.data_revision ?? 0;
  }

  function checkRevision(job) {
    if (currentRevision(job.tenant_id) !== job.data_revision) throw aiUsageError(409, 'exportSnapshotInvalidated', 'Report data was removed; create a new export');
  }

  function checkCurrentBatch(job) {
    if (db.prepare('SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=?').get(job.tenant_id)?.active_batch_id !== job.batch_id) {
      throw aiUsageError(409, 'reportUpdated', 'Report has been refreshed; create a new export');
    }
  }

  function publicJob(job) {
    return { id: job.id, tenantId: job.tenant_id, scope: job.scope, batchId: job.batch_id, dataset: job.dataset,
      status: Date.parse(job.expires_at) <= now().getTime() ? 'expired' : job.status,
      createdAt: job.created_at, expiresAt: job.expires_at, errorCode: job.error_code,
      sizeBytes: job.size_bytes, downloadReady: job.status === 'ready' && Date.parse(job.expires_at) > now().getTime() };
  }

  function enqueue(access, request = {}) {
    const authorized = freshAccess(access);
    const dataset = request.dataset;
    if (!configured() || !DATASETS.has(dataset) || typeof serializers[dataset]?.serialize !== 'function') throw aiUsageError(503, 'exportNotConfigured', 'Export fields and format have not been configured');
    if (dataset === 'users' && authorized.scope !== 'tenant') throw aiUsageError(403, 'tenantReportDenied', 'Tenant user list requires tenant report access');
    if (!request.batchId) throw aiUsageError(400, 'batchRequired', 'Export must bind the displayed report batch');
    const { meta } = queryService.context(authorized, request);
    if (!meta.batchId) throw aiUsageError(409, 'dataNotGenerated', 'No published report is available');
    const id = crypto.randomUUID();
    const createdAt = instant();
    const filters = { batchId: meta.batchId, from: meta.from, to: meta.to };
    for (const key of ['provider', 'userId', 'workspaceId', 'search', 'userSearch', 'workspaceSearch', 'sortBy', 'sortDir', 'postActionId', 'recordType', 'recordSource', 'hookVersion']) if (request[key] != null) filters[key] = request[key];
    db.transaction(() => {
      const count = db.prepare("SELECT COUNT(*) AS n FROM ai_usage_export_jobs WHERE tenant_id = ? AND user_id = ? AND status IN ('queued', 'running') AND expires_at > ?").get(authorized.tenantId, authorized.userId, createdAt).n;
      if (count >= 3) throw aiUsageError(429, 'tooManyExports', 'At most three pending exports are allowed');
      db.prepare(`INSERT INTO ai_usage_export_jobs(id, tenant_id, user_id, scope, batch_id, dataset, filters_json, data_revision, status, created_at, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(id, authorized.tenantId, authorized.userId, authorized.scope, meta.batchId, dataset, JSON.stringify(filters), currentRevision(authorized.tenantId), createdAt, createdAt, new Date(now().getTime() + ONE_DAY).toISOString());
    }).immediate();
    return get(authorized, id);
  }

  function get(access, id) {
    freshAccess(access);
    const job = db.prepare('SELECT * FROM ai_usage_export_jobs WHERE id = ? AND tenant_id = ? AND user_id = ?').get(String(id), access.tenantId, access.userId);
    if (!job) throw aiUsageError(404, 'exportNotFound', 'Export not found');
    accessService.resolve({ tenantId: job.tenant_id, userId: job.user_id, scope: job.scope });
    return publicJob(job);
  }

  function list(access) {
    const authorized = freshAccess(access);
    const jobs = db.prepare('SELECT * FROM ai_usage_export_jobs WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 50').all(access.tenantId, access.userId);
    return { items: jobs.filter((job) => job.scope !== 'tenant' || authorized.canViewTenant).map(publicJob), exportConfigured: configured() };
  }

  async function download(access, id) {
    const job = get(access, id);
    if (job.status === 'expired') throw aiUsageError(410, 'exportExpired', 'Export has expired');
    if (!job.downloadReady) throw aiUsageError(409, 'exportNotReady', 'Export is not ready');
    const row = db.prepare('SELECT filename, mime_type FROM ai_usage_export_jobs WHERE id = ?').get(job.id);
    checkRevision(db.prepare('SELECT * FROM ai_usage_export_jobs WHERE id = ?').get(job.id));
    if (!directory || !row.filename || path.basename(row.filename) !== row.filename) throw aiUsageError(410, 'exportExpired', 'Export file is unavailable');
    const file = path.join(path.resolve(directory), row.filename);
    try { await fs.access(file); } catch { throw aiUsageError(410, 'exportExpired', 'Export file is unavailable'); }
    // Authorization may have changed while checking the file.
    get(access, id);
    checkRevision(db.prepare('SELECT * FROM ai_usage_export_jobs WHERE id = ?').get(job.id));
    return { path: file, filename: row.filename, mimeType: row.mime_type };
  }

  async function tick() {
    if (active || !configured()) return false;
    active = true;
    let job;
    let temporary;
    let finalFile;
    try {
      const timestamp = instant();
      job = db.transaction(() => {
        const candidate = db.prepare("SELECT * FROM ai_usage_export_jobs WHERE expires_at > ? AND (status = 'queued' OR (status = 'running' AND lease_until < ?)) ORDER BY created_at, id LIMIT 1").get(timestamp, timestamp);
        if (!candidate) return null;
        const token = crypto.randomUUID();
        db.prepare("UPDATE ai_usage_export_jobs SET status = 'running', lease_token = ?, lease_until = ?, updated_at = ? WHERE id = ?").run(token, new Date(now().getTime() + 30 * 60000).toISOString(), timestamp, candidate.id);
        return { ...candidate, lease_token: token };
      }).immediate();
      if (!job) return false;
      const access = accessService.resolve({ userId: job.user_id, tenantId: job.tenant_id, scope: job.scope });
      checkRevision(job);
      checkCurrentBatch(job);
      const preset = serializers[job.dataset];
      if (!preset || !/^[a-z0-9]{1,8}$/.test(preset.extension || '') || typeof preset.mimeType !== 'string' || /[\r\n]/.test(preset.mimeType)) throw aiUsageError(503, 'exportNotConfigured', 'Export preset unavailable');
      const filters = JSON.parse(job.filters_json);
      queryService.context(access, filters);
      // The preset receives only report-query functions, not a database/raw-source handle.
      const content = await preset.serialize({ query: queryService, access, filters });
      checkCurrentBatch(job);
      if (!(typeof content === 'string' || Buffer.isBuffer(content)) || Buffer.byteLength(content) > maxBytes) throw aiUsageError(413, 'exportTooLarge', 'Export exceeds the configured size limit');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const filename = `${job.id}-${job.lease_token}.${preset.extension}`;
      finalFile = path.join(directory, filename);
      temporary = `${finalFile}.tmp`;
      await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, finalFile);
      temporary = null;
      freshAccess(access);
      checkRevision(job);
      const updated = db.transaction(() => {
        checkRevision(job);
        checkCurrentBatch(job);
        return db.prepare("UPDATE ai_usage_export_jobs SET status = 'ready', filename = ?, mime_type = ?, size_bytes = ?, updated_at = ?, lease_until = NULL WHERE id = ? AND lease_token = ? AND status = 'running' AND expires_at > ? AND lease_until > ?").run(filename, preset.mimeType, Buffer.byteLength(content), instant(), job.id, job.lease_token, instant(), instant());
      }).immediate();
      if (updated.changes) finalFile = null;
      return Boolean(updated.changes);
    } catch (error) {
      if (job) db.prepare("UPDATE ai_usage_export_jobs SET status = 'failed', error_code = ?, updated_at = ?, lease_until = NULL WHERE id = ? AND lease_token = ? AND status = 'running'").run(error?.code && !String(error.code).startsWith('SQLITE') ? String(error.code) : 'exportFailed', instant(), job.id, job.lease_token);
      return false;
    } finally {
      // Only generated, exact job paths are removed; no user paths are accepted.
      if (temporary) await fs.unlink(temporary).catch(() => {});
      if (finalFile) await fs.unlink(finalFile).catch(() => {});
      active = false;
    }
  }

  function start() { if (!timer && configured()) { timer = setInterval(() => { void tick(); }, 1000); timer.unref?.(); } }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { configured, enqueue, get, list, download, tick, start, stop };
}
