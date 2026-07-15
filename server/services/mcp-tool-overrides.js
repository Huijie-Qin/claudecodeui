import { promises as fs } from 'fs';
import path from 'path';

import {
  WORKSPACE_CONTAINER_ROOT_ENV,
  WORKSPACE_HOST_ROOT_ENV,
  buildWorkspacePathCandidates,
} from './workspace-path-mapping.js';

export const MCP_TOOL_OVERRIDES_RELATIVE_PATH = path.join('.claude', 'mcp-tool-overrides.local.json');
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
  return buildWorkspacePathCandidates(workspaceRoot, env)
    .map((root) => path.join(root, MCP_TOOL_OVERRIDES_RELATIVE_PATH));
}

export async function readMcpToolOverridesConfig(workspaceRoot, { env = process.env } = {}) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) return null;

  for (const configPath of buildConfigPathCandidates(workspaceRoot, env)) {
    try {
      const content = (await fs.readFile(configPath, 'utf8')).replace(/^\uFEFF/, '');
      if (!content.trim()) return null;

      const parsed = JSON.parse(content);
      return isPlainObject(parsed) ? parsed : null;
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        continue;
      }
      throw error;
    }
  }

  return null;
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
    if (!isPlainObject(entry) || entry.custom !== true) continue;

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

