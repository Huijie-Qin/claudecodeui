import { useCallback, useEffect, useState } from 'react';

import { api } from '../../utils/api';

import type { AgentGraphRun } from './types';

const ACTIVE_STATUSES = new Set<AgentGraphRun['status']>(['queued', 'running', 'cancelling']);
const POLL_INTERVAL_MS = 1_200;

async function readPayload<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const directError = payload && typeof payload.error === 'string' ? payload.error : null;
    const nestedError = payload?.error && typeof payload.error.message === 'string' ? payload.error.message : null;
    throw new Error(directError || nestedError || fallback);
  }
  return payload as T;
}

export function useGraphExecution(workspaceId?: number, graphId?: string | null) {
  const [run, setRun] = useState<AgentGraphRun | null>(null);
  const [recentRuns, setRecentRuns] = useState<AgentGraphRun[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runId = run?.id;
  const runStatus = run?.status;

  const loadRuns = useCallback(async () => {
    if (!workspaceId || !graphId) {
      setRun(null);
      setRecentRuns([]);
      return;
    }
    setIsLoading(true);
    try {
      const response = await api.agentGraphs.listRuns(workspaceId, graphId, 20);
      const payload = await readPayload<{ runs: AgentGraphRun[] }>(response, 'Could not load Agent Graph runs.');
      setRecentRuns(payload.runs);
      setRun((current) => payload.runs.find((entry) => entry.id === current?.id) || payload.runs[0] || null);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load Agent Graph runs.');
    } finally {
      setIsLoading(false);
    }
  }, [graphId, workspaceId]);

  useEffect(() => {
    setRun(null);
    setRecentRuns([]);
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!workspaceId || !graphId || !runId || !runStatus || !ACTIVE_STATUSES.has(runStatus)) return undefined;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await api.agentGraphs.getRun(workspaceId, graphId, runId);
        const payload = await readPayload<{ run: AgentGraphRun }>(response, 'Could not refresh the Agent Graph run.');
        if (disposed) return;
        setRun(payload.run);
        setRecentRuns((current) => [payload.run, ...current.filter((entry) => entry.id !== payload.run.id)]);
        if (ACTIVE_STATUSES.has(payload.run.status)) {
          timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      } catch (pollError) {
        if (!disposed) setError(pollError instanceof Error ? pollError.message : 'Could not refresh the Agent Graph run.');
      }
    };
    timer = window.setTimeout(() => void poll(), 500);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [graphId, runId, runStatus, workspaceId]);

  const startRun = useCallback(async (input: string, maxIterations = 8) => {
    if (!workspaceId || !graphId) throw new Error('Workspace or Agent Graph is unavailable.');
    setIsStarting(true);
    setError(null);
    try {
      const response = await api.agentGraphs.startRun(workspaceId, graphId, { input, maxIterations });
      const payload = await readPayload<{ run: AgentGraphRun }>(response, 'Could not start the Agent Graph run.');
      setRun(payload.run);
      setRecentRuns((current) => [payload.run, ...current.filter((entry) => entry.id !== payload.run.id)]);
      return payload.run;
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Could not start the Agent Graph run.');
      throw startError;
    } finally {
      setIsStarting(false);
    }
  }, [graphId, workspaceId]);

  const cancelRun = useCallback(async () => {
    if (!workspaceId || !graphId || !run) return;
    try {
      const response = await api.agentGraphs.cancelRun(workspaceId, graphId, run.id);
      const payload = await readPayload<{ run: AgentGraphRun }>(response, 'Could not cancel the Agent Graph run.');
      setRun(payload.run);
      setRecentRuns((current) => [payload.run, ...current.filter((entry) => entry.id !== payload.run.id)]);
      setError(null);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Could not cancel the Agent Graph run.');
      throw cancelError;
    }
  }, [graphId, run, workspaceId]);

  return {
    run,
    recentRuns,
    isLoading,
    isStarting,
    error,
    active: Boolean(run && ACTIVE_STATUSES.has(run.status)),
    startRun,
    cancelRun,
    selectRun: setRun,
    reload: loadRuns,
  };
}
