const WORKSPACE_INTERNAL_CONFIG_ENTRIES = new Set(['.cloudcli', '.mcp.json']);

export function shouldHideWorkspaceInternalEntry({
  name,
  currentDepth,
  showInternalConfigFiles,
}) {
  return currentDepth === 0
    && showInternalConfigFiles !== true
    && WORKSPACE_INTERNAL_CONFIG_ENTRIES.has(String(name || ''));
}

export function parseShowInternalConfigFiles(value) {
  return value === 'true';
}
