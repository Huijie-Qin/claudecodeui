import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { userDb } from '../database/db.js';
import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';

const execFileAsync = promisify(execFile);
const __dirname = getModuleDir(import.meta.url);
const APP_ROOT = findAppRoot(__dirname);
const HEADER_TIMEOUT_MS = 10_000;
const HEADER_MAX_BUFFER_BYTES = 64 * 1024;
const MCP_TIMEOUT_MS = 30_000;
const PRIVATE_TOKEN_ENV_NAME = 'PRIVATE_TOKEN';

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requiredConfig(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw createHttpError(`${name} is not configured`, 500);
  }
  return value;
}

function optionalConfig(name, fallback) {
  return String(process.env[name] || fallback || '').trim();
}

function resolveAppPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  return path.isAbsolute(raw) ? raw : path.resolve(APP_ROOT, raw);
}

function redactSecret(value, secret = '') {
  let output = String(value || '');
  if (secret) {
    output = output.split(secret).join('[redacted]');
  }
  output = output.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]');
  output = output.replace(/PRIVATE_TOKEN["'\s:=]+[^"',}\s]+/gi, 'PRIVATE_TOKEN=[redacted]');
  return output.slice(0, 2000);
}

function parseJsonText(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function summarizeMcpContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item?.text === 'string') return item.text;
      if (item?.json !== undefined) return JSON.stringify(item.json);
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .slice(0, 2000);
}

function unwrapMcpToolResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }

  if (!Array.isArray(result.content)) {
    return result;
  }

  if (result.isError) {
    throw createHttpError(summarizeMcpContent(result.content) || 'CodeHub MCP tool returned an error', 502);
  }

  if (result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) {
    return result.structuredContent;
  }

  for (const item of result.content) {
    if (item?.json !== undefined) {
      return item.json;
    }
    if (typeof item?.text === 'string') {
      const parsed = parseJsonText(item.text);
      if (parsed !== null) {
        return parsed;
      }
    }
  }

  return result;
}

function readPrivateToken(userId) {
  const envToken = String(process.env[PRIVATE_TOKEN_ENV_NAME] || '').trim();
  if (envToken) return envToken;
  const token = userDb.getGitTokenForUser(userId);
  if (!token) {
    throw createHttpError('Git token is not configured for the current user', 400);
  }
  return token;
}

async function getCodeHubHeaders({ userId }) {
  const token = readPrivateToken(userId);
  const python = optionalConfig('CODEHUB_HEADER_PYTHON', 'python3');
  const scriptPath = resolveAppPath(optionalConfig('CODEHUB_HEADER_SCRIPT', 'scripts/code-header.py'));

  try {
    const { stdout } = await execFileAsync(python, [scriptPath], {
      timeout: HEADER_TIMEOUT_MS,
      maxBuffer: HEADER_MAX_BUFFER_BYTES,
      env: {
        ...process.env,
        [PRIVATE_TOKEN_ENV_NAME]: token,
      },
    });
    const parsed = JSON.parse(String(stdout || '').trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('headers script must output a JSON object');
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([key, value]) => key && typeof value === 'string' && value !== ''),
    );
  } catch (error) {
    const stderr = redactSecret(error?.stderr || error?.message || 'Failed to run CodeHub headers script', token);
    throw createHttpError(`Failed to resolve CodeHub MCP headers: ${stderr}`, 502);
  }
}

async function postJson({ url, headers, payload, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw createHttpError(`CodeHub MCP returned non-JSON response (${response.status})`, 502);
      }
    }
    if (!response.ok) {
      throw createHttpError(body?.message || body?.error || `CodeHub MCP returned ${response.status}`, response.status);
    }
    if (body?.error) {
      throw createHttpError(body.error?.message || body.error || 'CodeHub MCP returned an error', 502);
    }
    return unwrapMcpToolResult(body?.result ?? body);
  } catch (error) {
    if (error?.statusCode) throw error;
    const message = error?.name === 'AbortError'
      ? 'CodeHub MCP request timed out'
      : `CodeHub MCP request failed: ${error?.message || error}`;
    throw createHttpError(message, 502);
  } finally {
    clearTimeout(timer);
  }
}

export function createCodeHubMcpService({ fetchImpl = fetch } = {}) {
  async function callTool({ userId, toolName, arguments: toolArguments }) {
    const url = requiredConfig('CODEHUB_MCP_URL');
    const headers = await getCodeHubHeaders({ userId });
    return postJson({
      url,
      headers,
      fetchImpl,
      payload: {
        jsonrpc: '2.0',
        id: `codehub-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: toolArguments,
        },
      },
    });
  }

  return {
    getProjectInfo: ({ userId, gitUrl }) => callTool({
      userId,
      toolName: optionalConfig('CODEHUB_MCP_TOOL_GET_PROJECT_INFO', 'get_project_info'),
      arguments: {
        codehub_host: requiredConfig('CODEHUB_HOST'),
        git_url: gitUrl,
        request: { view: 'all' },
      },
    }),

    createMergeRequest: ({
      userId,
      projectId,
      sourceProjectId,
      targetProjectId,
      sourceBranch,
      targetBranch,
      title,
      description,
    }) => {
      const request = {
        source_branch: sourceBranch,
        target_branch: targetBranch,
        title,
        description,
      };
      if (sourceProjectId && targetProjectId) {
        request.source_project_id = Number(sourceProjectId);
        request.target_project_id = Number(targetProjectId);
      } else {
        request.project_id = Number(projectId);
      }
      return callTool({
        userId,
        toolName: optionalConfig('CODEHUB_MCP_TOOL_CREATE_MR', 'create_merge_request'),
        arguments: {
          gitlab_host: requiredConfig('CODEHUB_HOST'),
          request,
        },
      });
    },

    getMergeRequestInfo: ({ userId, projectId, mergeRequestIid }) => callTool({
      userId,
      toolName: optionalConfig('CODEHUB_MCP_TOOL_GET_MR', 'get_merge_request_info'),
      arguments: {
        gitlab_host: requiredConfig('CODEHUB_HOST'),
        request: {
          project_id: Number(projectId),
          merge_request_iid: Number(mergeRequestIid),
        },
      },
    }),

    syncRepo: ({ userId, projectId, branch }) => callTool({
      userId,
      toolName: optionalConfig('CODEHUB_MCP_TOOL_SYNC_REPO', 'sync_repo'),
      arguments: {
        gitlab_host: requiredConfig('CODEHUB_HOST'),
        request: {
          project_id: Number(projectId),
          branch,
        },
      },
    }),
  };
}

export const codeHubMcpService = createCodeHubMcpService();
