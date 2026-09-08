// Explicit live-model validation. Uses synthetic text only; no production DB or
// saved conversations. Run with Node 22+ and existing .env model credentials.
// Default: generation + regression. --with-repair also exercises an explicitly
// injected legacy rounding fault; --repair-only runs just that fault fixture.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyEnvFileContents } from '../server/utils/env-loader.js';
import { learnSessionSkill } from '../server/services/session-skill-learning.js';
import { completeSessionSkillText } from '../server/services/session-skill-learning-runtime.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(process.env.SESSION_SKILL_LIVE_OUTPUT || '/private/tmp/ccui-session-skill-live');
const runRoot = await fs.mkdtemp(await fs.mkdir(outputRoot, { recursive: true }).then(() => path.join(outputRoot, 'run-')));
const workspacePath = path.join(runRoot, 'workspace');
const configPath = path.join(runRoot, 'claude-config');
await Promise.all([fs.mkdir(workspacePath), fs.mkdir(configPath)]);

// Parse like the server, but only copy model configuration. Do not override
// HOME, CODEX_HOME, PATH, database settings, or the original Claude config home.
const fileEnv = {};
applyEnvFileContents(await fs.readFile(path.join(repoRoot, '.env'), 'utf8'), fileEnv);
const executionEnv = { ...process.env };
for (const key of [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
]) {
  if (fileEnv[key]) executionEnv[key] = fileEnv[key];
}
executionEnv.CLAUDE_CONFIG_DIR = configPath;
executionEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
delete executionEnv.CLAUDECODE;

const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'));
const nativePackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const nativeCli = sdkRequire.resolve(`${nativePackage}/claude${process.platform === 'win32' ? '.exe' : ''}`);
const controller = new AbortController();
const jobTimer = setTimeout(() => controller.abort(), 10 * 60_000);
const phases = [];
const repairOnly = process.argv.includes('--repair-only');
const complete = async ({ phase, systemPrompt, prompt }) => {
  const start = Date.now();
  process.stdout.write(`${phase}: started\n`);
  const response = await completeSessionSkillText({
    workspacePath, phase, systemPrompt, prompt, signal: controller.signal,
  }, {
    timeoutMs: 90_000,
    runtimeManager: {
      prepareClaudeRuntime: async () => ({
        cwd: workspacePath, projectPath: workspacePath,
        executionEnv, pathToClaudeCodeExecutable: nativeCli,
      }),
    },
    mapOptions: (options) => ({
      cwd: options.cwd,
      env: options.executionEnv,
      pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
      ...(executionEnv.ANTHROPIC_MODEL ? { model: executionEnv.ANTHROPIC_MODEL } : {}),
    }),
  });
  phases.push({ phase, durationMs: Date.now() - start });
  process.stdout.write(`${phase}: completed\n`);
  return response;
};

const runRepair = async () => {
  // Deliberately broken legacy fixture, not a claim about a generated skill.
  // No mock responses or forced judge decisions are used in this live run.
  const faultySkill = `---
name: synthetic-total-price
description: 汇总输入价格并以 total 两位小数字符串输出 JSON。
---
# 输入
接收若干价格，输出合计。
# 方法
先精确相加得到所有输入价格的总和，再直接截断到小数点后两位，不进行四舍五入。
截断算法为 Math.trunc(总和 * 100) / 100，随后固定格式为两位小数字符串。
# 输出
只输出 JSON 对象，字段 total 为所得金额字符串。
# 验收
检查 total 为字符串、小数点后恰有两位且没有额外文字。
`;
  await fs.writeFile(path.join(runRoot, 'synthetic-fault-SKILL.md'), faultySkill);
  const repaired = await learnSessionSkill({
    skillName: 'synthetic-total-price', operation: 'optimize', currentSkill: faultySkill,
    previousCases: [{ input: '计算价格 12 元和 8 元的合计，只输出 JSON total 两位小数字符串。', expectedOutput: '{"total":"20.00"}' }],
    maxIterations: 3,
    messages: [
      { id: 'r-u1', kind: 'text', role: 'user', content: '计算价格 1.236 元和 2.001 元的合计，只输出 JSON，字段 total 为两位小数的字符串。' },
      { id: 'r-a1', kind: 'text', role: 'assistant', content: '{"total":"3.23"}' },
      { id: 'r-u2', kind: 'text', role: 'user', content: '结果不对，请重新计算。' },
      { id: 'r-a2', kind: 'text', role: 'assistant', content: '{"total":"3.24"}' },
      { id: 'r-u3', kind: 'text', role: 'user', content: '满意，这是最终结果。' },
    ], complete,
  });
  await fs.writeFile(path.join(runRoot, 'repair.json'), JSON.stringify(repaired, null, 2));
  await fs.writeFile(path.join(runRoot, 'repaired-SKILL.md'), repaired.skillContent);
  if (repaired.passed) assert.deepEqual(JSON.parse(repaired.actualOutput), { total: '3.24' });
  const report = {
    validation: 'actual-model-synthetic-text',
    fixture: 'explicitly-injected-truncation-fault',
    passed: repaired.passed,
    iterations: repaired.iterations.length,
    baselinePassed: repaired.iterations[0].passed,
    baselineActualOutput: repaired.iterations[0].actualOutput,
    finalActualOutput: repaired.actualOutput,
    skillChanged: faultySkill !== repaired.skillContent,
    regressionCases: repaired.testCases.length,
    phases,
  };
  await fs.writeFile(path.join(runRoot, 'repair-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report)}\nArtifacts: ${runRoot}\n`);
  if (!repaired.passed) process.exitCode = 1;
};

try {
  const ready = await complete({ phase: 'smoke', systemPrompt: 'Respond with READY only.', prompt: 'A synthetic connectivity test. Respond with READY.' });
  assert.equal(ready.trim(), 'READY', 'Live model smoke response was not READY');
  if (!repairOnly) {
    const generated = await learnSessionSkill({
      skillName: 'synthetic-total-price',
      maxIterations: 3,
      messages: [
        { id: 'g-u1', kind: 'text', role: 'user', content: '计算价格 12 元和 8 元的总金额。' },
        { id: 'g-a1', kind: 'text', role: 'assistant', content: '合计20元。' },
        { id: 'g-u2', kind: 'text', role: 'user', content: '只输出 JSON，字段 total 用字符串，金额保留两位小数。' },
        { id: 'g-a2', kind: 'text', role: 'assistant', content: '{"total":"20.00"}' },
        { id: 'g-u3', kind: 'text', role: 'user', content: '满意。' },
      ], complete,
    });
    await fs.writeFile(path.join(runRoot, 'generation.json'), JSON.stringify(generated, null, 2));
    await fs.writeFile(path.join(runRoot, 'generated-SKILL.md'), generated.skillContent);
    assert.equal(generated.passed, true, 'Live generation did not pass its replay checks');
    assert.deepEqual(JSON.parse(generated.actualOutput), { total: '20.00' });

    const optimized = await learnSessionSkill({
      skillName: 'synthetic-total-price', operation: 'optimize',
      currentSkill: generated.skillContent, previousCases: generated.testCases,
      maxIterations: 3,
      messages: [
        { id: 'o-u1', kind: 'text', role: 'user', content: '使用 synthetic-total-price，计算价格 3.25 元和 4.50 元的总金额，只输出 JSON total 字符串，两位小数。' },
        { id: 'o-a1', kind: 'text', role: 'assistant', content: '{"total":"7.75"}' },
        { id: 'o-u2', kind: 'text', role: 'user', content: '这次有 0.50 元优惠，总金额需减去优惠，再增加 currency 字段，固定为 CNY。只输出 total 和 currency 两个字段，total 仍为两位小数字符串。' },
        { id: 'o-a2', kind: 'text', role: 'assistant', content: '{"total":"7.25","currency":"CNY"}' },
        { id: 'o-u3', kind: 'text', role: 'user', content: '这就是最终结果，满意。' },
      ], complete,
    });
    await fs.writeFile(path.join(runRoot, 'optimization.json'), JSON.stringify(optimized, null, 2));
    await fs.writeFile(path.join(runRoot, 'optimized-SKILL.md'), optimized.skillContent);
    assert.equal(optimized.passed, true, 'Live optimization did not pass its regression checks');
    assert.deepEqual(JSON.parse(optimized.actualOutput), { total: '7.25', currency: 'CNY' });
    assert.equal(optimized.testCases.length, 2);
    const report = {
      validation: 'actual-model-synthetic-text',
      generatedPassed: generated.passed,
      generatedIterations: generated.iterations.length,
      optimizedPassed: optimized.passed,
      optimizedIterations: optimized.iterations.length,
      optimizationChangedSkill: generated.skillContent !== optimized.skillContent,
      regressionCases: optimized.testCases.length,
      phases,
    };
    await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(report)}\nArtifacts: ${runRoot}\n`);
  }
  if (repairOnly || process.argv.includes('--with-repair')) await runRepair();
} catch (error) {
  // Do not serialize SDK errors/causes: gateway messages may contain secrets.
  const report = { validation: 'actual-model-synthetic-text', failed: true, code: error.code || 'LIVE_POC_FAILED', phases };
  await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
  process.stderr.write(`Live POC failed (${report.code}). Safe report: ${path.join(runRoot, 'report.json')}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(jobTimer);
}
