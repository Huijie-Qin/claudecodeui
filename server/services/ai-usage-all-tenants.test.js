import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';
import express from 'express';

import { createAiUsageRouter } from '../routes/ai-usage.js';

import { createAiUsageExportService } from './ai-usage-exports.js';
import { createAiUsageQueryService } from './ai-usage-query.js';
import { fixture } from './ai-usage-test-fixture.js';

const complete = { sessions: 'complete', duration: 'complete', activeUsers: 'complete', skillPublications: 'complete', skillInvocations: 'complete', hooks: 'complete', generatedSql: 'complete', codeSubmissions: 'complete' };
const range = { from: '2026-09-11', to: '2026-09-12' };
function allFixture(t) {
  const f = fixture(t);
  f.batch('batch-1', 10, 'published', complete);
  f.batch('batch-2', 20, 'published', complete);
  const all = f.accessService.resolve({ userId: 1, tenantId: 'all', scope: 'tenant' });
  function both(dataset, value = {}, options = {}) {
    for (const tenantId of [10, 20]) f.row({ id: `${dataset}-same`, dataset, value, tenantId, batchId: tenantId === 10 ? 'batch-1' : 'batch-2', ...options });
  }
  return { ...f, all, both };
}

test('all-tenant access requires the live active system administrator', t => {
  const { accessService, db } = fixture(t);
  for (const userId of [2, 3, 4]) assert.throws(() => accessService.resolve({ userId, tenantId: 'all', scope: 'tenant', is_system_admin: 1, canViewAllTenants: true }), { code: 'tenantReportDenied' });
  assert.equal(accessService.resolve({ userId: 1, tenantId: 'all' }).scope, 'tenant');
  assert.throws(() => accessService.resolve({ userId: 1, tenantId: 'all', scope: 'self' }), { code: 'invalidFilter' });
  db.exec('UPDATE users SET is_system_admin=0 WHERE id=1');
  assert.throws(() => accessService.resolve({ userId: 1, tenantId: 'all' }), { code: 'tenantReportDenied' });
  db.exec('UPDATE users SET is_system_admin=1,is_active=0 WHERE id=1');
  assert.throws(() => accessService.resolve({ userId: 1, tenantId: 'all' }), { code: 'authenticationRequired' });
});

test('all tabs aggregate published tenants without merging colliding sessions or skill identities', t => {
  const { db, queryService: q, all, both } = allFixture(t);
  db.exec("INSERT INTO workspaces VALUES(7,10,'Workspace A','active'),(8,20,'Workspace B','active')");
  both('interactions', { provider: 'claude', templateId: 'template-1', templateName: 'Template' });
  both('turns', { status: 'completed', durationMs: 3000, templateId: 'template-1', templateName: 'Template' });
  both('skill_publications', { publisherUserId: 3, skillName: 'Skill' }, { subjectId: 'same-skill' });
  both('skill_invocations', { publisherUserId: 3, callerUserId: 4, skillName: 'Skill' }, { subjectId: 'same-skill' });
  both('sql_generations', { generatedLines: 12 });
  both('code_submissions', { submittedLines: 25 }, { subjectId: 'same-code' });
  both('hook_records', { hookId: 'global-hook', hookName: 'Hook', fields: [{ key: 'n', type: 'number', label: 'N', value: 4 }] }, { subjectId: 'global-hook' });
  both('hook_executions', { hookName: 'Hook', status: 'succeeded', durationMs: 100 }, { subjectId: 'global-hook' });
  both('template_applications', { templateId: 'template-1', templateName: 'Template' }, { subjectId: 'template-1' });
  const meta = q.status(all);
  assert.match(meta.batchId, /^all:[a-f0-9]{64}$/);
  assert.deepEqual(meta.coverage.allTenants, { total: 2, published: 2, missing: 0, stale: 0 });
  const filters = { ...range, batchId: meta.batchId };
  const overview = q.overview(all, filters);
  assert.equal(overview.sessionCount, 2); assert.equal(overview.activeDurationMs, 6000);
  assert.equal(overview.publishedSkillCount, 2); assert.equal(overview.mau, 1);
  assert.equal(q.summary(all, filters).sessionCount, 2);
  assert.equal(q.summary(all, filters).publishedSkillCount, 2);
  assert.equal(q.trend(all, filters).items[0].sessionCount, 2);
  const analysis = q.analysis(all, { ...filters, includeZeroUsers: true });
  assert.equal(analysis.total, 3); assert.equal(analysis.summary.activeUserCount, 1);
  assert.equal(analysis.summary.sessionCount, 2);
  assert.equal(q.users(all, filters).items.find(item => item.userId === 3).sessionCount, 2);
  const skills = q.skills(all, filters);
  assert.equal(skills.total, 2); assert.equal(skills.summary.publishedSkillCount, 2);
  assert.deepEqual(skills.items.map(item => item.tenantId).sort(), [10,20]);
  assert.equal(q.skills(all, { ...filters, groupBy: 'publisher' }).items[0].invocationCount, 2);
  assert.equal(q.code(all, filters).summary.submittedLines, 50);
  assert.equal(q.code(all, filters).summary.generatedLines, 24);
  assert.equal(q.codeRecords(all, filters).total, 2);
  const records = q.hookRecords(all, 'global-hook', filters);
  assert.equal(records.total, 2); assert.equal(new Set(records.items.map(item => item.id)).size, 2);
  assert.equal(q.hookStatistics(all, 'global-hook', filters).items[0].sum, 8);
  assert.equal(q.hookFieldStatistics(all, filters).items[0].sum, 8);
  assert.equal(q.hooks(all, filters).items[0].recordCount, 2);
  assert.equal(q.hookExecutions(all, filters).items[0].executionCount, 2);
  assert.equal(q.hookExecutionRecords(all, 'global-hook', filters).total, 2);
  assert.equal(q.templates(all, filters).items[0].sessionCount, 2);
  assert.equal(q.templateApplications(all, 'template-1', filters).total, 2);
  assert.equal(q.templateSessions(all, 'template-1', filters).total, 2);
  assert.equal(q.integrationDetails(all, filters).total, 12);
  assert.equal(q.overview(all, { ...filters, userSearch: 'no-such-user' }).sessionCount, 0);
});

test('all snapshot locks global pagination and expires on any publication, membership, or tenant change', t => {
  const { db, queryService: q, all, both, batch } = allFixture(t);
  both('skill_publications', { publisherUserId: 3, skillName: 'Skill' }, { subjectId: 'same-skill' });
  let batchId = q.status(all).batchId;
  const first = q.skills(all, { ...range, batchId, pageSize: 1 });
  const second = q.skills(all, { ...range, batchId, pageSize: 1, page: 2 });
  assert.equal(first.total, 2); assert.notEqual(first.items[0].tenantId, second.items[0].tenantId);
  db.exec("UPDATE tenant_users SET status='removed' WHERE tenant_id=20 AND user_id=3");
  assert.throws(() => q.skills(all, { ...range, batchId }), { code: 'reportUpdated' });
  batchId = q.status(all).batchId;
  batch('new-20', 20, 'published', complete);
  assert.throws(() => q.code(all, { ...range, batchId }), { code: 'reportUpdated' });
  batchId = q.status(all).batchId;
  db.exec("UPDATE tenants SET status='disabled' WHERE id=20");
  assert.throws(() => q.status(all, batchId), { code: 'reportUpdated' });
  assert.deepEqual(q.status(all).coverage.allTenants, { total: 1, published: 1, missing: 0, stale: 0 });
});

test('missing and stale tenants are explicit and dates use the latest published cutoff', t => {
  const { db, queryService: q, all, both } = allFixture(t);
  both('interactions');
  db.exec("INSERT INTO tenants VALUES(30,'active'),(40,'disabled'); UPDATE ai_usage_batches SET target_through='2026-09-11T16:00:00.000Z' WHERE tenant_id=20");
  let status = q.status(all);
  assert.deepEqual(status.coverage.allTenants, { total: 3, published: 2, missing: 1, stale: 1 });
  assert.equal(status.coverage.status, 'partial'); assert.equal(status.dataThroughDate, '2026-09-12');
  assert.equal(q.overview(all, range).sessionCount, 2);
  assert.throws(() => q.overview(all, { to: '2026-09-13' }), { code: 'dataNotGenerated' });
  db.exec('UPDATE ai_usage_tenant_state SET active_batch_id=NULL');
  status = q.status(all);
  assert.equal(status.batchId, null); assert.equal(status.coverage.status, 'unavailable');
  assert.equal(q.overview(all, range).sessionCount, null);
  assert.equal(q.analysis(all, { ...range, includeZeroUsers: true }).total, 0);
});

test('all split reads fail closed if any published topic projection is not ready', t => {
  const { db, queryService: q, all } = allFixture(t);
  db.exec("UPDATE ai_dashboard_split_state SET batch_id='old' WHERE tenant_id=20");
  assert.throws(() => q.code(all, range), { code: 'splitNotReady' });
});

test('HTTP all scope rejects forged claims and background jobs before inserting tenant foreign keys', async t => {
  const f = allFixture(t);
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.user = { id: Number(req.headers['x-test-user'] || 1), is_system_admin: 1 }; next(); });
  app.use('/api/ai-usage', createAiUsageRouter(f));
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = async (path, userId = 1, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ai-usage${path}`, { method, headers: { 'x-test-user': String(userId) } });
    return { status: response.status, body: await response.json() };
  };
  for (const endpoint of ['status','capabilities','analysis','code','skills','summary','session-details']) assert.equal((await request(`/${endpoint}?tenantId=all&scope=tenant&canViewAllTenants=true`, 2)).status, 403);
  const caps = await request('/capabilities?tenantId=all');
  assert.equal(caps.status, 200); assert.equal(caps.body.canViewAllTenants, true); assert.equal(caps.body.exportConfigured, false);
  for (const endpoint of ['/exports','/exports/fake','/exports/fake/download']) assert.equal((await request(`${endpoint}?tenantId=all`)).body.code, 'allTenantExportJobsUnsupported');
  assert.equal((await request('/exports?tenantId=all', 1, 'POST')).status, 400);
  f.db.exec('UPDATE users SET is_system_admin=0 WHERE id=1');
  assert.equal((await request('/summary?tenantId=all')).status, 403);
});


test('missing tenant identity and diagnostic counters are retained in the all snapshot', t => {
  const { db, queryService: q, all } = allFixture(t);
  db.exec(`INSERT INTO tenants VALUES(30,'active');
    UPDATE ai_usage_batches SET coverage_json=json_set(coverage_json,'$.excludedSessionCount',2,'$.pendingTurns',3,'$.skippedDurationRecords',4)`);
  const before = q.status(all);
  assert.equal(before.coverage.excludedSessionCount, 4);
  assert.equal(before.coverage.pendingTurns, 6);
  assert.equal(before.coverage.skippedDurationRecords, 8);
  assert.equal(before.coverage.sessionScope, 'partial');
  db.exec('DELETE FROM tenants WHERE id=30; INSERT INTO tenants VALUES(31,\'active\')');
  assert.throws(() => q.status(all, before.batchId), { code: 'reportUpdated' });
});


test('all overview metadata and rows retain one SQLite read snapshot during another connection publication', t => {
  const f = allFixture(t); f.both('interactions');
  const dir = mkdtempSync(join(tmpdir(), 'ai-all-snapshot-'));
  const file = join(dir, 'usage.db');
  writeFileSync(file, f.db.serialize());
  const reader = new Database(file); reader.pragma('journal_mode = WAL');
  const writer = new Database(file);
  t.after(() => { reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); });
  let change = true;
  const q = createAiUsageQueryService({ db: reader, getScheduleStatus: () => {
    if (change) { change = false; writer.exec('UPDATE ai_usage_tenant_state SET active_batch_id=NULL WHERE tenant_id=20'); }
    return { timeZone: 'Asia/Shanghai' };
  } });
  const before = q.overview(f.all, range);
  assert.equal(before.sessionCount, 2);
  assert.equal(before.coverage.allTenants.published, 2);
  const after = q.overview(f.all, range);
  assert.equal(after.sessionCount, 1);
  assert.equal(after.coverage.allTenants.published, 1);
  assert.equal(after.coverage.allTenants.missing, 1);
  assert.throws(() => q.overview(f.all, { ...range, batchId: before.batchId }), { code: 'reportUpdated' });
});

test('all core reads use only published topic rows, excluding inactive and unfinished tenant partitions', t => {
  const f = allFixture(t); f.both('interactions');
  f.db.exec("INSERT INTO tenants VALUES(30,'disabled'),(40,'active')");
  f.batch('disabled',30,'published',complete);
  f.row({ id: 'private-disabled', dataset: 'interactions', tenantId: 30, batchId: 'disabled' });
  f.batch('unfinished',40,'published',complete);
  f.row({ id: 'private-unfinished', dataset: 'interactions', tenantId: 40, batchId: 'unfinished' });
  f.db.exec("UPDATE ai_usage_batches SET status='running' WHERE id='unfinished'");
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => {
    assert.doesNotMatch(sql, /\b(ai_usage_report_rows|ai_usage_fact_rows|ai_dashboard_integration_detail|agent_session_messages|ai_usage_turn_facts)\b/);
    return prepare(sql);
  };
  try {
    const overview = f.queryService.overview(f.all, range);
    assert.equal(overview.sessionCount, 2);
    assert.deepEqual(overview.coverage.allTenants, { total: 3, published: 2, missing: 1, stale: 0 });
  } finally { f.db.prepare = prepare; }
});


test('workspace renames and immediate deleted-session or suppressed-row changes expire pinned exports', t => {
  const f = allFixture(t);
  f.db.exec(`INSERT INTO workspaces VALUES(7,10,'A','active'),(8,20,'Z','active');
    CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT,status TEXT);
    INSERT INTO session_index VALUES(10,7,3,'claude','session-a','active')`);
  f.row({ id: 'code-a', dataset: 'code_submissions', value: { submittedLines: 5 } });
  f.row({ id: 'code-z', dataset: 'code_submissions', tenantId: 20, workspaceId: 8, batchId: 'batch-2', value: { submittedLines: 10 } });
  const filters = { ...range, groupBy: 'workspace', sortBy: 'groupLabel', sortDir: 'asc', pageSize: 1 };
  const first = f.queryService.code(f.all, filters);
  assert.equal(first.items[0].groupLabel, 'A');
  f.db.exec("UPDATE workspaces SET display_name='ZZ' WHERE id=7");
  assert.throws(() => f.queryService.code(f.all, { ...filters, batchId: first.batchId, page: 2 }), { code: 'reportUpdated' });
  let batchId = f.queryService.status(f.all).batchId;
  f.db.exec("UPDATE session_index SET status='deleted'");
  assert.throws(() => f.queryService.status(f.all, batchId), { code: 'reportUpdated' });
  batchId = f.queryService.status(f.all).batchId;
  f.db.exec("INSERT INTO ai_usage_suppressed_rows(tenant_id,dataset,row_key) VALUES(10,'hook_executions','deleted-execution')");
  assert.throws(() => f.queryService.status(f.all, batchId), { code: 'reportUpdated' });
});

test('all captured-turn diagnostics aggregate by status rather than becoming zero', t => {
  const { db, queryService: q, all } = allFixture(t);
  db.exec(`UPDATE ai_usage_batches SET coverage_json=json_set(coverage_json,'$.capturedTurns',json('{"completed":4,"failed":1}'))`);
  assert.deepEqual(q.status(all).coverage.capturedTurns, { completed: 8, failed: 2 });
});


test('background export service rejects all scope before any tenant job is written', t => {
  const f = allFixture(t);
  const service = createAiUsageExportService({ ...f, directory: '/tmp/unused', serializers: { users: { serialize: () => 'unused' } } });
  assert.throws(() => service.enqueue(f.all, { dataset: 'users', batchId: f.queryService.status(f.all).batchId }), { code: 'allTenantExportJobsUnsupported' });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_usage_export_jobs').get().n, 0);
  assert.throws(() => service.list(f.all), { code: 'allTenantExportJobsUnsupported' });
});


test('all snapshots support legacy session indexes without deletion status', t => {
  const f = allFixture(t); f.both('interactions');
  const before = f.queryService.status(f.all);
  f.db.exec(`CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT);
    INSERT INTO session_index VALUES(10,7,3,'claude','session-a')`);
  const after = f.queryService.status(f.all, before.batchId);
  assert.equal(after.batchId, before.batchId);
  assert.equal(f.queryService.overview(f.all, { ...range, batchId: after.batchId }).sessionCount, 2);
  assert.equal(f.queryService.analysis(f.all, { ...range, batchId: after.batchId }).summary.sessionCount, 2);
});
