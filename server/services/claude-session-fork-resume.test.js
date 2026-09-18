import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { forkClaudeSessionFiles } from './claude-session-fork-files.js';

test('actual Claude SDK resumes a fork with the selected native context and writes only to the fork', { timeout: 40_000 }, async (t) => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-fork-resume-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'workspace');
  const configDirectory = path.join(home, '.claude');
  const projectDirectory = path.join(configDirectory, 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
  await fs.mkdir(cwd);
  await fs.mkdir(projectDirectory, { recursive: true });
  const sourceSessionId = randomUUID();
  const ids = Array.from({ length: 6 }, () => randomUUID());
  const oldUser = 'FORK_CONTEXT_USER_BEFORE_CUTOFF';
  const oldResult = 'FORK_CONTEXT_TOOL_RESULT_BEFORE_CUTOFF';
  const oldReply = 'FORK_CONTEXT_ASSISTANT_AT_CUTOFF';
  const laterUser = 'FORK_FUTURE_USER_MUST_NOT_APPEAR';
  const laterReply = 'FORK_FUTURE_ASSISTANT_MUST_NOT_APPEAR';
  const newUser = 'FORK_NEW_USER_CONTINUATION';
  const newReply = 'FORK_NEW_ASSISTANT_CONTINUATION';
  const assistant = (id, content, stopReason) => ({ id, type: 'message', role: 'assistant',
    model: 'claude-sonnet-4-6', content, stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 } });
  const entries = [
    { type: 'user', message: { role: 'user', content: oldUser } },
    { type: 'assistant', message: assistant('msg_before_tool', [
      { type: 'tool_use', id: 'toolu_before_cutoff', name: 'Read', input: { file_path: path.join(cwd, 'fixture.txt') } },
    ], 'tool_use') },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_before_cutoff', content: oldResult },
    ] } },
    { type: 'assistant', message: assistant('msg_at_cutoff', [{ type: 'text', text: oldReply }], 'end_turn') },
    { type: 'user', message: { role: 'user', content: laterUser } },
    { type: 'assistant', message: assistant('msg_after_cutoff', [{ type: 'text', text: laterReply }], 'end_turn') },
  ].map((entry, index) => ({ ...entry, uuid: ids[index], parentUuid: index ? ids[index - 1] : null,
    sessionId: sourceSessionId, cwd, isSidechain: false, userType: 'external', version: '2.1.141',
    timestamp: new Date(Date.UTC(2026, 8, 18, 1, 0, index)).toISOString() }));
  const sourcePath = path.join(projectDirectory, `${sourceSessionId}.jsonl`);
  const original = `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`;
  await fs.writeFile(sourcePath, original);
  const fork = await forkClaudeSessionFiles({ runtimeHomePath: home, sourceSessionId,
    sourceMessageUuid: ids[3], title: 'Local mock resume test' });

  const requests = [];
  const requestErrors = [];
  const modelResponse = { id: 'msg_local_fork_resume', type: 'message', role: 'assistant',
    model: 'claude-sonnet-4-6', content: [{ type: 'text', text: newReply }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 30, output_tokens: 8 } };
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const raw = req.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes;
      const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      requests.push({ method: req.method, url: req.url, body });
      if (req.url?.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 30 }));
      } else if (req.url?.startsWith('/v1/messages')) {
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
          event('message_start', { message: { ...modelResponse, content: [], stop_reason: null,
            usage: { input_tokens: 30, output_tokens: 0 } } });
          event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
          event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: newReply } });
          event('content_block_stop', { index: 0 });
          event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } });
          event('message_stop', {});
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(modelResponse));
        }
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'not_found_error', message: 'Local test endpoint only' } }));
      }
    } catch (error) {
      requestErrors.push(error.message);
      res.writeHead(500); res.end();
    }
  });
  server.on('connect', (_req, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  // Resolve the optional native package from the SDK's dependency scope (pnpm).
  const sdkRequire = createRequire(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
  const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const executable = path.join(path.dirname(sdkRequire.resolve(`${platformPackage}/package.json`)), process.platform === 'win32' ? 'claude.exe' : 'claude');
  const isolatedEnv = {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, TMPDIR: home,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    CLAUDE_CONFIG_DIR: configDirectory,
    ANTHROPIC_API_KEY: 'dummy-local-test-key', ANTHROPIC_BASE_URL: endpoint,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_CODE_SIMPLE: '1',
    HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, ALL_PROXY: endpoint, NO_PROXY: '127.0.0.1,localhost',
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  t.after(() => { clearTimeout(timer); controller.abort(); });
  const stderr = [];
  const messages = [];
  const session = query({ prompt: newUser, options: {
    cwd, resume: fork.sessionId, pathToClaudeCodeExecutable: executable,
    model: 'claude-sonnet-4-6', maxTurns: 1, persistSession: true, abortController: controller,
    env: isolatedEnv, settingSources: [], tools: [], skills: [], mcpServers: {}, strictMcpConfig: true,
    settings: { disableAllHooks: true }, permissionMode: 'dontAsk',
    systemPrompt: 'You are a local integration test. Reply directly; never use tools.',
    stderr: (data) => stderr.push(data),
    // Enforce a complete allowlist even if SDK defaults gain new environment variables.
    spawnClaudeCodeProcess: (options) => spawn(options.command, options.args, {
      cwd, env: isolatedEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal,
    }),
  } });
  try {
    for await (const message of session) messages.push(message);
  } catch (error) {
    assert.fail(`Local SDK resume failed: ${error.message}\n${stderr.join('').slice(-4000)}`);
  } finally {
    clearTimeout(timer);
    session.close();
  }
  assert.deepEqual(requestErrors, []);
  const modelRequests = requests.filter(request => request.url?.startsWith('/v1/messages') && !request.url.includes('count_tokens'));
  assert.ok(modelRequests.length > 0, `No mock model request; ${JSON.stringify(messages)}`);
  const sentContext = JSON.stringify(modelRequests[0].body.messages);
  for (const marker of [oldUser, oldResult, oldReply, newUser]) assert.ok(sentContext.includes(marker), `Missing context: ${marker}`);
  for (const marker of [laterUser, laterReply]) assert.ok(!sentContext.includes(marker), `Future context leaked: ${marker}`);
  assert.ok(sentContext.includes('toolu_before_cutoff'), 'Historical tool_use/result linkage must survive resume');
  assert.ok(messages.some(message => message.type === 'result' && message.subtype === 'success'), JSON.stringify(messages));
  assert.ok(messages.filter(message => message.session_id).every(message => message.session_id === fork.sessionId));
  assert.equal(await fs.readFile(sourcePath, 'utf8'), original);
  const forkEntries = (await fs.readFile(path.join(projectDirectory, `${fork.sessionId}.jsonl`), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line));
  assert.ok(forkEntries.some(entry => !entry.forkedFrom && JSON.stringify(entry.message || {}).includes(newUser)));
  assert.ok(forkEntries.some(entry => !entry.forkedFrom && JSON.stringify(entry.message || {}).includes(newReply)));
});
