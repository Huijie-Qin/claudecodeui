import { useCallback, useEffect, useState } from 'react';

import { api } from '../../utils/api';

import type {
  AgentGraph,
  AgentGraphExecutorConfig,
  AgentGraphsResponse,
  TopSkillJob,
  TopSkillJobInput,
  TopSkillOperation,
} from './types';

type AgentGraphState = {
  graphs: AgentGraph[];
  executorConfig: AgentGraphExecutorConfig | null;
  canManage: boolean;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
};

const INITIAL_STATE: AgentGraphState = {
  graphs: [],
  executorConfig: null,
  canManage: false,
  isLoading: true,
  isSaving: false,
  error: null,
};

async function readPayload<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload && typeof payload.error === 'string' ? payload.error : fallback;
    throw new Error(error);
  }
  return payload as T;
}

export function useAgentGraphs(workspaceId?: number) {
  const [state, setState] = useState<AgentGraphState>(INITIAL_STATE);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setState({ ...INITIAL_STATE, isLoading: false, error: 'Workspace is unavailable.' });
      return;
    }
    setState((current) => ({ ...current, isLoading: true, error: null }));
    try {
      const response = await api.agentGraphs.list(workspaceId);
      const payload = await readPayload<AgentGraphsResponse>(response, 'Failed to load Agent Graphs.');
      setState({
        graphs: payload.graphs,
        executorConfig: payload.executorConfig,
        canManage: payload.canManage,
        isLoading: false,
        isSaving: false,
        error: null,
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load Agent Graphs.',
      }));
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const createGraph = useCallback(async (graph: AgentGraph) => {
    if (!workspaceId) throw new Error('Workspace is unavailable.');
    setState((current) => ({ ...current, isSaving: true, error: null }));
    try {
      const response = await api.agentGraphs.create(workspaceId, graph);
      const payload = await readPayload<{ graph: AgentGraph }>(response, 'Failed to create Agent Graph.');
      setState((current) => ({
        ...current,
        graphs: [...current.graphs, payload.graph],
        isSaving: false,
      }));
      return payload.graph;
    } catch (error) {
      setState((current) => ({
        ...current,
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to create Agent Graph.',
      }));
      throw error;
    }
  }, [workspaceId]);

  const saveGraph = useCallback(async (graph: AgentGraph) => {
    if (!workspaceId) throw new Error('Workspace is unavailable.');
    setState((current) => ({ ...current, isSaving: true, error: null }));
    try {
      const response = await api.agentGraphs.update(workspaceId, graph.id, graph);
      const payload = await readPayload<{ graph: AgentGraph }>(response, 'Failed to save Agent Graph.');
      setState((current) => ({
        ...current,
        graphs: current.graphs.map((entry) => entry.id === payload.graph.id ? payload.graph : entry),
        isSaving: false,
      }));
      return payload.graph;
    } catch (error) {
      setState((current) => ({
        ...current,
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to save Agent Graph.',
      }));
      throw error;
    }
  }, [workspaceId]);

  const deleteGraph = useCallback(async (graphId: string) => {
    if (!workspaceId) throw new Error('Workspace is unavailable.');
    setState((current) => ({ ...current, isSaving: true, error: null }));
    try {
      const response = await api.agentGraphs.remove(workspaceId, graphId);
      await readPayload(response, 'Failed to delete Agent Graph.');
      setState((current) => ({
        ...current,
        graphs: current.graphs.filter((graph) => graph.id !== graphId),
        isSaving: false,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to delete Agent Graph.',
      }));
      throw error;
    }
  }, [workspaceId]);

  const startTopSkillJob = useCallback(async (operation: TopSkillOperation, input: TopSkillJobInput) => {
    if (!workspaceId) throw new Error('Workspace is unavailable.');
    const response = await api.agentGraphs.startTopSkillJob(workspaceId, { operation, input });
    const payload = await readPayload<{ job: TopSkillJob }>(response, 'Could not start the Top Skill job.');
    return payload.job;
  }, [workspaceId]);

  const getTopSkillJob = useCallback(async (jobId: string) => {
    if (!workspaceId) throw new Error('Workspace is unavailable.');
    const response = await api.agentGraphs.getTopSkillJob(workspaceId, jobId);
    const payload = await readPayload<{ job: TopSkillJob }>(response, 'Could not read the Top Skill job.');
    return payload.job;
  }, [workspaceId]);

  return {
    ...state,
    reload: load,
    createGraph,
    saveGraph,
    deleteGraph,
    startTopSkillJob,
    getTopSkillJob,
  };
}
