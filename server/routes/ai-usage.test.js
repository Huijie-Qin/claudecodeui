import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { fixture } from '../services/ai-usage-test-fixture.js';

import { createAiUsageRouter } from './ai-usage.js';

async function httpFixture(t) {
  const f = fixture(t);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: Number(req.headers['x-test-user'] || 2), is_system_admin: 1 }; next(); });
  app.use('/api/ai-usage', createAiUsageRouter({ ...f }));
  const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  async function request(url, { userId = 2, method = 'GET', body } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ai-usage${url}`, { method, headers: { 'x-test-user': String(userId), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  return { ...f, request };
}

test('HTTP code reports and exports page through the new table within live tenant scope', async t => {
  const { request, batch, row, db } = await httpFixture(t);
  batch('batch-1', 10, 'published', { hooks: 'complete', codeSubmissions: 'complete' });
  row({ id: 'mr-1', dataset: 'code_submissions', userId: 3, value: { submittedLines: 50 } });
  row({ id: 'mr-2', dataset: 'code_submissions', userId: 4, value: { submittedLines: 40 } });
  const first = await request('/code?tenantId=10&scope=tenant&batchId=batch-1&pageSize=1&sortBy=submittedLines');
  assert.equal(first.status, 200); assert.equal(first.body.summary.submittedLines, 90);
  assert.equal(first.body.total, 2); assert.equal(first.body.items.length, 1);
  assert.equal(first.headers.get('cache-control'), 'private, no-store');
  const records = await request('/code-records?tenantId=10&scope=tenant&batchId=batch-1&groupBy=user&groupKey=3');
  assert.equal(records.body.total, 1); assert.equal(records.body.items[0].submittedLines, 50);
  assert.equal((await request('/code?tenantId=20')).status, 403);
  assert.equal((await request('/code?tenantId=10&scope=tenant', { userId: 3 })).status, 403);
  db.exec("UPDATE tenant_users SET role='member' WHERE user_id=2");
  assert.equal((await request('/code-records?tenantId=10&scope=tenant')).status, 403);
});

test('HTTP fixed summary ignores report filters without relaxing current tenant/user authorization', async (t) => {
  const { request, batch, row, db } = await httpFixture(t);
  batch('batch-1', 10, 'published', { activeUsers: 'complete' });
  row({ id: 'pub', dataset: 'skill_publications', date: '2024-01-01', workspaceId: null, subjectId: 'skill-a', value: { publisherUserId: 3 } });
  row({ id: 'session', dataset: 'interactions', userId: 4 });
  const base = await request('/summary?tenantId=10&batchId=batch-1');
  assert.equal(base.status, 200);
  assert.equal(base.body.publishedSkillCount, 1);
  assert.equal(base.body.sessionCount, 1);
  const filtered = await request('/summary?tenantId=10&batchId=batch-1&scope=self&from=2026-01-01&to=2026-01-02&workspaceId=999&userId=2&search=none');
  assert.deepEqual(filtered.body, base.body);
  assert.equal(base.headers.get('cache-control'), 'private, no-store');
  const self = await request('/summary?tenantId=10&userId=4', { userId: 3 });
  assert.equal(self.body.scope, 'self');
  assert.equal(self.body.publishedSkillCount, 1);
  assert.equal(self.body.sessionCount, 0);
  assert.equal((await request('/summary?tenantId=10&scope=tenant', { userId: 3 })).status, 403);
  assert.equal((await request('/summary?tenantId=20')).status, 403);
  assert.equal((await request('/summary?tenantId=10&batchId=missing')).status, 404);
  db.exec("UPDATE tenant_users SET role='member' WHERE user_id=2");
  assert.equal((await request('/summary?tenantId=10&scope=tenant')).status, 403);
  assert.equal((await request('/summary?tenantId=10')).body.scope, 'self');
});

test('HTTP unified usage table includes zero users only within the authorized population', async (t) => {
  const { request, batch, row } = await httpFixture(t);
  batch(); row({ id: 'active', dataset: 'interactions', userId: 3 });
  const url = '/analysis?tenantId=10&batchId=batch-1&dataset=usage&groupBy=user&includeZeroUsers=true';
  const tenant = await request(url);
  assert.equal(tenant.status, 200); assert.equal(tenant.body.includeZeroUsers, true);
  assert.equal(tenant.body.total, 3); assert.equal(tenant.body.summary.activeUserCount, 1);
  const self = await request(`${url}&workspaceId=999`, { userId: 3 });
  assert.equal(self.body.total, 1); assert.equal(self.body.items[0].groupKey, '3');
  assert.equal(self.body.items[0].sessionCount, 0);
  assert.equal((await request(`${url}&userId=4`, { userId: 3 })).status, 403);
});

test('HTTP capabilities, tenant scope and immediate revocation use real current membership', async (t) => {
  const { request, db, batch } = await httpFixture(t);
  batch();
  assert.equal((await request('/capabilities?tenantId=10')).body.canViewTenant, true);
  assert.equal((await request('/capabilities?tenantId=10', { userId: 3 })).body.canViewTenant, false);
  assert.equal((await request('/overview?tenantId=10&scope=tenant', { userId: 3 })).status, 403);
  assert.equal((await request('/overview?tenantId=20', { userId: 2 })).status, 403);
  assert.equal((await request('/overview?tenantId=10&tenantId=20')).status, 400);
  db.exec("UPDATE tenant_users SET role='member' WHERE user_id=2");
  assert.equal((await request('/users?tenantId=10')).status, 403);
  db.exec("UPDATE users SET is_active=0 WHERE id=2");
  assert.equal((await request('/status?tenantId=10')).status, 401);
});

test('HTTP reads retain a displayed published batch and exports do not fabricate an unapproved format', async (t) => {
  const { request, batch, row } = await httpFixture(t);
  batch();
  row({ id: 'i1', dataset: 'interactions' });
  const overview = await request('/overview?tenantId=10&from=2026-09-11&to=2026-09-12');
  assert.equal(overview.body.sessionCount, 1);
  assert.equal(overview.headers.get('cache-control'), 'private, no-store');
  const status = await request('/status?tenantId=10');
  assert.equal(status.body.dataThroughDate, '2026-09-12');
  assert.equal((await request('/templates?tenantId=10&batchId=batch-1')).body.batchId, 'batch-1');
  assert.equal((await request('/overview?tenantId=10&batchId=unknown')).status, 404);
  assert.equal((await request('/overview?tenantId=10&to=2026-09-13')).body.code, 'dataNotGenerated');
  const exported = await request('/exports?tenantId=10', { method: 'POST', body: { batchId: 'batch-1', dataset: 'users' } });
  assert.equal(exported.status, 503);
  assert.equal(exported.body.code, 'exportNotConfigured');
  assert.deepEqual((await request('/exports?tenantId=10')).body.items, []);
  batch('batch-2');
  const stale = await request('/overview?tenantId=10&batchId=batch-1');
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'reportUpdated');
  assert.equal((await request('/overview?tenantId=10')).body.batchId, 'batch-2');
});

test('HTTP activity and analysis enforce published scope, global sorting and aggregate filters', async (t) => {
  const { request, batch, row, db } = await httpFixture(t);
  batch('batch-1', 10, 'published', { activeUsers: 'complete' });
  row({ id: 'a', dataset: 'interactions', date: '2026-09-12', userId: 3, sessionKey: 'a' });
  row({ id: 'b', dataset: 'interactions', userId: 4, sessionKey: 'b' });
  row({ id: 'c', dataset: 'interactions', userId: 4, sessionKey: 'c' });
  row({ id: 'dau', dataset: 'active_users', date: '2026-09-12', userId: 3, value: { isDau: true, isMau: true } });
  row({ id: 'mau', dataset: 'active_users', date: '2026-09-12', userId: 4, value: { isDau: false, isMau: true } });
  const overview = await request('/overview?tenantId=10&scope=tenant&from=2026-09-12&to=2026-09-12');
  assert.equal(overview.body.dau, 1);
  assert.equal(overview.body.mau, 2);
  const url = '/analysis?tenantId=10&scope=tenant&batchId=batch-1&dataset=usage&groupBy=user';
  const sorted = await request(`${url}&sortBy=sessionCount&sortDir=desc&pageSize=1`);
  assert.equal(sorted.status, 200);
  assert.equal(sorted.body.items[0].groupKey, '4');
  assert.equal(sorted.body.total, 2);
  assert.equal(sorted.body.summary.sessionCount, 3);
  const filtered = await request(`${url}&metric=sessionCount&minValue=2`);
  assert.equal(filtered.body.total, 1);
  assert.equal(filtered.body.summary.sessionCount, 2);
  const self = await request('/analysis?tenantId=10&scope=self&dataset=usage&groupBy=user', { userId: 3 });
  assert.deepEqual(self.body.items.map((item) => item.groupKey), ['3']);
  assert.equal((await request(url, { userId: 3 })).status, 403);
  assert.equal((await request(`${url}&sortBy=unexpected`)).status, 400);
  assert.equal((await request(`${url}&metric=sessionCount&minValue=3&maxValue=2`)).status, 400);
  assert.equal((await request(`${url}&to=2026-09-13`)).body.code, 'dataNotGenerated');
  db.exec("UPDATE tenant_users SET role='member' WHERE user_id=2");
  assert.equal((await request(url)).status, 403);
});

test('HTTP Skill, execution and business field endpoints stay scoped and use exact record identities', async (t) => {
  const { request, batch, row } = await httpFixture(t);
  batch();
  row({ id: 'published', dataset: 'skill_publications', subjectId: 'skill-a', date: '2026-08-01', value: { skillName: 'Example Skill', publisherUserId: 3 } });
  row({ id: 'call', dataset: 'skill_invocations', subjectId: 'skill-a', value: { skillName: 'skill-a', publisherUserId: 3, callerUserId: 4 } });
  row({ id: 'execution', dataset: 'hook_executions', subjectId: 'hook-a', value: { hookName: 'Recorder', hookVersion: 1, eventName: 'Stop', status: 'succeeded', durationMs: 50 } });
  row({ id: 'record', dataset: 'hook_records', subjectId: 'hook-a', value: { hookName: 'Recorder', hookVersion: 1, postActionId: 'save', recordType: 'conversation_record', fields: [{ key: 'count', label: 'Count', type: 'number', aggregation: 'sum', value: 7 }] } });
  for (const path of ['/skills', '/hook-executions', '/hook-executions/hook-a/records', '/hook-field-statistics', '/hooks/hook-a/field-statistics']) {
    assert.equal((await request(`${path}?tenantId=10&scope=tenant`)).status, 200);
    assert.equal((await request(`${path}?tenantId=10&scope=tenant`, { userId: 3 })).status, 403);
    assert.equal((await request(`${path}?tenantId=20`)).status, 403);
    assert.equal((await request(`${path}?tenantId=10&batchId=missing`)).status, 404);
    assert.equal((await request(`${path}?tenantId=10&scope=self&userId=4`, { userId: 3 })).status, 403);
  }
  const skills = await request('/skills?tenantId=10&scope=self', { userId: 3 });
  assert.equal(skills.body.items[0].invocationCount, 1);
  const stats = await request('/hook-field-statistics?tenantId=10&fieldKey=count');
  assert.equal(stats.body.numericStatisticsVersion, 1);
  assert.deepEqual(['sum','average','min','max'].map((key) => stats.body.items[0][key]), [7, 7, 7, 7]);
  const grouped = await request('/hook-field-statistics?tenantId=10&groupBy=user&sortBy=userName');
  assert.equal(grouped.status, 200);
  assert.equal(grouped.body.groupBy, 'user');
  assert.equal(grouped.body.items[0].userId, 3);
  assert.equal((await request('/hooks/hook-a/records?tenantId=10&recordUserId=3')).body.total, 1);
  assert.equal((await request('/hooks/hook-a/records?tenantId=10&recordUserId=4')).body.total, 0);
  assert.equal((await request('/hooks/hook-a/statistics?tenantId=10&recordUserId=4')).body.items.length, 0);
  assert.equal((await request('/hook-field-statistics?tenantId=10&groupBy=workspace')).status, 400);
  assert.equal((await request('/hook-field-statistics?tenantId=10&scope=tenant&groupBy=user', { userId: 3 })).status, 403);
  assert.equal((await request('/hook-executions/hook-a/records?tenantId=10&executionStatus=failed')).body.total, 0);
  assert.equal((await request('/hook-field-statistics?tenantId=10&sortBy=privatePrompt')).status, 400);
  const hookReport = await request('/hooks/hook-a/field-statistics?tenantId=10&groupBy=workspace&fieldKey=count');
  assert.equal(hookReport.status, 200); assert.equal(hookReport.body.hookReportVersion, 1);
  assert.equal(hookReport.body.items[0].sum, 7);
  assert.equal((await request('/hooks/hook-a/records?tenantId=10&fieldKey=missing')).body.total, 0);
});
