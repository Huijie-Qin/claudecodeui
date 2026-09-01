import {
  GitBranch,
  Folder,
  ListChecks,
  MessageSquare,
  Wrench,
  Network,
  Sparkles,
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
  { kind: 'builtin', id: 'skills', labelKey: 'tabs.skills', icon: Sparkles },
  { kind: 'builtin', id: 'mcp-tools', labelKey: 'tabs.mcpTools', icon: Wrench },
  { kind: 'builtin', id: 'sql-check', labelKey: 'tabs.sqlCheck', icon: ListChecks },
];

const AGENT_GRAPH_TAB: BuiltInMainContentTab = {
  kind: 'builtin',
  id: 'agent-graph',
  labelKey: 'tabs.agentGraph',
  icon: Network,
};

export function buildMainContentTabs(agentGraphEnabled = false): BuiltInMainContentTab[] {
  return agentGraphEnabled ? [...BASE_TABS, AGENT_GRAPH_TAB] : BASE_TABS;
}
