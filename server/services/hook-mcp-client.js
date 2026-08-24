import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const HEADER_HELPER_TIMEOUT_MS = 10_000;
const HOST_SHELL_COMMAND = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
const HOST_SHELL_ARGS = process.platform === 'win32' ? ['/d', '/c'] : ['-lc'];
const DOCKER_HOST_ALIAS = 'host.docker.internal';
const HOST_LOOPBACK_ADDRESS = '127.0.0.1';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveMcpTarget(qualifiedToolName, mcpServers) {
  if (typeof qualifiedToolName !== 'string' || !qualifiedToolName.startsWith('mcp__')) {
    throw new Error('Hook MCP action must use a qualified mcp__server__tool name');
  }
  const matches = Object.keys(mcpServers || {})
    .filter((serverName) => qualifiedToolName.startsWith(`mcp__${serverName}__`))
    .sort((left, right) => right.length - left.length);
  const serverName = matches[0];
  if (!serverName) throw new Error(`MCP server for ${qualifiedToolName} is not configured in this workspace`);
  const toolName = qualifiedToolName.slice(`mcp__${serverName}__`.length);
  if (!toolName) throw new Error(`MCP tool name is missing in ${qualifiedToolName}`);
  return { serverName, toolName, config: mcpServers[serverName] };
}

async function resolveHeaders(serverName, config, headersHelperRunner) {
  const headers = isPlainObject(config?.headers)
    ? Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, String(value)]))
    : {};
  const helper = typeof config?.headersHelper === 'string' ? config.headersHelper.trim() : '';
  if (!helper) return headers;
  const helperEnvironment = {
    CLAUDE_CODE_MCP_SERVER_NAME: serverName,
    CLAUDE_CODE_MCP_SERVER_URL: config.url || '',
  };
  const { stdout } = headersHelperRunner
    ? await headersHelperRunner({ command: helper, env: helperEnvironment, timeoutMs: HEADER_HELPER_TIMEOUT_MS })
    : await execFileAsync(HOST_SHELL_COMMAND, [...HOST_SHELL_ARGS, helper], {
        timeout: HEADER_HELPER_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        env: { ...process.env, ...helperEnvironment },
        windowsHide: true,
      });
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || '').trim());
  } catch {
    throw new Error(`MCP headersHelper for ${serverName} did not return a JSON object`);
  }
  if (!isPlainObject(parsed) || Object.values(parsed).some((value) => typeof value !== 'string')) {
    throw new Error(`MCP headersHelper for ${serverName} must return string header values`);
  }
  return { ...headers, ...parsed };
}

function resolveHostRuntimeMcpUrl(serverName, value) {
  const url = new URL(value);
  if (url.hostname.toLowerCase() === DOCKER_HOST_ALIAS) {
    url.hostname = HOST_LOOPBACK_ADDRESS;
  }
  return url;
}

async function createTransport(serverName, config, cwd, headersHelperRunner) {
  if (!isPlainObject(config)) throw new Error(`MCP server ${serverName} has an invalid configuration`);
  if (config.type === 'sdk') {
    throw new Error(`MCP server ${serverName} is an in-process SDK server and cannot be called by a Hook action`);
  }
  if (typeof config.command === 'string' && config.command.trim()) {
    return new StdioClientTransport({
      command: config.command,
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      env: isPlainObject(config.env)
        ? { ...process.env, ...Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, String(value)])) }
        : process.env,
      cwd,
      stderr: 'pipe',
    });
  }
  if (typeof config.url !== 'string' || !config.url.trim()) {
    throw new Error(`MCP server ${serverName} must configure command or url`);
  }
  const headers = await resolveHeaders(serverName, config, headersHelperRunner);
  // Hook post-actions execute in the CCUI Node.js process even when the
  // originating Claude session runs in Docker. The built-in SQL checker points
  // back to CCUI itself, so its Docker host alias must become loopback for this
  // direct call. Custom MCP addresses are intentionally left untouched.
  const url = resolveHostRuntimeMcpUrl(serverName, config.url);
  if (config.type === 'sse') {
    return new SSEClientTransport(url, {
      requestInit: { headers },
      eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers: { ...headers, ...init?.headers } }) },
    });
  }
  return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
}

function normalizeToolOutput(result) {
  if (result?.isError) {
    const message = Array.isArray(result.content)
      ? result.content.map((item) => item?.text || '').filter(Boolean).join('\n')
      : '';
    throw new Error(message || 'MCP tool returned an error');
  }
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const content = Array.isArray(result?.content) ? result.content : [];
  if (content.length === 1 && typeof content[0]?.text === 'string') {
    try {
      return JSON.parse(content[0].text);
    } catch {
      return content[0].text;
    }
  }
  return result;
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new Error('MCP Hook action was aborted'));
  return new Promise((resolve, reject) => {
    const handleAbort = () => reject(signal.reason || new Error('MCP Hook action was aborted'));
    signal.addEventListener('abort', handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', handleAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', handleAbort);
        reject(error);
      },
    );
  });
}

export async function callHookMcpTool({
  qualifiedToolName,
  input,
  mcpServers,
  cwd,
  signal,
  headersHelperRunner,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const { serverName, toolName, config } = resolveMcpTarget(qualifiedToolName, mcpServers);
  const transport = await createTransport(serverName, config, cwd, headersHelperRunner);
  const client = new Client({ name: 'ccui-hook-runtime', version: '1.0.0' });
  const controller = new AbortController();
  const handleCallerAbort = () => controller.abort(signal?.reason || new Error('MCP Hook action was aborted'));
  if (signal?.aborted) handleCallerAbort();
  else signal?.addEventListener('abort', handleCallerAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`MCP Hook action timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );
  try {
    await waitWithSignal(client.connect(transport), controller.signal);
    const result = await client.callTool(
      { name: toolName, arguments: isPlainObject(input) ? input : {} },
      undefined,
      { signal: controller.signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs },
    );
    return normalizeToolOutput(result);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', handleCallerAbort);
    await client.close().catch(() => {});
  }
}

export { normalizeToolOutput, resolveHeaders, resolveHostRuntimeMcpUrl, resolveMcpTarget };
