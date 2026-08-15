import { multitenancyDb } from '../database/multitenancy-db.js';

function getToolNames(tools) {
  return Array.from(new Set((Array.isArray(tools) ? tools : [])
    .map((tool) => (typeof tool?.name === 'string' ? tool.name.trim() : ''))
    .filter(Boolean)));
}

export function resolveUserWorkspaceMcpToolAccess({
  tenantId,
  workspaceId,
  userId,
  multitenancy = multitenancyDb,
} = {}) {
  const ids = [tenantId, workspaceId, userId].map(Number);
  if (ids.some((value) => !Number.isInteger(value) || value <= 0)) {
    return {
      configured: false,
      disallowedTools: [],
      isAllowed: () => true,
    };
  }

  const preferences = typeof multitenancy.mcpToolPreferences?.listForUser === 'function'
    ? multitenancy.mcpToolPreferences.listForUser({
        tenantId: ids[0],
        workspaceId: ids[1],
        userId: ids[2],
      })
    : [];
  const allowedByServer = new Map();
  const disallowedTools = [];

  for (const preference of preferences) {
    const serverName = typeof preference?.server_name === 'string'
      ? preference.server_name.trim()
      : '';
    if (!serverName) continue;

    const allowedToolNames = new Set(
      (Array.isArray(preference.allowedToolNames) ? preference.allowedToolNames : [])
        .filter((toolName) => typeof toolName === 'string' && toolName.trim())
        .map((toolName) => toolName.trim()),
    );
    allowedByServer.set(serverName, allowedToolNames);

    const knownToolNames = getToolNames([
      ...(Array.isArray(preference.presetTools) ? preference.presetTools : []),
      ...(Array.isArray(preference.installedTools) ? preference.installedTools : []),
    ]);
    for (const toolName of knownToolNames) {
      if (!allowedToolNames.has(toolName)) {
        disallowedTools.push(`mcp__${serverName}__${toolName}`);
      }
    }
  }

  return {
    configured: allowedByServer.size > 0,
    disallowedTools: Array.from(new Set(disallowedTools)),
    isAllowed: (fullToolName) => {
      if (typeof fullToolName !== 'string' || !fullToolName.startsWith('mcp__')) return true;
      const matchingServer = Array.from(allowedByServer.keys())
        .sort((left, right) => right.length - left.length)
        .find((serverName) => fullToolName.startsWith(`mcp__${serverName}__`));
      if (!matchingServer) return true;
      const toolName = fullToolName.slice(`mcp__${matchingServer}__`.length);
      return allowedByServer.get(matchingServer).has(toolName);
    },
  };
}
