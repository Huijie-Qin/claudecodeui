import test from 'node:test';
import assert from 'node:assert/strict';

import { changeHookReportFieldType, isReportFieldKey, readHookReportFields, retainHookReportFields, type HookReportField } from './reportFields';

const definition: HookReportField = { key: 'records', label: 'Records', type: 'number', aggregation: 'sum' };
test('report fields are opt-in and do not infer declarations from business fields', () => {
  assert.deepEqual(readHookReportFields(undefined), []);
  assert.deepEqual(retainHookReportFields(undefined, { records: 3 }), []);
});
test('deleting or renaming a record field removes its report declaration', () => {
  assert.deepEqual(retainHookReportFields([definition], { renamed: 3 }), []);
  assert.deepEqual(retainHookReportFields([definition], { records: 3 }), [definition]);
});
test('switching away from numeric fields disables numeric aggregation', () => {
  assert.equal(changeHookReportFieldType(definition, 'string').aggregation, 'none');
  assert.equal(changeHookReportFieldType(definition, 'boolean').aggregation, 'none');
});
test('report keys cannot address nested data or expressions', () => {
  for (const key of ['user.secret', '$.payload', 'items[0]', 'sum(count)', '__proto__', 'constructor']) assert.equal(isReportFieldKey(key), false);
  for (const key of ['count', 'sql_count', '记录数']) assert.equal(isReportFieldKey(key), true);
});
