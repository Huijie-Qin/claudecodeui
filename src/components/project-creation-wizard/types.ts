export type WizardStep = 1 | 2 | 3;

export type WorkspaceType = 'existing' | 'new';

export type FolderSuggestion = {
  name: string;
  path: string;
  type?: string;
};

export type BrowseFilesystemResponse = {
  path?: string;
  suggestions?: FolderSuggestion[];
  error?: string;
};

export type CreateFolderResponse = {
  success?: boolean;
  path?: string;
  error?: string;
  details?: string;
};

export type CreateWorkspacePayload = {
  workspaceType: WorkspaceType;
  path: string;
  templateId?: number | null;
};

export type CreateWorkspaceResponse = {
  success?: boolean;
  project?: Record<string, unknown>;
  agentTemplate?: {
    id: number;
    name: string;
    guideText: string;
  } | null;
  error?: string;
  details?: string;
};

export type WizardFormState = {
  workspaceType: WorkspaceType;
  workspacePath: string;
  templateId: number | null;
};

export type AgentTemplateCapability = {
  id: number | string;
  name: string;
};

export type AgentTemplateHookCapability = AgentTemplateCapability & {
  eventName?: string;
};

export type AgentTemplateOption = {
  id: number;
  name: string;
  category?: string;
  summary: string;
  guideText?: string;
  skills: AgentTemplateCapability[];
  mcps: AgentTemplateCapability[];
  hooks?: AgentTemplateHookCapability[];
  updatedAt?: string;
};
