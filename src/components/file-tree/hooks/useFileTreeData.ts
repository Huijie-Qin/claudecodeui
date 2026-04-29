import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../utils/api';
import type { Project } from '../../../types/app';
import type { FileTreeNode } from '../types/types';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { subscribeProjectFilesChanged, type ProjectFilesChangedEvent } from '../utils/fileTreeEvents';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  refreshFiles: () => void;
};

export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const { latestMessage } = useWebSocket();

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    const projectName = selectedProject?.name;

    if (!projectName) {
      setFiles([]);
      setLoading(false);
      return;
    }

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;

    const fetchFiles = async () => {
      if (isActive) {
        setLoading(true);
      }
      try {
        const response = await api.getFiles(
          projectName,
          { signal: abortControllerRef.current!.signal },
          selectedProject?.workspaceId,
        );

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (isActive) {
            setFiles([]);
          }
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        if (isActive) {
          setFiles(data);
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }

        console.error('Error fetching files:', error);
        if (isActive) {
          setFiles([]);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void fetchFiles();

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

  return {
    files,
    loading,
    refreshFiles,
  };
}
