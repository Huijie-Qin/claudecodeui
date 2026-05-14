import { useCallback, useEffect, useState } from 'react';

import { api } from '../../../utils/api';

export type WorkspaceMcpPreset = {
  id: number;
  name: string;
  displayName: string;
  description: string;
  transport: 'http';
  status: 'available' | 'connected' | 'probe_failed' | 'unverified';
  dockerCompatible: boolean;
  toolCount: number;
  tools?: Array<{ name: string; description?: string }>;
  installed: boolean;
  connectionStatus: 'available' | 'connected' | 'probe_failed' | 'unverified';
  probeStatus?: 'healthy' | 'probe_failed' | null;
  probePhase?: string | null;
  probeError?: string | null;
  probeLatencyMs?: number | null;
  lastProbedAt?: string | null;
  userSetupRequired: false;
  source: 'admin_published';
  containerPath: string;
  lastTestedAt?: string | null;
  installedAt?: string | null;
  appliesOn: 'next_agent_turn';
};

export type WorkspaceMcpToolsResponse = {
  workspaceId: number;
  accessRole: 'owner' | 'edit' | 'view';
  canManage: boolean;
  summary: {
    available: number;
    installed: number;
  };
  presets: WorkspaceMcpPreset[];
};

type UseWorkspaceMcpToolsState = {
  data: WorkspaceMcpToolsResponse | null;
  error: string | null;
  isLoading: boolean;
  installingPresetIds: Set<number>;
  removingPresetIds: Set<number>;
};

const EMPTY_STATE: UseWorkspaceMcpToolsState = {
  data: null,
  error: null,
  isLoading: false,
  installingPresetIds: new Set(),
  removingPresetIds: new Set(),
};

async function toJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

function getApiErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const record = payload as Record<string, unknown>;
  return typeof record.error === 'string' && record.error.trim() ? record.error : fallback;
}

function updateSet(current: Set<number>, id: number, isPresent: boolean) {
  const next = new Set(current);
  if (isPresent) {
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
}

function normalizeWorkspaceMcpToolsPayload(payload: WorkspaceMcpToolsResponse): WorkspaceMcpToolsResponse {
  const presets = payload.presets ?? [];
  return {
    ...payload,
    presets,
    summary: {
      available: presets.filter((preset) => !preset.installed).length,
      installed: presets.filter((preset) => preset.installed).length,
    },
  };
}

export function useWorkspaceMcpTools(workspaceId?: number) {
  const [state, setState] = useState<UseWorkspaceMcpToolsState>(EMPTY_STATE);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setState({
        ...EMPTY_STATE,
        error: 'Workspace MCP Tools are unavailable.',
      });
      return;
    }

    setState((current) => ({ ...current, error: null, isLoading: true }));
    try {
      const response = await api.workspaceMcpTools.list(workspaceId);
      const payload = await toJson<WorkspaceMcpToolsResponse | { error?: string }>(response);
      if (!response.ok) {
        throw new Error(getApiErrorMessage(payload, 'Failed to load MCP Tools.'));
      }
      setState((current) => ({
        ...current,
        data: normalizeWorkspaceMcpToolsPayload(payload as WorkspaceMcpToolsResponse),
        error: null,
        isLoading: false,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        data: null,
        error: error instanceof Error ? error.message : 'Failed to load MCP Tools.',
        isLoading: false,
      }));
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const installPreset = useCallback(async (presetId: number) => {
    if (!workspaceId) {
      throw new Error('Workspace MCP Tools are unavailable.');
    }
    setState((current) => ({
      ...current,
      error: null,
      installingPresetIds: updateSet(current.installingPresetIds, presetId, true),
    }));
    try {
      const response = await api.workspaceMcpTools.install(workspaceId, presetId);
      const payload = await toJson<(WorkspaceMcpToolsResponse & { error?: string })>(response);
      if (!response.ok) {
        throw new Error(getApiErrorMessage(payload, 'Failed to install MCP server.'));
      }
      setState((current) => ({
        ...current,
        data: normalizeWorkspaceMcpToolsPayload(payload),
        error: null,
        installingPresetIds: updateSet(current.installingPresetIds, presetId, false),
      }));
      return payload;
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Failed to install MCP server.',
        installingPresetIds: updateSet(current.installingPresetIds, presetId, false),
      }));
      throw error;
    }
  }, [workspaceId]);

  const removePreset = useCallback(async (presetId: number) => {
    if (!workspaceId) {
      throw new Error('Workspace MCP Tools are unavailable.');
    }
    setState((current) => ({
      ...current,
      error: null,
      removingPresetIds: updateSet(current.removingPresetIds, presetId, true),
    }));
    try {
      const response = await api.workspaceMcpTools.remove(workspaceId, presetId);
      const payload = await toJson<(WorkspaceMcpToolsResponse & { error?: string })>(response);
      if (!response.ok) {
        throw new Error(getApiErrorMessage(payload, 'Failed to remove MCP server.'));
      }
      setState((current) => ({
        ...current,
        data: normalizeWorkspaceMcpToolsPayload(payload),
        error: null,
        removingPresetIds: updateSet(current.removingPresetIds, presetId, false),
      }));
      return payload;
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Failed to remove MCP server.',
        removingPresetIds: updateSet(current.removingPresetIds, presetId, false),
      }));
      throw error;
    }
  }, [workspaceId]);

  return {
    ...state,
    reload: load,
    installPreset,
    removePreset,
  };
}
