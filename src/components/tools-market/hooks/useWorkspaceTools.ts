import { useCallback, useEffect, useState } from 'react';

import { api } from '../../../utils/api';
import type { WorkspaceMcpProbe, WorkspaceTool } from '../utils/toolFormatting';

export type WorkspaceToolsSummary = {
  total: number;
  builtin: number;
  httpMcp: number;
  healthy: number;
  needsValue: number;
  unsupported: number;
  blocked: number;
};

export type WorkspaceToolsResponse = {
  workspaceId: number;
  accessRole: 'owner' | 'edit' | 'view';
  canManage: boolean;
  tools: WorkspaceTool[];
  mcpServers: WorkspaceTool[];
  summary: WorkspaceToolsSummary;
};

export type WorkspaceMcpServerInput = {
  name: string;
  type: 'http';
  url: string;
  headers: Record<string, string>;
};

export type WorkspaceMcpImportPreview = {
  entries: Array<{
    name: string;
    status: 'ready' | 'needs_value' | 'unsupported' | 'invalid';
    transport?: string;
    url?: string;
    headers?: Record<string, string>;
    missingValues?: string[];
    reason?: string;
    conflict?: boolean;
  }>;
  summary: {
    total: number;
    ready: number;
    needsValue: number;
    unsupported: number;
    invalid: number;
    conflicts: number;
  };
};

type UseWorkspaceToolsState = {
  data: WorkspaceToolsResponse | null;
  error: string | null;
  isLoading: boolean;
};

const EMPTY_STATE: UseWorkspaceToolsState = {
  data: null,
  error: null,
  isLoading: false,
};

async function toJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

function getApiErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }
  const record = payload as Record<string, unknown>;
  return typeof record.error === 'string' && record.error.trim() ? record.error : fallback;
}

export function useWorkspaceTools(workspaceId?: number) {
  const [state, setState] = useState<UseWorkspaceToolsState>(EMPTY_STATE);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setState({
        data: null,
        error: 'Workspace tool inventory is unavailable.',
        isLoading: false,
      });
      return;
    }

    setState((current) => ({ ...current, error: null, isLoading: true }));
    try {
      const response = await api.workspaceTools.list(workspaceId);
      const payload = await toJson<WorkspaceToolsResponse | { error?: string }>(response);

      if (!response.ok) {
        throw new Error(getApiErrorMessage(payload, 'Failed to load workspace tools.'));
      }

      setState({
        data: payload as WorkspaceToolsResponse,
        error: null,
        isLoading: false,
      });
    } catch (error) {
      setState({
        data: null,
        error: error instanceof Error ? error.message : 'Failed to load workspace tools.',
        isLoading: false,
      });
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const probeMcp = useCallback(async (payload: WorkspaceMcpServerInput): Promise<WorkspaceMcpProbe> => {
    if (!workspaceId) {
      throw new Error('Workspace tool inventory is unavailable.');
    }
    const response = await api.workspaceTools.probeMcp(workspaceId, payload);
    const data = await toJson<{ probe?: WorkspaceMcpProbe; error?: string }>(response);
    if (!response.ok || !data.probe) {
      throw new Error(getApiErrorMessage(data, 'Failed to probe MCP server.'));
    }
    await load();
    return data.probe;
  }, [load, workspaceId]);

  const saveMcp = useCallback(async (payload: WorkspaceMcpServerInput): Promise<WorkspaceToolsResponse> => {
    if (!workspaceId) {
      throw new Error('Workspace tool inventory is unavailable.');
    }
    const response = await api.workspaceTools.upsertMcp(workspaceId, payload);
    const data = await toJson<WorkspaceToolsResponse & { error?: string }>(response);
    if (!response.ok) {
      throw new Error(getApiErrorMessage(data, 'Failed to save MCP server.'));
    }
    setState({
      data,
      error: null,
      isLoading: false,
    });
    return data;
  }, [workspaceId]);

  const removeMcp = useCallback(async (name: string): Promise<WorkspaceToolsResponse> => {
    if (!workspaceId) {
      throw new Error('Workspace tool inventory is unavailable.');
    }
    const response = await api.workspaceTools.removeMcp(workspaceId, name);
    const data = await toJson<WorkspaceToolsResponse & { error?: string }>(response);
    if (!response.ok) {
      throw new Error(getApiErrorMessage(data, 'Failed to delete MCP server.'));
    }
    setState({
      data,
      error: null,
      isLoading: false,
    });
    return data;
  }, [workspaceId]);

  const previewImport = useCallback(async (json: string): Promise<WorkspaceMcpImportPreview> => {
    if (!workspaceId) {
      throw new Error('Workspace tool inventory is unavailable.');
    }
    const response = await api.workspaceTools.previewMcpImport(workspaceId, json);
    const data = await toJson<{ preview?: WorkspaceMcpImportPreview; error?: string }>(response);
    if (!response.ok || !data.preview) {
      throw new Error(getApiErrorMessage(data, 'Failed to preview MCP import.'));
    }
    return data.preview;
  }, [workspaceId]);

  return {
    ...state,
    reload: load,
    probeMcp,
    saveMcp,
    removeMcp,
    previewImport,
  };
}
