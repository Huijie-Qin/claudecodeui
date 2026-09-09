// Explicit, paid-model E2E check using only synthetic fixtures. Never runs in CI
// by default. Usage: node scripts/report-quality-live.mjs --run
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { applyEnvFileContents } from '../server/utils/env-loader.js';
import { executeHookScript } from '../server/services/hook-script-executor.js';
import { REPORT_QUALITY_HOOK_EXAMPLE } from '../server/services/report-quality-hook.js';

if (!process.argv.includes('--run')) {
  process.stdout.write('Explicit live run: node scripts/report-quality-live.mjs --run\n');
  process.exit(0);
}

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(process.env.REPORT_QUALITY_LIVE_OUTPUT || path.join(os.tmpdir(), 'ccui-report-quality-live'));
await fs.mkdir(outputRoot, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(outputRoot, 'run-'));
const workspacePath = path.join(runRoot, 'workspace');
const configHome = path.join(runRoot, 'claude-config');
await fs.cp(path.join(repoRoot, 'examples/report-quality'), workspacePath, { recursive: true });
await fs.mkdir(configHome);
const configFile = '.ccui/report-quality.json';
const config = JSON.parse(await fs.readFile(path.join(workspacePath, configFile), 'utf8'));
const checkerFile = config.checkerScript || '.claude/skills/check-html-report/scripts/check_report.py';
const generatorSkill = '.claude/skills/generate-html-report/SKILL.md';
const reportPath = path.join(workspacePath, config.report);
const protectedFiles = [configFile, config.reference, config.source, config.checkerSkill, checkerFile, generatorSkill];
const fingerprint = async (file) => createHash('sha256').update(await fs.readFile(path.join(workspacePath, file))).digest('hex');
const originalHashes = Object.fromEntries(await Promise.all(protectedFiles.map(async (file) => [file, await fingerprint(file)])));

// Keep every inherited system path intact. Load only existing model settings;
// neither the original Claude home nor the application database is used.
const fileEnv = {};
try {
  applyEnvFileContents(await fs.readFile(path.join(repoRoot, '.env'), 'utf8'), fileEnv);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const executionEnv = { ...process.env };
for (const key of [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
]) if (fileEnv[key]) executionEnv[key] = fileEnv[key];
executionEnv.CLAUDE_CONFIG_DIR = configHome;
executionEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
delete executionEnv.CLAUDECODE;
const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'));
const nativeCli = sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${process.platform === 'win32' ? '.exe' : ''}`);

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error('Live report test timed out')), 6 * 60_000);
const stopEvents = [];
const toolEvents = [];
const assistantMessages = [];
let sdkResult;
let sdkQuery;
let finalVerdict;

function insideWorkspace(file) {
  const relative = path.relative(workspacePath, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function authorizeTool(toolName, input) {
  const deny = (message) => ({ behavior: 'deny', message });
  if (['Read', 'Write', 'Edit'].includes(toolName)) {
    if (typeof input.file_path !== 'string') return deny('A file path is required.');
    const resolved = path.resolve(workspacePath, input.file_path);
    if (!insideWorkspace(resolved)) return deny('Only this synthetic workspace is accessible.');
    if (toolName !== 'Read' && resolved !== reportPath) return deny('Only the configured report may be edited; the checker writes its own verdict.');
    try {
      if (!insideWorkspace(await fs.realpath(resolved))) return deny('Paths outside the workspace are unavailable.');
    } catch { return deny('The requested file does not exist.'); }
    return { behavior: 'allow', updatedInput: { ...input, file_path: resolved } };
  }
  if (toolName === 'Bash') {
    const command = String(input.command || '').trim();
    if (/[\n\r;$`&|<>]/.test(command)) return deny('Run only the single checker command provided by Stop.');
    const args = (command.match(/'[^']*'|"[^"]*"|[^\s]+/g) || []).map((word) => word.replace(/^(['"])(.*)\1$/, '$2'));
    if (args.length !== 8 || args[0] !== 'python3' || args[1] !== checkerFile
      || args[2] !== '--config' || args[3] !== configFile || args[4] !== '--session-id'
      || args[6] !== '--attempt-token' || !/^[A-Za-z0-9-]+$/.test(args[5]) || !/^[A-Za-z0-9-]+$/.test(args[7])) {
      return deny('Only the exact Python checker invocation is allowed. Do not run shell commands or write a verdict manually.');
    }
    const latest = stopEvents.at(-1);
    if (args[5] !== latest?.sessionId || !latest.reason?.includes(`--attempt-token '${args[7]}'`)) {
      return deny('Use the session ID and attempt token from the latest Stop feedback.');
    }
    return { behavior: 'allow', updatedInput: { ...input, command, timeout: 30_000, run_in_background: false } };
  }
  return deny('This live fixture enables only Read, Write, Edit, and the exact checker command.');
}

function mapStopResponse(output) {
  const response = {};
  for (const [field, binding] of Object.entries(REPORT_QUALITY_HOOK_EXAMPLE.claudeResponse.bindings)) {
    assert.equal(binding.source, 'reference');
    assert.ok(binding.path.startsWith('script.output.'));
    const name = binding.path.slice('script.output.'.length);
    if (Object.hasOwn(output, name)) response[field] = output[name];
  }
  return response;
}

async function checkIndependently(sessionId, attemptToken, destination) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('python3', [checkerFile, '--config', configFile,
      '--session-id', sessionId, '--attempt-token', attemptToken], { cwd: workspacePath, signal: controller.signal, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    if (error.code !== 1 || typeof error.stdout !== 'string') throw error;
    stdout = error.stdout;
  }
  const verdict = JSON.parse(stdout);
  await fs.writeFile(path.join(runRoot, destination), `${JSON.stringify(verdict, null, 2)}\n`);
  return verdict;
}

try {
  await fs.writeFile(reportPath, '<!doctype html><html lang="zh-CN"><head><title>区域经营日报</title></head><body><main><section id="overview"><h2>经营概览</h2><div data-field="total-revenue">999.00</div></section></main></body></html>\n');
  const baseline = await checkIndependently('synthetic-preflight', 'baseline', 'baseline-check.json');
  assert.equal(baseline.passed, false, 'The deliberately incomplete report must fail before the model runs');
  await fs.rm(path.join(workspacePath, config.verdict), { force: true });
  process.stdout.write('Preflight: deliberately incomplete report failed actual checker.\n');

  sdkQuery = query({
    prompt: '这是合成文件测试。工作区已有一个存在缺失和错误数据的报告初稿。你的第一条回复必须只写“初稿已就绪，等待验收。”并结束，不要先使用工具。随后若 Stop Hook 阻止结束，遵循反馈，实际读取生成和校验 skill、样例与本次数据，修复报告并实际执行校验命令，直到通过。',
    options: {
      cwd: workspacePath, env: executionEnv, pathToClaudeCodeExecutable: nativeCli,
      ...(executionEnv.ANTHROPIC_MODEL ? { model: executionEnv.ANTHROPIC_MODEL } : {}),
      persistSession: false, settingSources: [], skills: [], plugins: [], mcpServers: {}, strictMcpConfig: true,
      settings: { autoMemoryEnabled: false, claudeMdExcludes: ['**'] },
      systemPrompt: '你是执行合成 HTML 报告任务的 agent。遵循用户当前请求与原生 Stop 验收反馈。仅在当前工作区读取文件，仅可修改配置中的报告文件。不要修改样例、源数据、配置、技能、检查脚本或手工编写验收结果。用 Read 读取、Write/Edit 修改报告；Bash 仅允许原样运行 Stop 给出的单行 python3 检查命令。工具权限是本测试的实际限制，不要尝试绕过。',
      tools: ['Read', 'Write', 'Edit', 'Bash'], allowedTools: [],
      permissionMode: 'default', canUseTool: authorizeTool,
      maxTurns: 24, includePartialMessages: false, abortController: controller,
      hooks: {
        PreToolUse: [{ hooks: [async (event) => {
          const permission = await authorizeTool(event.tool_name, event.tool_input || {});
          toolEvents.push({ name: event.tool_name, allowed: permission.behavior === 'allow', path: event.tool_input?.file_path || null });
          return { hookSpecificOutput: {
            hookEventName: 'PreToolUse', permissionDecision: permission.behavior,
            ...(permission.behavior === 'allow' ? { updatedInput: permission.updatedInput } : { permissionDecisionReason: permission.message }),
          } };
        }] }],
        Stop: [{ timeout: 30, hooks: [async (event, _toolId, options) => {
          const signal = AbortSignal.any([controller.signal, options.signal]);
          let output;
          try {
            ({ output } = await executeHookScript({
              ...REPORT_QUALITY_HOOK_EXAMPLE.extensionLogic,
              hookId: REPORT_QUALITY_HOOK_EXAMPLE.id, workspaceRoot: workspacePath,
              event, env: { sessionId: event.session_id }, signal,
            }));
          } catch {
            output = { status: 'failed', continue: false, stopReason: '必需的 Stop 校验失败，终止本次真实测试。' };
          }
          const response = mapStopResponse(output);
          stopEvents.push({
            index: stopEvents.length + 1, sessionId: event.session_id,
            stopHookActive: event.stop_hook_active, status: output.status, ...response,
          });
          await fs.writeFile(path.join(runRoot, 'stop-events.json'), JSON.stringify(stopEvents, null, 2));
          process.stdout.write(`Stop ${stopEvents.length}: ${output.status}; decision=${response.decision || (response.continue === false ? 'terminate' : 'allow')}; active=${event.stop_hook_active}\n`);
          return response;
        }] }],
      },
    },
  });
  for await (const message of sdkQuery) {
    if (message.type === 'assistant') {
      const text = message.message?.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      if (text) assistantMessages.push(text);
    }
    if (message.type === 'result') sdkResult = { subtype: message.subtype, isError: message.is_error };
  }
  assert.ok(stopEvents.length >= 2, 'Expected at least two actual native Stop callbacks');
  assert.equal(new Set(stopEvents.map((entry) => entry.sessionId)).size, 1, 'The repair must remain in the original session');
  assert.equal(stopEvents[0].decision, 'block');
  assert.equal(stopEvents.at(-1).status, 'passed');
  assert.ok(toolEvents.some((entry) => entry.name === 'Write' || entry.name === 'Edit'), 'The actual model must modify the report through a file tool');
  assert.ok(toolEvents.some((entry) => entry.name === 'Bash' && entry.allowed), 'The actual model must run the checker');
  assert.equal(sdkResult?.isError, false);
  for (const file of protectedFiles) assert.equal(await fingerprint(file), originalHashes[file], `Protected file changed: ${file}`);
  const accepted = JSON.parse(await fs.readFile(path.join(workspacePath, config.verdict), 'utf8'));
  finalVerdict = await checkIndependently(accepted.sessionId, accepted.attemptToken, 'independent-final-check.json');
  assert.equal(finalVerdict.passed, true);
  assert.deepEqual(finalVerdict.checks, { structure: true, completeness: true, data: true });
  const source = JSON.parse(await fs.readFile(path.join(workspacePath, config.source), 'utf8'));
  const reference = await fs.readFile(path.join(workspacePath, config.reference), 'utf8');
  const referenceFields = Object.fromEntries([...reference.matchAll(/data-field="([^"]+)"[^>]*>([^<]*)</g)]
    .map((match) => [match[1], match[2]]));
  const report = await fs.readFile(reportPath, 'utf8');
  assert.ok(report.includes(String(source.fields['total-revenue'])));
  assert.notEqual(String(source.fields['total-revenue']), referenceFields['total-revenue']);
  const summary = {
    validation: 'actual-native-claude-stop-file-tool-e2e', passed: true, sameSession: true,
    stopCount: stopEvents.length, initialCheckerPassed: baseline.passed,
    finalCheckerPassed: finalVerdict.passed, checks: finalVerdict.checks,
    protectedFilesUnchanged: true, sourceFields: source.fields,
    dataChanges: Object.entries(source.fields).filter(([key, value]) => String(value) !== referenceFields[key])
      .map(([field, value]) => ({ field, historicalSample: referenceFields[field], currentSource: value })),
    report: reportPath, toolEvents, sdkResult,
  };
  await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(runRoot, 'assistant-messages.json'), JSON.stringify(assistantMessages, null, 2));
  process.stdout.write(`Actual native Stop E2E passed (${stopEvents.length} Stops). Report: ${path.join(runRoot, 'report.json')}\n`);
} catch (error) {
  // Never print raw SDK/gateway errors or causes: those can include credentials.
  const summary = { validation: 'actual-native-claude-stop-file-tool-e2e', passed: false,
    code: controller.signal.aborted ? 'LIVE_TIMEOUT_OR_CANCELLED' : error.code || 'LIVE_VALIDATION_FAILED',
    stopEvents, toolEvents, sdkResult, finalCheckerPassed: finalVerdict?.passed ?? null };
  await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(summary, null, 2));
  process.stderr.write(`Actual native Stop E2E failed (${summary.code}). Safe report: ${path.join(runRoot, 'report.json')}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try { sdkQuery?.close(); } catch { /* The test result is already recorded. */ }
}
