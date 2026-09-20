import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { fixture } from './ai-usage-test-fixture.js';
import { createAiUsageExportService } from './ai-usage-exports.js';

test('exports are unavailable until a code-owned format is configured', (t) => {
  const f = fixture(t);
  f.batch();
  const service = createAiUsageExportService({ ...f });
  assert.equal(service.configured(), false);
  assert.throws(() => service.enqueue(f.access, { dataset: 'users', batchId: 'batch-1' }), { code: 'exportNotConfigured' });
  assert.equal(service.list(f.access).items.length, 0);
});

test('export is persistent, batch bound, asynchronous and rechecks scope at download', async (t) => {
  const f = fixture(t);
  f.batch();
  f.row({ id: 'i1', dataset: 'interactions' });
  f.db.exec("INSERT INTO workspaces VALUES(7,10,'研发工作区','active'),(8,10,'产品工作区','active')");
  f.row({ id: 'not-matched', dataset: 'interactions', userId: 4, workspaceId: 8, sessionKey: 'product-session' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-export-test-'));
  t.after(async () => { for (const file of await fs.readdir(directory)) await fs.unlink(path.join(directory, file)); await fs.rmdir(directory); });
  const options = { ...f, directory, serializers: { users: { extension: 'csv', mimeType: 'text/csv', serialize: async ({ query, access, filters }) => `sessions\n${query.overview(access, filters).sessionCount}\n` } } };
  const service = createAiUsageExportService(options);
  const job = service.enqueue(f.access, { dataset: 'users', batchId: 'batch-1', userSearch: 'member', workspaceSearch: '研发' });
  const savedFilters = JSON.parse(f.db.prepare('SELECT filters_json FROM ai_usage_export_jobs WHERE id=?').get(job.id).filters_json);
  assert.equal(savedFilters.userSearch, 'member'); assert.equal(savedFilters.workspaceSearch, '研发');
  assert.equal(job.status, 'queued');
  assert.equal((await fs.readdir(directory)).length, 0);
  const restarted = createAiUsageExportService(options);
  assert.equal(await restarted.tick(), true);
  // Completed files remain immutable and available after a report refresh.
  f.batch('batch-2');
  f.row({ id: 'i2', dataset: 'interactions', batchId: 'batch-2', sessionKey: 'session-new' });
  const file = await restarted.download(f.access, job.id);
  assert.equal(await fs.readFile(file.path, 'utf8'), 'sessions\n1\n');
  assert.equal(restarted.get(f.access, job.id).batchId, 'batch-1');
  const member = f.accessService.resolve({ tenantId: 10, userId: 3 });
  assert.throws(() => restarted.get(member, job.id), { statusCode: 404 });
  f.db.exec("UPDATE tenant_users SET role='member' WHERE user_id=2");
  await assert.rejects(restarted.download(f.access, job.id), { statusCode: 403 });
});

test('permission revoked during serialization prevents an artifact from becoming downloadable', async (t) => {
  const f = fixture(t);
  f.batch();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-export-test-'));
  t.after(async () => { for (const file of await fs.readdir(directory)) await fs.unlink(path.join(directory, file)); await fs.rmdir(directory); });
  const service = createAiUsageExportService({ ...f, directory, serializers: { users: { extension: 'csv', mimeType: 'text/csv', serialize: async () => { f.db.exec("UPDATE tenant_users SET status='disabled' WHERE user_id=2"); return 'secret'; } } } });
  const job = service.enqueue(f.access, { dataset: 'users', batchId: 'batch-1' });
  assert.equal(await service.tick(), false);
  assert.equal(f.db.prepare('SELECT status FROM ai_usage_export_jobs WHERE id=?').get(job.id).status, 'failed');
  assert.deepEqual(await fs.readdir(directory), []);
});

test('a deletion revision invalidates an already generated export without reading Hook sources', async (t) => {
  const f = fixture(t);
  f.batch();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-export-test-'));
  t.after(async () => { for (const file of await fs.readdir(directory)) await fs.unlink(path.join(directory, file)); await fs.rmdir(directory); });
  const service = createAiUsageExportService({ ...f, directory, serializers: { hooks: { extension: 'csv', mimeType: 'text/csv', serialize: async () => 'previous projection' } } });
  const job = service.enqueue(f.access, { dataset: 'hooks', batchId: 'batch-1', recordSource: 'post_action' });
  assert.equal(await service.tick(), true);
  f.db.exec('UPDATE ai_usage_tenant_state SET data_revision=data_revision+1 WHERE tenant_id=10');
  await assert.rejects(service.download(f.access, job.id), { code: 'exportSnapshotInvalidated' });
});

for (const timing of ['queued', 'serializing']) test(`refresh while ${timing} fails export instead of mixing batches`, async (t) => {
  const f = fixture(t); f.batch();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-export-refresh-'));
  t.after(async () => { for (const file of await fs.readdir(directory)) await fs.unlink(path.join(directory, file)); await fs.rmdir(directory); });
  const service = createAiUsageExportService({ ...f, directory, serializers: { hooks: {
    extension: 'csv', mimeType: 'text/csv', serialize: async () => {
      if (timing === 'serializing') f.batch('batch-2');
      return 'must not be published';
    },
  } } });
  const job = service.enqueue(f.access, { dataset: 'hooks', batchId: 'batch-1' });
  if (timing === 'queued') f.batch('batch-2');
  assert.equal(await service.tick(), false);
  assert.equal(service.get(f.access, job.id).errorCode, 'reportUpdated');
  assert.equal(service.get(f.access, job.id).downloadReady, false);
  assert.deepEqual(await fs.readdir(directory), []);
});
