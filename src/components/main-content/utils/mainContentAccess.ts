import type { AppTab, WorkspaceAccessRole } from '../../../types/app';

const VIEW_ONLY_DISABLED_TABS: AppTab[] = ['chat', 'shell', 'git'];

export function getWorkspaceDisabledTabs(accessRole?: WorkspaceAccessRole): ReadonlySet<AppTab> {
  if (accessRole !== 'view') {
    return new Set();
  }

  return new Set(VIEW_ONLY_DISABLED_TABS);
}

export function resolveAllowedWorkspaceTab(activeTab: AppTab, disabledTabs: ReadonlySet<AppTab>): AppTab {
  return disabledTabs.has(activeTab) ? 'files' : activeTab;
}
