import { api } from '../../../utils/api';
import type {
  BrowseFilesystemResponse,
  CreateFolderResponse,
  CreateWorkspacePayload,
  CreateWorkspaceResponse,
  FolderSuggestion,
} from '../types';

const parseJson = async <T>(response: Response): Promise<T> => {
  const data = (await response.json()) as T;
  return data;
};

export const browseFilesystemFolders = async (pathToBrowse: string) => {
  const endpoint = `/browse-filesystem?path=${encodeURIComponent(pathToBrowse)}`;
  const response = await api.get(endpoint);
  const data = await parseJson<BrowseFilesystemResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to browse filesystem');
  }

  return {
    path: data.path || pathToBrowse,
    suggestions: (data.suggestions || []) as FolderSuggestion[],
  };
};

export const createFolderInFilesystem = async (folderPath: string) => {
  const response = await api.createFolder(folderPath);
  const data = await parseJson<CreateFolderResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to create folder');
  }

  return data.path || folderPath;
};

export const createWorkspaceRequest = async (payload: CreateWorkspacePayload) => {
  const response = await api.createWorkspace(payload);
  const data = await parseJson<CreateWorkspaceResponse>(response);

  if (!response.ok) {
    throw new Error(data.details || data.error || 'Failed to create workspace');
  }

  return data.project
    ? { ...data.project, agentTemplate: data.agentTemplate || null }
    : data.project;
};

export const listAgentTemplatesRequest = async () => {
  const response = await api.agentTemplates();
  const data = await parseJson<{ templates?: import('../types').AgentTemplateOption[]; error?: string }>(response);
  if (!response.ok) {
    throw new Error(data.error || 'Failed to load Agent templates');
  }
  return data.templates || [];
};
