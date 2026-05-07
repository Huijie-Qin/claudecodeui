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
