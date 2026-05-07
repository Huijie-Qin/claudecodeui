export type WorkspaceToolType = 'builtin' | 'mcp';
export type WorkspaceToolStatus =
  | 'available'
  | 'healthy'
  | 'needs_value'
  | 'probe_failed'
  | 'read_only'
  | 'unverified'
  | 'unsupported';

export type WorkspaceMcpProbeTool = {
  name: string;
  description?: string;
};

export type WorkspaceMcpProbe = {
  status: 'healthy' | 'probe_failed';
  phase?: string;
  error?: string;
  checkedAt?: string;
  latencyMs?: number;
  toolCount?: number;
  tools?: WorkspaceMcpProbeTool[];
};

export type WorkspaceTool = {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  type: WorkspaceToolType;
  category?: string;
  source?: string;
  transport?: 'http' | 'stdio' | 'sse' | 'unknown';
  status: WorkspaceToolStatus;
  permission?: string;
  manageable?: boolean;
  url?: string;
  headers?: Record<string, string>;
  config?: Record<string, unknown>;
  probe?: WorkspaceMcpProbe | null;
  tools?: WorkspaceMcpProbeTool[];
  toolCount?: number;
  missingValues?: string[];
};

const TYPE_ORDER: Record<WorkspaceToolType, number> = {
  builtin: 0,
  mcp: 1,
};

const STATUS_ORDER: Record<WorkspaceToolStatus, number> = {
  healthy: 0,
  available: 1,
  read_only: 2,
  unverified: 3,
  needs_value: 4,
  probe_failed: 5,
  unsupported: 6,
};

export function sortWorkspaceTools(tools: WorkspaceTool[]): WorkspaceTool[] {
  return [...tools].sort((left, right) => {
    const typeDiff = TYPE_ORDER[left.type] - TYPE_ORDER[right.type];
    if (typeDiff !== 0) return typeDiff;
    const statusDiff = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
    if (statusDiff !== 0) return statusDiff;
    return left.name.localeCompare(right.name);
  });
}

export function filterWorkspaceTools(tools: WorkspaceTool[], query: string): WorkspaceTool[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return tools;

  return tools.filter((tool) => getToolSearchText(tool).includes(normalizedQuery));
}

export function getToolDisplayName(tool: WorkspaceTool): string {
  return tool.displayName || tool.name;
}

export function getToolStatusLabelKey(tool: WorkspaceTool): string {
  return `toolsMarket.status.${tool.status}`;
}

export function getToolTypeLabelKey(tool: WorkspaceTool): string {
  return `toolsMarket.type.${tool.type}`;
}

export function parseHeaderLines(value: string): Record<string, string> {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((headers, line) => {
      const separatorIndex = line.indexOf('=');
      if (separatorIndex === -1) {
        headers[line] = '';
        return headers;
      }
      const key = line.slice(0, separatorIndex).trim();
      if (!key) {
        return headers;
      }
      headers[key] = line.slice(separatorIndex + 1).trim();
      return headers;
    }, {});
}

export function formatHeaderLines(headers?: Record<string, string>): string {
  return Object.entries(headers ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function getToolSearchText(tool: WorkspaceTool): string {
  return [
    tool.name,
    tool.displayName,
    tool.description,
    tool.type,
    tool.status,
    tool.transport,
    tool.url,
    tool.probe?.phase,
    tool.probe?.error,
    ...(tool.tools ?? []).map((entry) => `${entry.name} ${entry.description ?? ''}`),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
