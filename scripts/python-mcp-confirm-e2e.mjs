// Native SDK permission bridge probe. All model responses and MCP data are local.
// Run explicitly: node scripts/python-mcp-confirm-e2e.mjs --run
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';

import { resolveMcpToolConfirmation } from '../server/services/mcp-tool-confirmation.js';

if (!process.argv.includes('--run')) {
  console.log('Run explicitly: node scripts/python-mcp-confirm-e2e.mjs --run');
  process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storage = path.join(repoRoot, 'artifacts', 'mcp-confirm-e2e');
await fs.mkdir(storage, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(storage, 'run-'));
const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'));
const { z } = sdkRequire('zod');
const nativeCli = sdkRequire.resolve(
  `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${process.platform === 'win32' ? '.exe' : ''}`,
);
const expectedInput = { text: 'synthetic MCP argument', count: 7 };
const reason = 'Explicit user confirmation required for synthetic arguments.';
const report = { mode: 'local-model', status: 'running', scenarios: [] };
let current;

// The fixture emits one tool call, then ends after the real SDK returns a result.
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(pathname)) {
      response.writeHead(404).end();
      return;
    }
    let input = '';
    for await (const chunk of request) {
      input += chunk;
      if (input.length > 2 * 1024 * 1024) throw new Error('Fixture request too large');
    }
    const body = JSON.parse(input);
    if (pathname.endsWith('/count_tokens')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}');
      return;
    }
    current.modelRequests += 1;
    const called = body.messages?.some((message) => Array.isArray(message.content)
      && message.content.some((part) => part.type === 'tool_result'));
    const content = called ? { type: 'text', text: 'Completed.' } : {
      type: 'tool_use', id: 'toolu_probe_echo', name: 'mcp__probe__echo', input: expectedInput,
    };
    const stopReason = called ? 'end_turn' : 'tool_use';
    const message = {
      id: `msg_probe_${current.modelRequests}`, type: 'message', role: 'assistant', model: body.model,
      content: [content], stop_reason: stopReason, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 30 },
    };
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const emit = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    emit('message_start', { message: { ...message, content: [], stop_reason: null,
      usage: { input_tokens: 100, output_tokens: 0 } } });
    emit('content_block_start', { index: 0,
      content_block: called ? { type: 'text', text: '' } : { ...content, input: {} } });
    emit('content_block_delta', { index: 0, delta: called
      ? { type: 'text_delta', text: content.text }
      : { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } });
    emit('content_block_stop', { index: 0 });
    emit('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 30 } });
    emit('message_stop', {});
    response.end();
  } catch {
    response.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"Invalid local fixture request"}');
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const executionEnv = { ...process.env };
for (const key of [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy',
]) delete executionEnv[key];
Object.assign(executionEnv, {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_MODEL: 'claude-sonnet-4-6',
  NO_PROXY: '127.0.0.1,localhost', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
});

try {
  for (const [name, ask, allow] of [
    ['bypass_control', false, false], ['ask_deny', true, false], ['ask_allow', true, true],
  ]) {
    const workspace = path.join(runRoot, name);
    await fs.mkdir(workspace, { recursive: true });
    current = { name, ask, modelRequests: 0, hookEvents: [], permissionRequests: [], executions: [] };
    report.scenarios.push(current);
    const mcp = createSdkMcpServer({ name: 'probe', version: '1.0.0', alwaysLoad: true, tools: [
      tool('echo', 'Return synthetic data', { text: z.string(), count: z.number() }, async (args) => {
        current.executions.push(args);
        return { content: [{ type: 'text', text: JSON.stringify(args) }] };
      }),
    ] });
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 60_000);
    let sdkQuery;
    try {
      sdkQuery = query({ prompt: 'Use probe echo once with synthetic arguments.', options: {
        cwd: workspace, env: { ...executionEnv, CLAUDE_CONFIG_DIR: path.join(workspace, 'config') },
        pathToClaudeCodeExecutable: nativeCli, model: 'claude-sonnet-4-6', persistSession: false,
        settingSources: [], skills: [], plugins: [], mcpServers: { probe: mcp }, strictMcpConfig: true,
        settings: { autoMemoryEnabled: false, claudeMdExcludes: ['**'] }, systemPrompt: 'Call the requested tool.',
        tools: [], allowedTools: ['mcp__probe__echo'], permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true, maxTurns: 3, abortController,
        hooks: { PreToolUse: [{ matcher: '^mcp__.*', hooks: [async (input, toolId) => {
          current.hookEvents.push({ input, toolId });
          return ask ? { hookSpecificOutput: { hookEventName: 'PreToolUse',
            permissionDecision: 'ask', permissionDecisionReason: reason } } : {};
        }] }] },
        canUseTool: async (toolName, input, context) => {
          const { signal, ...details } = context;
          current.permissionRequests.push({ toolName, input, context: details,
            signalIsAbortSignal: signal instanceof AbortSignal });
          assert.equal(current.executions.length, 0, 'MCP must not execute before the confirmation callback');
          await new Promise((resolve) => setTimeout(resolve, 750));
          current.executionsWhilePending = current.executions.length;
          assert.equal(current.executionsWhilePending, 0, 'MCP must remain blocked while confirmation is pending');
          current.decision = resolveMcpToolConfirmation({ allow, remember: true,
            updatedInput: { text: 'must not replace displayed args', count: 999 } }, input);
          return current.decision;
        },
      } });
      for await (const message of sdkQuery) {
        if (message.type === 'result') current.result = {
          subtype: message.subtype, numTurns: message.num_turns, isError: message.is_error,
        };
      }
    } finally {
      clearTimeout(timer);
      sdkQuery?.close();
    }
    assert.equal(current.hookEvents.length, 1);
    assert.equal(current.permissionRequests.length, ask ? 1 : 0);
    assert.equal(current.executions.length, !ask || allow ? 1 : 0);
    assert.equal(current.result?.subtype, 'success');
    for (const args of current.executions) assert.deepEqual(args, expectedInput);
    if (ask) {
      assert.deepEqual(current.permissionRequests[0].input, expectedInput);
      assert.equal(current.permissionRequests[0].context.decisionReason, reason);
      assert.equal(current.permissionRequests[0].context.toolUseID, current.hookEvents[0].toolId);
      assert.equal(current.decision.updatedPermissions, undefined);
    }
    console.log(`${name}: permission requests=${current.permissionRequests.length}, MCP executions=${current.executions.length}`);
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof assert.AssertionError ? error.message : `PROBE_FAILED:${error.name || 'Error'}`;
  process.exitCode = 1;
} finally {
  const evidencePath = path.join(runRoot, 'evidence.json');
  await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  console.log(`${report.status.toUpperCase()}: ${evidencePath}`);
}
