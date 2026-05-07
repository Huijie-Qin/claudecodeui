import {
  ClipboardCheck,
  Folder,
  GitBranch,
  MessageSquare,
  Sparkles,
  Terminal,
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
  { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder },
  { kind: 'builtin', id: 'skills', labelKey: 'tabs.skills', icon: Sparkles },
  { kind: 'builtin', id: 'tools', labelKey: 'tabs.tools', icon: Wrench },
  { kind: 'builtin', id: 'git', labelKey: 'tabs.git', icon: GitBranch },
];

const TASKS_TAB: BuiltInMainContentTab = {
  kind: 'builtin',
  id: 'tasks',
  labelKey: 'tabs.tasks',
  icon: ClipboardCheck,
};

export function buildMainContentTabs(shouldShowTasksTab: boolean): BuiltInMainContentTab[] {
  return shouldShowTasksTab ? [...BASE_TABS, TASKS_TAB] : BASE_TABS;
}
