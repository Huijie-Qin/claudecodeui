import {
  Folder,
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
  { kind: 'builtin', id: 'mcp-tools', labelKey: 'tabs.mcpTools', icon: Wrench },
];

export function buildMainContentTabs(): BuiltInMainContentTab[] {
  return BASE_TABS;
}
