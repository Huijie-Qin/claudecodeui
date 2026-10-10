import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { query } from '@anthropic-ai/claude-agent-sdk';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESPONSE_TEXT = '分支上下文已保留：之前选择的是蓝色（blue）。';

/** A local-only model endpoint plus real SDK resume for the browser fixture.
 * The returned requests array contains mock HTTP bodies, including the model's
 * actual resumed context. No account configuration or real credentials are used.
 */
export async function createForkBrowserModel({ runtimeHomePath, cwd }) {
  if (!path.isAbsolute(runtimeHomePath) || !path.isAbsolute(cwd)) {
    throw new TypeError('The browser model requires absolute temporary home and workspace paths');
  }
  const home = await fs.realpath(runtimeHomePath);
  const workspace = await fs.realpath(cwd);
  const configDirectory = path.join(home, '.claude');
  await fs.mkdir(configDirectory, { recursive: true });
  const sdkRequire = createRequire(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
  const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const executable = path.join(path.dirname(sdkRequire.resolve(`${platformPackage}/package.json`)),
    process.platform === 'win32' ? 'claude.exe' : 'claude');
  const requests = [];
  let responseIndex = 0;
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
        return;
      }
      if (!req.url?.startsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'not_found_error', message: 'Local fixture endpoint only' } }));
        return;
      }
      const response = {
        id: `msg_local_browser_fork_${++responseIndex}`, type: 'message', role: 'assistant',
        model: 'claude-sonnet-4-6', content: [{ type: 'text', text: RESPONSE_TEXT }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 30, output_tokens: 16 },
      };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event('message_start', { message: { ...response, content: [], stop_reason: null,
        usage: { input_tokens: 30, output_tokens: 0 } } });
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: RESPONSE_TEXT } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 16 } });
      event('message_stop', {});
      res.end();
    } catch (error) {
      requests.push({ method: req.method, url: req.url, error: error.message });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'api_error', message: 'Local mock request could not be decoded' } }));
    }
  });
  // Any proxy attempt to an external HTTPS destination is refused locally.
  server.on('connect', (_req, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const isolatedEnv = {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, TMPDIR: home,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: configDirectory,
    ANTHROPIC_API_KEY: 'dummy-local-browser-test-key', ANTHROPIC_BASE_URL: endpoint,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_CODE_SIMPLE: '1',
    HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, ALL_PROXY: endpoint, NO_PROXY: '127.0.0.1,localhost',
  };
  const active = new Set();
  let closed = false;
  let closing;

  return {
    requests,
    async resume({ sessionId, prompt, onMessage = () => {} }) {
      if (closed) throw new Error('The local browser model is closed');
      if (!UUID_PATTERN.test(sessionId || '') || typeof prompt !== 'string' || !prompt.trim()) {
        throw new TypeError('A valid fork session UUID and prompt are required');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      const stderr = [];
      const messages = [];
      const run = { controller, query: null };
      active.add(run);
      try {
        run.query = query({ prompt, options: {
          cwd: workspace, resume: sessionId, pathToClaudeCodeExecutable: executable,
          model: 'claude-sonnet-4-6', maxTurns: 1, persistSession: true, abortController: controller,
          env: isolatedEnv, settingSources: [], tools: [], skills: [], mcpServers: {}, strictMcpConfig: true,
          settings: { disableAllHooks: true }, permissionMode: 'dontAsk',
          systemPrompt: 'This is a local conversation branch test. Reply directly without using tools.',
          stderr: (data) => { if (stderr.join('').length < 8000) stderr.push(data); },
          // Never allow SDK environment defaults to inherit user credentials.
          spawnClaudeCodeProcess: (options) => spawn(options.command, options.args, {
            cwd: workspace, env: isolatedEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal,
          }),
        } });
        for await (const message of run.query) {
          messages.push(message);
          await onMessage(message);
        }
        const result = messages.findLast(message => message.type === 'result');
        if (result?.subtype !== 'success') {
          throw new Error(`Local SDK resume did not complete successfully: ${JSON.stringify(result || null)}`);
        }
        return { sessionId, messages, result };
      } catch (error) {
        throw new Error(`Local SDK resume failed: ${error.message}\n${stderr.join('').slice(-4000)}`, { cause: error });
      } finally {
        clearTimeout(timer);
        run.query?.close();
        active.delete(run);
      }
    },
    async close() {
      if (closing) return closing;
      closed = true;
      for (const run of active) {
        run.controller.abort();
        run.query?.close();
      }
      closing = new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
      return closing;
    },
  };
}
