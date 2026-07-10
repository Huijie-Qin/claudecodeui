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
};

export type CreateWorkspaceResponse = {
  success?: boolean;
  project?: Record<string, unknown>;
  error?: string;
  details?: string;
};

export type WizardFormState = {
  workspaceType: WorkspaceType;
  workspacePath: string;
};
