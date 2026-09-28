import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture } from './ai-usage-test-fixture.js';

test('tenant-owned Hook scope covers grouped totals, detail, field choices, daily aggregates and execution reports', t => {
  const { db, batch, row, access, accessService, queryService: query } = fixture(t);
  batch('batch-1', 10, 'published', { dataRevision: 0, hookNumericStatisticsVersion: 1 });
  db.exec("INSERT INTO hooks VALUES('own-a',10),('own-b',10),('platform',NULL),('foreign',20)");
  const samples = [['own-a', 2], ['own-b', 3], ['platform', 100], ['foreign', 200], ['orphan', 300]];
  for (const [id, value] of samples) {
    const field = { key: id, label: `${id}字段`, type: 'number', value };
    const dimensions = { hookId: id, hookName: '同名 Hook', hookVersion: 1, postActionId: 'record', recordType: 'test', recordSource: 'post_action' };
    row({ id: `${id}-record`, dataset: 'hook_records', subjectId: id, value: { ...dimensions, fields: [field] } });
    row({ id: `${id}-daily`, dataset: 'hook_daily', subjectId: id, value: { ...dimensions, fields: [{ ...field, validCount: 1, sum: value, min: value, max: value }] } });
    row({ id: `${id}-execution`, dataset: 'hook_executions', subjectId: id, value: { ...dimensions, status: 'succeeded', durationMs: value } });
  }
  db.exec("DELETE FROM hooks WHERE id='orphan'");
  const ownIds = ['own-a', 'own-b'];
  const admin = accessService.resolve({ userId: 1, tenantId: 10 });
  assert.equal(access.hookOwnerTenantId, 10);
  assert.equal(accessService.resolve({ userId: 2, tenantId: 10, scope: 'self' }).hookOwnerTenantId, 10);
  assert.equal(admin.hookOwnerTenantId, null);
  for (const source of ['daily', 'records']) {
    assert.deepEqual(query.hooks(access).items.map(item => item.hookId).sort(), ownIds);
    assert.deepEqual(query.hookExecutions(access).items.map(item => item.hookId).sort(), ownIds);
    const fields = query.hookFieldStatistics(access);
    assert.equal(fields.aggregationSource, source);
    assert.deepEqual(fields.items.map(item => item.hookId).sort(), ownIds);
    assert.equal(fields.items.reduce((sum, field) => sum + field.sum, 0), 5);
    for (const groupBy of ['hook', 'user', 'workspace', 'day', 'week', 'month']) {
      const groups = query.analysis(access, { dataset: 'hooks', groupBy, pageSize: 1 });
      assert.equal(groups.summary.recordCount, 2, groupBy);
      assert.equal(groups.summary.activeUserCount, 1, groupBy);
      assert.equal(query.analysis(access, { dataset: 'hookExecutions', groupBy }).summary.executionCount, 2);
    }
    assert.deepEqual([1, 2].flatMap(page => query.hooks(access, { page, pageSize: 1 }).items).map(item => item.hookId).sort(), ownIds);
    for (const hidden of ['platform', 'foreign', 'orphan', 'missing']) {
      const forged = { hookOwnerTenantId: null, ownerTenantId: 20, canViewDefinitions: true };
      assert.equal(query.hookRecords(access, hidden, forged).total, 0);
      assert.equal(query.hookExecutionRecords(access, hidden, forged).total, 0);
      const detail = query.hookStatistics(access, hidden, forged, true, true);
      assert.equal(detail.total, 0); assert.deepEqual(detail.availableFields, []);
      assert.deepEqual(query.hookStatistics(access, hidden).items, []);
    }
    assert.equal(query.hooks(admin).total, 5, 'platform admin scope remains unchanged');
    assert.equal(query.hookRecords(admin, 'platform').total, 1);
    assert.equal(query.hookStatistics(admin, 'platform').items[0].sum, 100);
    db.exec('UPDATE ai_usage_tenant_state SET data_revision=1 WHERE tenant_id=10');
  }
  // The ownership check is live, even if a saved filter/batch still references it.
  db.exec("DELETE FROM hooks WHERE id='own-a'");
  assert.equal(query.hooks(access).total, 1);
  assert.equal(query.hookRecords(access, 'own-a').total, 0);
  row({ id: 'usage', dataset: 'interactions', value: { templateId: 'template', templateName: 'Agent' } });
  assert.equal(query.analysis(access, { dataset: 'usage' }).summary.sessionCount, 1);
  assert.equal(query.analysis(access, { dataset: 'templates' }).summary.sessionCount, 1);
});
