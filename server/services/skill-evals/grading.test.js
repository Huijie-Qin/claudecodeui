import assert from 'node:assert/strict';
import test from 'node:test';

import { gradeCase } from './grading.js';
import { GRADE_CASE_PROMPT } from './prompts.js';

const testCase = { prompt: '概括材料', expected_output: '含义正确，表达简洁', expectations: ['约 200 字', '恰好 3 条', '固定回复 OK'] };
const evidence = { complete: true, events: [{ id: 'message:1', role: 'assistant', kind: 'text', text: '实际回复' }], artifacts: {} };
const args = { scope: {}, testCase, evidence, files: {}, budget: { calls: 0, costUsd: 0 } };

test('grading forwards all saved soft and hard criteria unchanged with their evidence', async () => {
  const original = structuredClone(testCase);
  let calls = 0;
  const result = await gradeCase({ ...args, runtime: { modelCall: async ({ systemPrompt, prompt, outputSchema }) => {
    calls++;
    assert.equal(systemPrompt, GRADE_CASE_PROMPT);
    assert.ok(outputSchema);
    const data = JSON.parse(prompt);
    assert.deepEqual(data.checks.map(check => check.text), [testCase.expected_output, ...testCase.expectations]);
    assert.deepEqual(data.events, evidence.events);
    return { structured: { checks: data.checks.map(check => ({ id: check.id, status: 'passed', reason: '符合要求', evidenceRefs: ['message:1'] })) } };
  } } });
  assert.equal(result.status, 'passed');
  assert.equal(calls, 1);
  assert.deepEqual(testCase, original);
});

test('hard-requirement failures and uncertain counts are not silently converted to passes', async () => {
  for (const [status, overall] of [['failed', 'failed'], ['uncertain', 'inconclusive']]) {
    const result = await gradeCase({ ...args, runtime: { modelCall: async ({ prompt }) => ({ structured: {
      checks: JSON.parse(prompt).checks.map((check, index) => ({ id: check.id, status: index === 2 ? status : 'passed',
        reason: index === 2 ? '数量未满足要求或无法可靠核实' : '符合要求', evidenceRefs: ['message:1'] })),
    } }) } });
    assert.equal(result.status, overall);
    assert.equal(result.checks[2].status, status);
  }
});

test('invalid JSON artifact fails even when semantic checks pass', async () => {
  const result = await gradeCase({ ...args, evidence: { ...evidence, artifacts: { 'result.json': Buffer.from('{broken').toString('base64') } },
    runtime: { modelCall: async ({ prompt }) => ({ structured: { checks: JSON.parse(prompt).checks.map(check => ({
      id: check.id, status: 'passed', reason: '语义符合要求', evidenceRefs: ['artifact:result.json'],
    })) } }) } });
  assert.equal(result.status, 'failed');
  assert.equal(result.checks[0].id, 'json:result.json');
});

test('invented references are rejected even when the reviewer claims semantic equivalence', async () => {
  let calls = 0;
  await assert.rejects(gradeCase({ ...args, runtime: { modelCall: async ({ prompt }) => {
    calls++;
    return { structured: { checks: JSON.parse(prompt).checks.map(check => ({ id: check.id, status: 'passed',
      reason: '语义等价', evidenceRefs: ['invented-evidence'] })) } };
  } } }), { code: 'EVAL_REVIEW_ERROR' });
  assert.equal(calls, 2);
});
