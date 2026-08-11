import {
  GitBranch,
  Folder,
  ListChecks,
  MessageSquare,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import type { AppTab } from '../../../../types/app';

export type BuiltInMainContentTab = {
  kind: 'builtin';
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

const BASE_TABS: BuiltInMainContentTab[] = [
  { kind: 'builtin', id: 'chat', labelKey: 'tabs.chat', icon: MessageSquare },
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder },
  { kind: 'builtin', id: 'codehub', labelKey: 'tabs.codehub', icon: GitBranch },
  { kind: 'builtin', id: 'mcp-tools', labelKey: 'tabs.mcpTools', icon: Wrench },
  { kind: 'builtin', id: 'sql-check', labelKey: 'tabs.sqlCheck', icon: ListChecks },
];

export function buildMainContentTabs(): BuiltInMainContentTab[] {
  return BASE_TABS;
}
