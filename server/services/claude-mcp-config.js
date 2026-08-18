import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { applyWorkspaceMcpHelperScripts } from './mcp-helper-scripts.js';

async function readJsonIfPresent(filePath, label) {
  try {
    try {
      await fs.access(filePath);
    } catch (error) {
      return null;
    }

    const configContent = await fs.readFile(filePath, 'utf8');
    return JSON.parse(configContent);
  } catch (error) {
    console.error(`Failed to parse ${label}:`, error.message);
    return null;
  }
}

function mergeMcpServers(target, source) {
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    return { ...target, ...source };
  }
  return target;
}

function applyMcpConfigToSdkOptions(sdkOptions, mcpServers) {
  // The SDK otherwise lets Claude Code discover MCP servers from persisted
  // sessions and filesystem config. That makes a removed workspace server
  // reappear when a conversation is resumed. loadMcpConfig already builds the
  // complete server inventory for this turn, so make that inventory authoritative.
  sdkOptions.strictMcpConfig = true;

  if (mcpServers && Object.keys(mcpServers).length > 0) {
    sdkOptions.mcpServers = mcpServers;
  } else {
    delete sdkOptions.mcpServers;
  }

  return sdkOptions;
}

/**
 * Loads MCP server configurations visible to the current Claude agent turn.
 * Admin-installed workspace presets are written to <cwd>/.mcp.json and must be
 * forwarded to the Agent SDK; the SDK does not reliably discover that file for us.
 *
 * @param {string} cwd - Current workspace path for project-scoped configs
 * @param {Object} options
 * @param {boolean} options.includeHostConfig - Whether to include host ~/.claude.json
 * @param {string} options.homeDir - Home directory to read host Claude config from
 * @param {number} options.tenantId - Tenant id used to resolve Admin-managed helper scripts
 * @param {number} options.workspaceId - Workspace id used to resolve Admin-managed installs
 * @param {string} options.runtimeMode - local or docker
 * @param {string} options.runtimeHomePath - Docker runtime home mounted at /home/cloudcli
 * @param {{uid: number, gid: number}|null} options.runtimeOwner - Docker runtime file owner
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd, {
  includeHostConfig = true,
  homeDir = os.homedir(),
  tenantId = null,
  workspaceId = null,
  runtimeMode = 'local',
  runtimeHomePath = null,
  runtimeOwner = null,
} = {}) {
  try {
    let mcpServers = {};

    if (includeHostConfig) {
      const claudeConfigPath = path.join(homeDir, '.claude.json');
      const claudeConfig = await readJsonIfPresent(claudeConfigPath, '~/.claude.json');

      if (claudeConfig) {
        mcpServers = mergeMcpServers(mcpServers, claudeConfig.mcpServers);

        if (claudeConfig.claudeProjects && cwd) {
          const projectConfig = claudeConfig.claudeProjects[cwd];
          mcpServers = mergeMcpServers(mcpServers, projectConfig?.mcpServers);
        }
      }
    }

    if (cwd) {
      const workspaceConfig = await readJsonIfPresent(path.join(cwd, '.mcp.json'), `${cwd}/.mcp.json`);
      mcpServers = mergeMcpServers(mcpServers, workspaceConfig?.mcpServers);
    }

    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    if (tenantId && workspaceId) {
      mcpServers = await applyWorkspaceMcpHelperScripts(mcpServers, {
        tenantId,
        workspaceId,
        runtimeMode,
        runtimeHomePath,
        runtimeOwner,
      });
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

export { applyMcpConfigToSdkOptions, loadMcpConfig };
