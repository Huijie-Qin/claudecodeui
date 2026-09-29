// Explicit live acceptance check. Calls the configured model with synthetic data;
// does not run skills, load workspace MCP, or modify existing evaluation cases.
import '../server/load-env.js';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createEvaluationRuntime } from '../server/services/skill-evals/runtime.js';
import { gradeCase, parseModelJson } from '../server/services/skill-evals/grading.js';
import { validateEvals } from '../server/services/skill-evals/contracts.js';
import { GENERATE_CASES_PROMPT } from '../server/services/skill-evals/prompts.js';

const runtime = createEvaluationRuntime({ resolveEnvironment: () => process.env });
const budget = { calls: 0, costUsd: 0 };
const scope = { id: `semantics-${Date.now()}` };
const results = [];
const reportPath = path.join(os.tmpdir(), `${scope.id}.json`);
const fixtures = [
  { name: '同义表达且无字数要求', prompt: '材料：本月营收从100万元上升至120万元。概括变化。', expected: '说明营收增加20万元，增幅20%。',
    output: '营收增长五分之一，增加了二十万元。', status: 'passed' },
  { name: '合理改写不能引入无依据事实', prompt: '材料：本月营收从100万元上升至120万元。概括变化。', expected: '说明营收增加20万元，增幅20%。',
    output: '营收同比增长五分之一，增加了二十万元。', status: 'failed' },
  { name: '缺失关键内容', prompt: '材料：营收增长20%，但单一客户占收入80%。总结增长情况和风险。', expected: '说明营收增长20%，指出收入过度依赖单一客户的风险。',
    output: '营收增长20%，表现良好。', status: 'failed' },
  { name: '明确格式不符', prompt: '仅返回JSON对象，包含数值字段total，值为300。', expected: '有效JSON对象，包含数值字段total且值为300。',
    output: '总金额为300元。', status: 'failed' },
  { name: '约定字数允许轻微偏差', prompt: '请用约50字概括：项目已完成开发，测试通过；周五上线；小李负责监控，出问题立即回滚。', expected: '约50字概括进展、上线时间、负责人和异常处理，不编造信息。',
    output: '项目开发已完成，测试也已通过，计划周五上线。小李负责上线后的监控工作，若发现问题，将立即回滚以降低影响。', status: 'passed' },
  { name: '明确条数仍然严格', prompt: '给出恰好3条提升账号安全性的建议。', expected: '恰好3条相关且可行的建议。',
    output: '1. 使用独立的强密码。\n2. 开启双重验证。', status: 'failed' },
  { name: '固定文字仍然严格', prompt: '只回复固定字符串OK，不要其他文字。', expected: '完整回复必须恰好为OK。',
    output: '好的', status: 'failed' },
  { name: '明确字数上限仍然严格', prompt: '仅用中文汉字回复问候，不超过5个汉字。', expected: '问候语不超过5个汉字，每个汉字计1字。',
    output: '祝你今天工作顺利生活愉快', status: 'failed' },
];

const tasks = fixtures.map(fixture => ({ name: fixture.name, run: async () => {
  const grade = await gradeCase({ runtime, scope, budget, files: {},
    testCase: { prompt: fixture.prompt, expected_output: fixture.expected },
    evidence: { complete: true, events: [{ id: 'message:1', role: 'assistant', kind: 'text', text: fixture.output }], artifacts: {} },
  });
  return { passed: grade.status === fixture.status, expectedStatus: fixture.status, ...fixture, grade };
} }));

for (const strict of [false, true]) {
  tasks.push({ name: strict ? '生成用例保留明确数量要求' : '生成中文用例且不擅加字数要求', run: async () => {
    const skill = strict
      ? '---\nname: advice\ndescription: 提供账号安全建议\n---\n根据用户描述给出恰好3条账号安全建议，使用Markdown编号列表。信息不足时询问使用场景，不编造用户情况。'
      : '---\nname: summary\ndescription: 总结用户提供的材料\n---\n准确概括材料核心结论和关键数据，使用Markdown列表，不新增事实。缺少材料时提示补充。';
    const response = await runtime.modelCall({ scope, budget, systemPrompt: GENERATE_CASES_PROMPT, prompt: JSON.stringify({ skill, existing: [] }) });
    const value = parseModelJson(response);
    assert.equal(value.cases?.length, 3);
    validateEvals({ skill_name: strict ? 'advice' : 'summary', evals: value.cases.map((item, index) => ({ ...item, id: index + 1 })) }, strict ? 'advice' : 'summary');
    for (const item of value.cases) {
      assert.match(item.prompt, /[\u4e00-\u9fff]/);
      assert.match(item.expected_output, /[\u4e00-\u9fff]/);
      assert.deepEqual(item.files, []);
      assert.doesNotMatch(JSON.stringify(item), /[0-9一二三四五六七八九十百]+\s*(?:字|词|段)/);
    }
    if (strict) assert.match(JSON.stringify(value.cases), /(?:3|三)\s*条/);
    return { passed: true, generated: value.cases };
  } });
}

// Two independent requests at a time keep the live check bounded.
let next = 0;
async function worker() {
  while (next < tasks.length) {
    const task = tasks[next++];
    try { results.push({ name: task.name, ...await task.run() }); }
    catch (error) { results.push({ name: task.name, passed: false, error: error.code || 'ACCEPTANCE_ERROR' }); }
    console.log(`${results.at(-1).passed ? 'PASS' : 'FAIL'} ${task.name}`);
  }
}
await Promise.all([worker(), worker()]);
await fs.writeFile(reportPath, JSON.stringify({ results, calls: budget.calls, sdkReportedCostUsd: budget.costUsd }, null, 2));
console.log(`Report: ${reportPath}`);
if (results.some(result => !result.passed)) process.exitCode = 1;
