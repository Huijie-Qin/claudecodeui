import assert from 'node:assert/strict';
import test from 'node:test';

import { parseEvals } from './contracts.js';

const entry = { id: 1, prompt: '整理本周工作', expected_output: '不编造数据' };
const parse = evals => parseEvals(JSON.stringify({ skill_name: 'weekly', evals }), 'weekly');

test('ten cases are valid but eleven are rejected without truncating data', () => {
  const cases = Array.from({ length: 10 }, (_, i) => ({ ...entry, id: i + 1 }));
  assert.equal(parse(cases).evals.length, 10);
  cases.push({ ...entry, id: 11 });
  assert.throws(() => parse(cases), error => error.code === 'EVAL_CASE_LIMIT' && /10 条/.test(error.message));
  assert.equal(cases.length, 11);
});

test('schema errors identify the offending case and distinguish invalid IDs from duplicates and extra fields', () => {
  for (const id of [undefined, null, '2', 0, -1, 1.5]) {
    assert.throws(() => parse([entry, { ...entry, id }]), error => error.code === 'EVAL_SCHEMA_INVALID' && /第 2 条.*id 必须是正整数/.test(error.message));
  }
  assert.throws(() => parse([entry, entry]), /第 2 条.*id=1.*重复/);
  assert.throws(() => parse([{ ...entry, assertions: ['不能编造数据'] }]), /第 1 条.*不支持的字段："assertions"/);
  for (const value of [null, [], 'invalid']) assert.throws(() => parse([value]), /第 1 条.*JSON 对象/);
});

test('valid case identities and data are retained and unknown checks are never silently dropped', () => {
  const source = [{ ...entry, id: 4 }, { ...entry, id: 9, expectations: ['金额准确'], files: [] }];
  assert.deepEqual(parse(source).evals, source);
  const imported = { ...entry, assertions: ['金额准确'] };
  assert.throws(() => parse([imported]), /请先核对字段含义/);
  assert.deepEqual(imported.assertions, ['金额准确']);
});
