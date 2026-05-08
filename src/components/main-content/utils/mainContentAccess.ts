import type { AppTab, WorkspaceAccessRole } from '../../../types/app';

const SUPPORTED_WORKSPACE_TABS = new Set(['chat', 'files', 'mcp-tools']);
const VIEW_ONLY_DISABLED_TABS: AppTab[] = ['chat'];

export function getWorkspaceDisabledTabs(accessRole?: WorkspaceAccessRole): ReadonlySet<AppTab> {
  if (accessRole !== 'view') {
    return new Set();
  }

  return new Set(VIEW_ONLY_DISABLED_TABS);
}

export function resolveSupportedWorkspaceTab(activeTab: string): AppTab {
  return SUPPORTED_WORKSPACE_TABS.has(activeTab) ? activeTab as AppTab : 'chat';
}

export function resolveAllowedWorkspaceTab(activeTab: AppTab | string, disabledTabs: ReadonlySet<AppTab>): AppTab {
  const supportedTab = resolveSupportedWorkspaceTab(activeTab);
  return disabledTabs.has(supportedTab) ? 'files' : supportedTab;
}
