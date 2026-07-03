import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSqlCheckRules } from './sqlCheckRules';

test('normalizeSqlCheckRules reads the rules array response', () => {
  assert.deepEqual(normalizeSqlCheckRules([
    { rule_id: 'require_where', name: 'Require WHERE', desc: 'UPDATE needs WHERE' },
  ]), [
    { rule_id: 'require_where', name: 'Require WHERE', desc: 'UPDATE needs WHERE' },
  ]);
});

test('normalizeSqlCheckRules still reads wrapped rule payloads', () => {
  assert.deepEqual(normalizeSqlCheckRules({
    response: [
      { ruleId: 'limit_rows', title: 'Limit rows', description: 'SELECT should use LIMIT' },
      { id: 42, label: 'Numeric ids work', summary: 'Converted to a string' },
    ],
  }), [
    { rule_id: 'limit_rows', name: 'Limit rows', desc: 'SELECT should use LIMIT' },
    { rule_id: '42', name: 'Numeric ids work', desc: 'Converted to a string' },
  ]);
});

test('normalizeSqlCheckRules removes invalid and duplicate rules', () => {
  assert.deepEqual(normalizeSqlCheckRules({
    result: [
      { rule_id: 'block_select_star', name: 'Block SELECT *' },
      { rule_id: 'block_select_star', name: 'Duplicate' },
      { desc: 'Missing an id' },
    ],
  }), [
    { rule_id: 'block_select_star', name: 'Block SELECT *', desc: '' },
  ]);
});
