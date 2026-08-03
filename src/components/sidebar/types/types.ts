import type { LoadingProgress, Project, ProjectScheduledTask, ProjectSession, LLMProvider, Tenant } from '../../../types/app';

export type ProjectSortOrder = 'name' | 'date';

export type SessionWithProvider = ProjectSession & {
  __provider: LLMProvider;
};

export type AdditionalSessionsByProject = Record<string, ProjectSession[]>;
export type LoadingSessionsByProject = Record<string, boolean>;

export type DeleteProjectConfirmation = {
  project: Project;
  sessionCount: number;
};

export type SessionDeleteConfirmation = {
  projectName: string;
  sessionId: string;
  sessionTitle: string;
  provider: LLMProvider;
  workspaceId?: number;
};

export type SidebarProps = {
  projects: Project[];
  processingSessions: ReadonlyMap<string, number>;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  onProjectSelect: (project: Project) => void;
  onShareProject?: (project: Project) => void;
  onSessionSelect: (session: ProjectSession) => void;
  onScheduledTaskOpen?: (project: Project, task: ProjectScheduledTask) => void;
  onScheduledTasksListOpen?: (project: Project) => void;
  onNewSession: (project: Project) => void;
  onSessionDelete?: (sessionId: string) => void;
  onProjectDelete?: (project: Project) => void;
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  onRefresh: () => Promise<void> | void;
  onShowSettings: () => void;
  showSettings: boolean;
  settingsInitialTab: string;
  onCloseSettings: () => void;
  isMobile: boolean;
  showAdminEntry?: boolean;
  onShowAdminPanel?: () => void;
  tenants?: Tenant[];
  currentTenant?: Tenant | null;
  onTenantSwitch?: (tenant: Tenant) => void;
};

export type SessionViewModel = {
  isCursorSession: boolean;
  isCodexSession: boolean;
  isGeminiSession: boolean;
  sessionName: string;
  sessionTime: string;
  messageCount: number;
};

export type MCPServerStatus = {
  hasMCPServer?: boolean;
  isConfigured?: boolean;
} | null;

export type SettingsProject = Pick<Project, 'name' | 'displayName' | 'fullPath' | 'path'>;
