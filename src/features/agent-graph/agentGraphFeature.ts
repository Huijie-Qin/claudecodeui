import { useEffect, useSyncExternalStore } from 'react';

import { api } from '../../utils/api';

type AgentGraphFeatureSnapshot = {
  enabled: boolean;
  loaded: boolean;
};

let snapshot: AgentGraphFeatureSnapshot = { enabled: false, loaded: false };
const serverSnapshot: AgentGraphFeatureSnapshot = { enabled: false, loaded: false };
let loadPromise: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AgentGraphFeatureSnapshot {
  return snapshot;
}

function getServerSnapshot(): AgentGraphFeatureSnapshot {
  return serverSnapshot;
}

export function publishAgentGraphFeatureEnabled(enabled: boolean): void {
  const next = { enabled, loaded: true };
  if (snapshot.enabled === next.enabled && snapshot.loaded === next.loaded) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

export function readAgentGraphFeatureEnabled(): boolean {
  return snapshot.enabled;
}

export async function refreshAgentGraphFeatureEnabled(force = false): Promise<boolean> {
  if (snapshot.loaded && !force) return snapshot.enabled;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const response = await api.featureFlags();
      if (!response.ok) throw new Error('Failed to load feature flags');
      const payload = await response.json() as { features?: { agentGraph?: boolean } };
      const enabled = payload.features?.agentGraph === true;
      publishAgentGraphFeatureEnabled(enabled);
      return enabled;
    } catch {
      publishAgentGraphFeatureEnabled(false);
      return false;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

export function useAgentGraphFeatureStatus(): AgentGraphFeatureSnapshot {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    void refreshAgentGraphFeatureEnabled();
  }, []);
  return value;
}

export function useAgentGraphFeatureEnabled(): boolean {
  return useAgentGraphFeatureStatus().enabled;
}
