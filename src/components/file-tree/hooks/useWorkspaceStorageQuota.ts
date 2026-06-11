import { useCallback, useEffect, useRef, useState } from 'react';

import { useWebSocket } from '../../../contexts/WebSocketContext';
import type { Project } from '../../../types/app';
import { api } from '../../../utils/api';
import type { ProjectFilesChangedEvent } from '../utils/fileTreeEvents';
import { subscribeProjectFilesChanged } from '../utils/fileTreeEvents';
import type { WorkspaceStorageQuota } from '../types/types';

type UseWorkspaceStorageQuotaResult = {
  quota: WorkspaceStorageQuota | null;
  loading: boolean;
  refreshQuota: () => void;
};

export function useWorkspaceStorageQuota(selectedProject: Project | null): UseWorkspaceStorageQuotaResult {
  const [quota, setQuota] = useState<WorkspaceStorageQuota | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const { latestMessage } = useWebSocket();

  const refreshQuota = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    const projectName = selectedProject?.name;

    if (!projectName) {
      setQuota(null);
      setLoading(false);
      return;
    }

    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    let isActive = true;

    const fetchQuota = async () => {
      if (isActive) {
        setLoading(true);
      }

      try {
        const response = await api.getFileQuota(
          projectName,
          selectedProject?.workspaceId,
          { signal: abortControllerRef.current!.signal },
        );

        if (!response.ok) {
          if (isActive) {
            setQuota(null);
          }
          return;
        }

        const data = (await response.json()) as WorkspaceStorageQuota;
        if (isActive) {
          setQuota(data);
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }
        console.error('Error fetching workspace storage quota:', error);
        if (isActive) {
          setQuota(null);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void fetchQuota();

    return () => {
      isActive = false;
      abortControllerRef.current?.abort();
    };
  }, [selectedProject?.name, selectedProject?.workspaceId, refreshKey]);

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
        refreshQuota();
      }
    });
  }, [refreshQuota, selectedProject?.name, selectedProject?.workspaceId]);

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
    refreshQuota();
  }, [latestMessage, refreshQuota, selectedProject?.name, selectedProject?.workspaceId]);

  return {
    quota,
    loading,
    refreshQuota,
  };
}
