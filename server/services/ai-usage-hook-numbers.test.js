import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { safeHookFields } from './ai-usage-parser.js';
import { fixture } from './ai-usage-test-fixture.js';
import { runAiUsageWindow } from './ai-usage-batches.js';
import { readAiUsageConfig } from './ai-usage-config.js';
import { createAiUsageQueryService } from './ai-usage-query.js';
import { seedAiUsageSimulation, simulationNight } from './ai-usage-simulation-fixture.js';

test('number statistics include legacy none/unset fields, ignore non-numbers and merge obsolete aggregation choices', (t) => {
  const { queryService: query, access, batch, row } = fixture(t);
  batch('batch-1', 10, 'published', { dataRevision: 0 }); // Legacy daily sums are incomplete.
  const fields = [{ key: 'value', label: '数值', type: 'number', unit: '条' },
    { key: 'text', type: 'string' }, { key: 'flag', type: 'boolean' }];
  const values = [0, -2.5, 5, 10, '42', null, true, NaN, Infinity];
  values.forEach((value, index) => {
    const definitions = fields.map((field) => ({ ...field, aggregation: [undefined, 'none', 'sum', 'avg'][index % 4] }));
    row({ id: String(index), dataset: 'hook_records', subjectId: 'hook-a', value: {
      hookName: 'A', postActionId: 'record', hookVersion: 1, recordType: 'custom',
      ...safeHookFields('custom', { value, text: '999', flag: true, secret: 123456 }, definitions),
    } });
  });
  // This old daily result covers only the enabled numeric field and must not win.
  row({ id: 'incomplete-daily', dataset: 'hook_daily', subjectId: 'hook-a', value: { fields: [{ ...fields[0], sum: 999, validCount: 1, min: 999, max: 999 }] } });
  const result = query.hookFieldStatistics(access);
  assert.equal(result.aggregationSource, 'records');
  assert.equal(result.numericStatisticsVersion, 1);
  assert.equal(result.total, 1);
  assert.deepEqual(['validCount','sum','average','min','max'].map((key) => result.items[0][key]), [4, 12.5, 3.125, -2.5, 10]);
  assert.ok(query.hookRecords(access, 'hook-a').items.every((item) => !item.fields.some((field) => field.key === 'secret')));
  assert.equal(query.hookFieldStatistics(access, { fieldKey: 'text' }).total, 0);
  assert.equal(query.hookFieldStatistics(access, { fieldKey: 'missing' }).total, 0);
});

test('each numeric column sorts the complete result before pagination in both grouping modes', (t) => {
  const { queryService: query, access, batch, row } = fixture(t);
  batch('batch-1', 10, 'published', { dataRevision: 0, hookNumericStatisticsVersion: 1 });
  const samples = [{ id: 'a', userId: 3, subjectId: 'hook-a', sum: 10, validCount: 2, min: 2, max: 8 },
    { id: 'b', userId: 4, subjectId: 'hook-b', sum: 12, validCount: 3, min: -1, max: 10 }];
  for (const sample of samples) row({ ...sample, dataset: 'hook_daily', value: { hookName: sample.subjectId,
    fields: [{ key: 'n', label: 'number', unit: '分', type: 'number', ...sample }] } });
  for (const groupBy of ['hook','user']) for (const [sortBy, first] of [['sum','hook-b'], ['average','hook-a'], ['min','hook-a'], ['max','hook-b']]) {
    const firstPage = query.hookFieldStatistics(access, { groupBy, sortBy, sortDir: 'desc', pageSize: 1 });
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.items[0].hookId, first);
    const secondPage = query.hookFieldStatistics(access, { groupBy, sortBy, sortDir: 'desc', pageSize: 1, page: 2 });
    assert.notEqual(secondPage.items[0].hookId, first);
  }
  assert.throws(() => query.hookFieldStatistics(access, { sortBy: 'privatePrompt' }), { statusCode: 400 });
});

test('the next nightly version rebuilds incomplete legacy daily fields and replaces the current report', async (t) => {
  const db = new Database(':memory:'); t.after(() => db.close());
  seedAiUsageSimulation(db);
  const config = readAiUsageConfig({ AI_USAGE_ENABLED: 'true' });
  const legacy = { ...config, calculationVersion: config.calculationVersion.replace('_hook_numbers_v5', '') };
  await runAiUsageWindow({ database: db, config: legacy, now: simulationNight });
  const query = createAiUsageQueryService({ db });
  const access = { tenantId: 10, userId: 2, scope: 'tenant', canViewTenant: true };
  const oldBatch = query.status(access).batchId;
  // Simulate the old writer omitting every field because no method was selected.
  db.exec("UPDATE ai_usage_report_rows SET value_json=json_set(value_json,'$.fields',json('[]')) WHERE dataset='hook_daily'");
  const before = query.hookFieldStatistics(access, { pageSize: 100 });
  assert.equal(before.aggregationSource, 'records');
  assert.equal(before.total, 12);
  const newNight = await runAiUsageWindow({ database: db, config, now: () => new Date(simulationNight().getTime() + 86400000) });
  assert.equal(newNight.published, 1);
  const after = query.hookFieldStatistics(access, { from: before.from, to: before.to, pageSize: 100 });
  assert.equal(after.aggregationSource, 'daily');
  assert.deepEqual(after.items, before.items);
  assert.throws(() => query.hookFieldStatistics(access, { batchId: oldBatch }), { code: 'reportUpdated' });
});
