import type { AppTab, WorkspaceAccessRole } from '../../../types/app';

const BASE_SUPPORTED_WORKSPACE_TABS = new Set(['chat', 'files', 'codehub', 'mcp-tools', 'sql-check']);
const VIEW_ONLY_DISABLED_TABS: AppTab[] = ['chat', 'codehub'];

export function getWorkspaceDisabledTabs(accessRole?: WorkspaceAccessRole): ReadonlySet<AppTab> {
  if (accessRole !== 'view') {
    return new Set();
  }

  return new Set(VIEW_ONLY_DISABLED_TABS);
}

export function resolveSupportedWorkspaceTab(activeTab: string, agentGraphEnabled = false): AppTab {
  if (activeTab === 'agent-graph') {
    return agentGraphEnabled ? 'agent-graph' : 'chat';
  }
  return BASE_SUPPORTED_WORKSPACE_TABS.has(activeTab) ? activeTab as AppTab : 'chat';
}

export function resolveAllowedWorkspaceTab(
  activeTab: AppTab | string,
  disabledTabs: ReadonlySet<AppTab>,
  agentGraphEnabled = false,
): AppTab {
  const supportedTab = resolveSupportedWorkspaceTab(activeTab, agentGraphEnabled);
  return disabledTabs.has(supportedTab) ? 'files' : supportedTab;
}
