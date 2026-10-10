import { useCallback, useEffect, useState } from 'react';

import { api } from '../../../utils/api';
import type { Project } from '../../../types/app';
import type { FileTreeNode } from '../types/types';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { subscribeProjectFilesChanged, type ProjectFilesChangedEvent } from '../utils/fileTreeEvents';
import { useUiPreferences } from '../../../hooks/useUiPreferences';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  initialLoading: boolean;
  error: string | null;
  refreshFiles: () => void;
};

type FileTreeDataState = {
  projectKey: string;
  files: FileTreeNode[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
};

export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  const projectName = selectedProject?.name;
  const workspaceId = selectedProject?.workspaceId;
  const projectKey = JSON.stringify([selectedProject?.tenantId, workspaceId, projectName]);
  const [state, setState] = useState<FileTreeDataState>({
    projectKey, files: [], loaded: false, loading: Boolean(projectName), error: null,
  });
  const [refreshKey, setRefreshKey] = useState(0);
  const { latestMessage } = useWebSocket();
  const { preferences } = useUiPreferences();

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    if (!projectName) {
      setState({ projectKey, files: [], loaded: false, loading: false, error: null });
      return;
    }

    const controller = new AbortController();

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;

    const fetchFiles = async () => {
      // Refresh in place, including a previously loaded empty directory. Only
      // first loads and workspace changes should replace the upload controls.
      setState((current) => current.projectKey === projectKey
        ? { ...current, loading: true, error: null }
        : { projectKey, files: [], loaded: false, loading: true, error: null });
      try {
        const response = await api.getFiles(
          projectName,
          { signal: controller.signal },
          workspaceId,
          preferences.showInternalConfigFiles,
        );

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (isActive) {
            setState((current) => ({ ...current, error: `Failed to load files (${response.status})` }));
          }
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        if (isActive) {
          setState((current) => ({ ...current, files: data, loaded: true, error: null }));
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }

        console.error('Error fetching files:', error);
        if (isActive) {
          setState((current) => ({ ...current, error: error instanceof Error ? error.message : 'Failed to load files' }));
        }
      } finally {
        if (isActive) {
          setState((current) => ({ ...current, loading: false }));
        }
      }
    };

    void fetchFiles();

    return () => {
      isActive = false;
      controller.abort();
    };
  }, [
    preferences.showInternalConfigFiles,
    projectName,
    workspaceId,
    projectKey,
    refreshKey,
  ]);

  useEffect(() => {
    const matchesSelectedProject = (event: ProjectFilesChangedEvent) => {
      if (!selectedProject?.name) return false;
      if (event.projectName && event.projectName !== selectedProject.name) return false;
      if (
        event.workspaceId != null &&
        selectedProject.workspaceId != null &&
        String(event.workspaceId) !== String(selectedProject.workspaceId)
      ) {
        return false;
      }
      return true;
    };

    return subscribeProjectFilesChanged((event) => {
      if (matchesSelectedProject(event)) {
        refreshFiles();
      }
    });
  }, [refreshFiles, selectedProject?.name, selectedProject?.workspaceId]);

  useEffect(() => {
    const message = latestMessage as ProjectFilesChangedEvent & { type?: string } | null;
    if (!message || message.type !== 'files_changed' || !selectedProject?.name) {
      return;
    }
    if (message.projectName && message.projectName !== selectedProject.name) {
      return;
    }
    if (
      message.workspaceId != null &&
      selectedProject.workspaceId != null &&
      String(message.workspaceId) !== String(selectedProject.workspaceId)
    ) {
      return;
    }
    refreshFiles();
  }, [latestMessage, refreshFiles, selectedProject?.name, selectedProject?.workspaceId]);

  // Do not expose the previous workspace while the new effect is starting.
  const current = state.projectKey === projectKey ? state : null;
  const loading = current?.loading ?? Boolean(projectName);
  return {
    files: current?.files ?? [],
    loading,
    initialLoading: loading && !current?.loaded,
    error: current?.error ?? null,
    refreshFiles,
  };
}
