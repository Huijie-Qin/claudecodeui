import { promises as fs } from 'fs';
import path from 'path';

import {
  WORKSPACE_CONTAINER_ROOT_ENV,
  WORKSPACE_HOST_ROOT_ENV,
  buildWorkspacePathCandidates,
} from './workspace-path-mapping.js';

export const MCP_TOOL_OVERRIDES_RELATIVE_PATH = path.join('.claude', 'mcp-tool-overrides.local.json');
export const MCP_TOOL_OVERRIDES_TRACE_LOG_ID = 'MCP_TOOL_OVERRIDES_TRACE';
export { WORKSPACE_CONTAINER_ROOT_ENV, WORKSPACE_HOST_ROOT_ENV };

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseMcpToolName(toolName) {
  if (typeof toolName !== 'string') return null;
  const match = toolName.match(/^mcp__(.+?)__(.+)$/);
  if (!match) return null;
  return {
    serverName: match[1],
    toolName: match[2],
  };
}

export function isMcpToolName(toolName) {
  return parseMcpToolName(toolName) !== null;
}

function buildConfigPathCandidates(workspaceRoot, env = process.env) {
  const candidates = [];
  if (typeof workspaceRoot === 'string' && workspaceRoot.trim()) {
    candidates.push(
      ...buildWorkspacePathCandidates(workspaceRoot, env)
        .map((root, index) => ({
          source: index === 0 ? 'workspace' : 'mapped',
          path: path.join(root, MCP_TOOL_OVERRIDES_RELATIVE_PATH),
        })),
    );
  }
  candidates.push({
    source: 'relative',
    path: MCP_TOOL_OVERRIDES_RELATIVE_PATH,
  });

  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

function buildTraceMeta({ workspaceRoot, candidates, selectedCandidate = null }) {
  return {
    logId: MCP_TOOL_OVERRIDES_TRACE_LOG_ID,
    workspaceRoot: typeof workspaceRoot === 'string' && workspaceRoot.trim() ? workspaceRoot : null,
    cwd: process.cwd(),
    selected: selectedCandidate
      ? { source: selectedCandidate.source, path: selectedCandidate.path }
      : null,
    candidates: candidates.map((candidate) => ({
      source: candidate.source,
      path: candidate.path,
    })),
  };
}

function logTrace(logger, level, message, meta = {}) {
  const logFn = logger?.[level] || logger?.log;
  if (typeof logFn !== 'function') return;
  logFn.call(logger, `[${MCP_TOOL_OVERRIDES_TRACE_LOG_ID}] ${message} ${JSON.stringify(meta)}`);
}

export async function readMcpToolOverridesConfig(workspaceRoot, { env = process.env, logger = console } = {}) {
  const candidates = buildConfigPathCandidates(workspaceRoot, env);

  for (const candidate of candidates) {
    try {
      const content = (await fs.readFile(candidate.path, 'utf8')).replace(/^\uFEFF/, '');
      if (!content.trim()) {
        logTrace(logger, 'info', 'Config file is empty', buildTraceMeta({
          workspaceRoot,
          candidates,
          selectedCandidate: candidate,
        }));
        return null;
      }

      const parsed = JSON.parse(content);
      if (!isPlainObject(parsed)) {
        logTrace(logger, 'warn', 'Config file is not a JSON object', buildTraceMeta({
          workspaceRoot,
          candidates,
          selectedCandidate: candidate,
        }));
        return null;
      }

      logTrace(logger, 'info', 'Loaded config file', buildTraceMeta({
        workspaceRoot,
        candidates,
        selectedCandidate: candidate,
      }));
      return parsed;
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        continue;
      }
      logTrace(logger, 'warn', 'Failed to read config file', {
        ...buildTraceMeta({ workspaceRoot, candidates, selectedCandidate: candidate }),
        errorCode: error?.code || null,
        errorMessage: error?.message || String(error),
      });
      throw error;
    }
  }

  logTrace(logger, 'info', 'No config file found', buildTraceMeta({
    workspaceRoot,
    candidates,
  }));
  return null;
}

export async function mergeMcpToolOverridesConfig(workspaceRoot, mcpServers) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
    throw new Error('workspaceRoot is required');
  }
  if (!isPlainObject(mcpServers)) {
    throw new Error('mcpServers must be an object');
  }

  const targetPath = path.join(workspaceRoot, MCP_TOOL_OVERRIDES_RELATIVE_PATH);
  let current = {};
  try {
    const content = (await fs.readFile(targetPath, 'utf8')).replace(/^\uFEFF/, '');
    const parsed = content.trim() ? JSON.parse(content) : {};
    current = isPlainObject(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
  }

  const nextConfig = {
    ...current,
    version: 1,
    mcpServers: {
      ...(isPlainObject(current.mcpServers) ? current.mcpServers : {}),
      ...mcpServers,
    },
  };
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, targetPath);
  return nextConfig;
}

export function applyMcpToolOverrides({ toolName, input, config }) {
  const parsedToolName = parseMcpToolName(toolName);
  if (!parsedToolName || !isPlainObject(config)) {
    return { input, applied: false, appliedParams: [] };
  }

  const params = config
    ?.mcpServers?.[parsedToolName.serverName]
    ?.tools?.[parsedToolName.toolName]
    ?.params;
  if (!isPlainObject(params)) {
    return { input, applied: false, appliedParams: [], ...parsedToolName };
  }

  const mergedInput = isPlainObject(input) ? { ...input } : {};
  const appliedParams = [];

  for (const [key, entry] of Object.entries(params)) {
    if (!isPlainObject(entry)) continue;

    const mode = entry.mode === 'default' || entry.mode === 'force'
      ? entry.mode
      : entry.custom === true
        ? 'force'
        : null;
    if (!mode) continue;
    if (mode === 'default' && Object.prototype.hasOwnProperty.call(mergedInput, key)) continue;

    mergedInput[key] = entry.value;
    appliedParams.push(key);
  }

  if (appliedParams.length === 0) {
    return { input, applied: false, appliedParams, ...parsedToolName };
  }

  return {
    input: mergedInput,
    applied: true,
    appliedParams,
    ...parsedToolName,
  };
}

export function buildMcpToolOverridePreToolUseOutput({ toolName, input, config }) {
  const overrideResult = applyMcpToolOverrides({ toolName, input, config });
  if (!overrideResult.applied) {
    return {
      output: {},
      overrideResult,
    };
  }

  return {
    output: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: overrideResult.input,
      },
    },
    overrideResult,
  };
}
