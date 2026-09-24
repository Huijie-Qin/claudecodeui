import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { REQUESTED_HOOK_EXAMPLES } from './hook-examples.js';
import { normalizeHookInput } from './hook-configs.js';
import { executeHookScript } from './hook-script-executor.js';

test('completion review presets pass published Hook validation and retain acceptance fields', () => {
  for (const id of ['independent-completion-review', 'report-data-deliverable-review']) {
    const example = REQUESTED_HOOK_EXAMPLES.find((hook) => hook.id === id);
    const normalized = normalizeHookInput(example, { strict: true });
    assert.equal(normalized.eventName, 'Stop');
    assert.equal(normalized.includeSubagents, false);
    assert.equal(normalized.postActions[0].type, 'review_completion');
    assert.equal(normalized.postActions[0].config.criteria, example.postActions[0].config.criteria);
    assert.deepEqual(normalized.postActions[0].config.artifactPaths,
      example.postActions[0].config.artifactPaths);
    if (id === 'report-data-deliverable-review') {
      assert.equal(normalized.postActions[0].config.validationResultPath, 'script.output.validation');
    }
  }
});

test('report and data validation example returns repairable failures and passes valid data', async () => {
  const example = REQUESTED_HOOK_EXAMPLES.find((hook) => hook.id === 'report-data-deliverable-review');
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'ccui-review-example-'));
  const run = () => executeHookScript({
    hookId: example.id,
    language: example.extensionLogic.language,
    code: example.extensionLogic.code,
    event: { hook_event_name: 'Stop', session_id: 'report-example-test' },
    env: { sessionId: 'report-example-test' },
    workspaceRoot,
  });
  try {
    const missing = (await run()).output.validation;
    assert.equal(missing.passed, false);
    assert.match(missing.issues.join(' '), /缺少报告文件/);
    assert.match(missing.issues.join(' '), /缺少数据文件/);

    await mkdir(path.join(workspaceRoot, 'reports'));
    await mkdir(path.join(workspaceRoot, 'data'));
    await writeFile(path.join(workspaceRoot, 'reports/report.html'), '<h1>报告</h1>');
    await writeFile(path.join(workspaceRoot, 'data/metrics.json'), '{ invalid');
    const invalidJson = (await run()).output.validation;
    assert.equal(invalidJson.passed, false);
    assert.match(invalidJson.issues.join(' '), /不是合法 JSON/);
    assert.equal(invalidJson.evidence.reportExists, true);

    await writeFile(path.join(workspaceRoot, 'data/metrics.json'), JSON.stringify({
      period: '2026-09', metrics: [{ name: '收入', value: '120', unit: '万元' }],
    }));
    const invalidField = (await run()).output.validation;
    assert.equal(invalidField.passed, false);
    assert.match(invalidField.issues.join(' '), /metrics\[0\]\.value 必须是有限数字/);

    await writeFile(path.join(workspaceRoot, 'data/metrics.json'), JSON.stringify({
      period: '2026-09', metrics: [{ name: '收入', value: 120, unit: '万元' }],
    }));
    const valid = (await run()).output.validation;
    assert.deepEqual(valid, {
      passed: true,
      issues: [],
      evidence: {
        reportPath: 'reports/report.html',
        dataPath: 'data/metrics.json',
        reportExists: true,
        dataExists: true,
        checkedMetricRows: 1,
      },
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
