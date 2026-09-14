// A fast SDK/CLI serialization contract, not the twenty-minute task acceptance.
// Only this query installs an artificial successful Hook replacement. The real
// MCP task server retains its twenty-minute duration and existing evidence.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { findTaskResult } from './hook-subagents-fixture-payload.mjs';

const storage = path.resolve(process.env.HOOK_SUBAGENTS_E2E_ROOT || '.tmp/hook-subagents-e2e');
const state = JSON.parse(await fs.readFile(path.join(storage, 'hook-subagents-latest.json'), 'utf8'));
assert.equal(state.loopDemo.durationMs, 1_200_000);
const contractRoot = await fs.mkdtemp(path.join(state.root, 'cli-format-contract-'));
const configDirectory = path.join(contractRoot, '.claude');
await fs.mkdir(configDirectory, { recursive: true });
const run = `loop20_contract_blocks_${Date.now()}`;
const controller = new AbortController();
const callbacks = [];
const messages = [];
const stderr = [];
let cliPath = process.env.CLAUDE_CLI_PATH;
if (!cliPath) {
  const require = createRequire(import.meta.url);
  const sdkRequire = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'));
  try { cliPath = sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`); }
  catch { /* The SDK can use an installed executable if no packaged binary exists. */ }
}
const timeout = setTimeout(() => controller.abort(new Error('CLI format contract exceeded 45 seconds')), 45_000);
let failure;
try {
  for await (const message of query({
    prompt: `HOOK_SUBAGENTS_E2E RUN=${run}. Delegate to one child. Submit a task with execute_task then call get_task_status once. Report the result actually returned to the child.`,
    options: {
      cwd: contractRoot,
      ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
      abortController: controller,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      model: 'claude-sonnet-4-6',
      settingSources: [],
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDirectory,
        ANTHROPIC_BASE_URL: state.modelUrl,
        ANTHROPIC_API_KEY: 'qa-local-subagents-fixture-only',
        ANTHROPIC_AUTH_TOKEN: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        ANTHROPIC_MODEL: 'claude-sonnet-4-6',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-4-6',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-sonnet-4-6',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost',
      },
      mcpServers: { qa_subagent_loop20: { type: 'http', url: state.loopDemo.mcpUrl } },
      hooks: { PostToolUse: [{
        matcher: state.loopDemo.statusToolName,
        timeout: 30,
        hooks: [async (event) => {
          assert.ok(event.agent_id, 'The contract must exercise a real subagent callback');
          const initial = findTaskResult(event.tool_response);
          assert.equal(initial?.status, 'running', 'A newly submitted real task must still be running');
          assert.equal(initial.task_id, event.tool_input.task_id);
          const replacement = { task_id: initial.task_id, status: 'success', contract_only: true };
          const response = { hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            updatedMCPToolOutput: [{ type: 'text', text: JSON.stringify(replacement) }],
          } };
          callbacks.push({ event, response, replacement });
          return response;
        }],
      }] },
      stderr: (line) => stderr.push(line),
    },
  })) messages.push(message);
  assert.equal(callbacks.length, 1, 'Exactly one child status call should be replaced');
  const evidence = await (await fetch(`${state.modelUrl}/evidence`)).json();
  const modelRequests = evidence.modelRequests.filter((row) => row.run === run);
  const childCompletion = modelRequests.find((row) => row.actor === 'child-A' && row.phase === 'loop-complete');
  assert.equal(childCompletion?.observedStatus, 'success', 'The real CLI must deliver the replacement to its child model');
  assert.equal(childCompletion.taskId, callbacks[0].replacement.task_id);
  assert.equal(modelRequests.find((row) => row.actor === 'main' && row.phase === 'loop-complete')?.observedStatus, 'success');
  assert.ok(messages.some((message) => message.type === 'result' && message.subtype === 'success'));
  assert.ok(!stderr.some((line) => line.includes('reduce is not a function')));
  await fs.writeFile(path.join(contractRoot, 'result.json'), `${JSON.stringify({
    passed: true, contractOnly: true, run, callbacks, modelRequests, messages, stderr,
  }, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, contractOnly: true, run, taskId: childCompletion.taskId, evidencePath: path.join(contractRoot, 'result.json') }));
} catch (error) {
  failure = error;
  await fs.writeFile(path.join(contractRoot, 'result.json'), `${JSON.stringify({
    passed: false, contractOnly: true, run, error: error.stack, callbacks, messages, stderr,
  }, null, 2)}\n`);
  console.error(JSON.stringify({ passed: false, contractOnly: true, run, error: error.message, evidencePath: path.join(contractRoot, 'result.json') }));
} finally {
  clearTimeout(timeout);
  controller.abort();
}
if (failure) process.exitCode = 1;
