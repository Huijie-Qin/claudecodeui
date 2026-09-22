// Explicit live integration check; incurs model execution and independent grading.
import '../server/load-env.js';
import assert from 'node:assert/strict';
import { createEvaluationRuntime } from '../server/services/skill-evals/runtime.js';
import { gradeCase } from '../server/services/skill-evals/grading.js';

const runtime = createEvaluationRuntime({ resolveEnvironment: () => process.env });
const scope = { id: `smoke-${Date.now()}` };
const runtimeProfile = await runtime.preflight(scope);
const controller = new AbortController();
const budget = { remainingUsd: 2, costUsd: 0, calls: 0 };
const files = { 'SKILL.md': Buffer.from('---\nname: smoke\ndescription: Test the evaluation sandbox\n---\nUse the shell tool to write the requested file.').toString('base64') };
const testCase = {
  prompt: "Use the shell tool to run: printf 'sandbox-ok' > /output/check.txt . Then reply done.",
  expected_output: 'The file check.txt must contain exactly sandbox-ok.', files: [],
};
const evidence = await runtime.runCase({ scope, runtimeProfile, signal: controller.signal,
  budget, files, testCase: { prompt: testCase.prompt, files: testCase.files },
});
assert.equal(Buffer.from(evidence.artifacts['check.txt'] || '', 'base64').toString(), 'sandbox-ok');
assert.ok(evidence.events.some((e) => e.kind === 'tool_result'));
console.log('Live model → MCP broker → offline Docker → artifact collection: passed');
const grade = await gradeCase({ runtime, scope, testCase, evidence, files,
  signal: controller.signal, budget, model: runtimeProfile.model });
assert.equal(grade.status, 'passed', 'Independent grading must confirm the artifact content');
assert.ok(grade.checks.some((check) => check.evidenceRefs.includes('artifact:check.txt')));
console.log('Independent structured grading with actual artifact references: passed');
console.log(JSON.stringify({ model: runtimeProfile.model, calls: budget.calls, sdkReportedCostUsd: budget.costUsd }));
