import { useCallback, useEffect, useState } from 'react';

import { api } from '../../../utils/api';
import type { WorkspaceSkill } from '../utils/skillFormatting';

export type WorkspaceSkillsSummary = {
  total: number;
  managed: number;
  unmanaged: number;
  system: number;
  enabled: number;
  disabled: number;
  invalid: number;
  market?: number;
  local?: number;
};

export type WorkspaceSkillsResponse = {
  workspaceId: number;
  accessRole: 'owner' | 'edit' | 'view';
  canManage: boolean;
  skills: WorkspaceSkill[];
  summary: WorkspaceSkillsSummary;
};

type UseWorkspaceSkillsState = {
  data: WorkspaceSkillsResponse | null;
  error: string | null;
  isLoading: boolean;
};

const EMPTY_STATE: UseWorkspaceSkillsState = {
  data: null,
  error: null,
  isLoading: false,
};

export function useWorkspaceSkills(workspaceId?: number) {
  const [state, setState] = useState<UseWorkspaceSkillsState>(EMPTY_STATE);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setState({
        data: null,
        error: 'Workspace inventory is unavailable.',
        isLoading: false,
      });
      return;
    }

    setState((current) => ({ ...current, error: null, isLoading: true }));
    try {
      const response = await api.workspaceSkills.list(workspaceId);
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to load workspace skills.');
      }

      setState({
        data: payload,
        error: null,
        isLoading: false,
      });
      void enrichMarketState(payload, workspaceId).then((data) => {
        setState((current) => current.data?.workspaceId === workspaceId
          ? { data, error: null, isLoading: false }
          : current);
      });
    } catch (error) {
      setState({
        data: null,
        error: error instanceof Error ? error.message : 'Failed to load workspace skills.',
        isLoading: false,
      });
    }
  }, [workspaceId]);

  useEffect(() => {
    let active = true;

    async function loadActiveWorkspaceSkills() {
      if (!workspaceId) {
        setState({
          data: null,
          error: 'Workspace inventory is unavailable.',
          isLoading: false,
        });
        return;
      }

      setState((current) => ({ ...current, error: null, isLoading: true }));
      try {
        const response = await api.workspaceSkills.list(workspaceId);
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload?.error || 'Failed to load workspace skills.');
        }

        if (active) {
          setState({
            data: payload,
            error: null,
            isLoading: false,
          });
          void enrichMarketState(payload, workspaceId).then((data) => {
            if (!active) return;
            setState({
              data,
              error: null,
              isLoading: false,
            });
          });
        }
      } catch (error) {
        if (active) {
          setState({
            data: null,
            error: error instanceof Error ? error.message : 'Failed to load workspace skills.',
            isLoading: false,
          });
        }
      }
    }

    loadActiveWorkspaceSkills();

    return () => {
      active = false;
    };
  }, [workspaceId]);

  return {
    ...state,
    reload: load,
  };
}

async function enrichMarketState(
  payload: WorkspaceSkillsResponse,
  workspaceId: number,
): Promise<WorkspaceSkillsResponse> {
  const marketSkills = (payload.skills ?? []).filter((skill) => skill.origin === 'market');
  if (marketSkills.length === 0) return payload;

  const remoteStates = await Promise.all(marketSkills.map(async (skill) => {
    try {
      const response = await api.skillMarket.detail(workspaceId, skill.name);
      if (!response.ok) return null;
      const detailPayload = await response.json();
      return { name: skill.name, detail: detailPayload.skill ?? null };
    } catch {
      return null;
    }
  }));
  const byName = new Map(remoteStates
    .filter((entry): entry is { name: string; detail: Record<string, unknown> } => Boolean(entry?.detail))
    .map((entry) => [entry.name, entry.detail]));

  return {
    ...payload,
    skills: payload.skills.map((skill) => {
      const detail = byName.get(skill.name);
      if (!detail) return skill;
      return {
        ...skill,
        marketVersion: typeof detail.version === 'number' ? detail.version : undefined,
        localVersion: typeof detail.importedVersion === 'number' ? detail.importedVersion : skill.localVersion,
        updateAvailable: detail.updateAvailable === true,
        remoteDeleted: detail.remoteDeleted === true,
        createUserId: typeof detail.createUserId === 'string' ? detail.createUserId : skill.createUserId,
      };
    }),
  };
}
