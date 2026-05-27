import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Project } from '../../../types/app';
import type { CodeEditorDiffInfo, CodeEditorFile } from '../types/types';

type FileOpenSource = 'files' | 'chat';

type UseEditorSidebarOptions = {
  selectedProject: Project | null;
  isMobile: boolean;
  initialWidth?: number;
};

export const useEditorSidebar = ({
  selectedProject,
  isMobile,
  initialWidth = 600,
}: UseEditorSidebarOptions) => {
  const [editingFile, setEditingFile] = useState<CodeEditorFile | null>(null);
  const [editorWidth, setEditorWidth] = useState(initialWidth);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [hasManualWidth, setHasManualWidth] = useState(false);
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);

  const handleFileOpen = useCallback(
    (filePath: string, diffInfo: CodeEditorDiffInfo | null = null, source: FileOpenSource = 'chat') => {
      const workspacePath = (
        selectedProject?.fullPath || selectedProject?.path || ''
      ).replace(/\\/g, '/');
      const workspaceName = workspacePath.split('/').filter(Boolean).pop() || '';

      const normalizedWorkspacePath = workspacePath.replace(/\/+$/g, '');
      const workspaceNamePrefix = workspaceName ? `${workspaceName}` : '';

      const cleanInputPath = String(filePath || '')
        .trim()
        .replace(/^['"`]+|['"`]+$/g, '')
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/');
      const normalizedPathNoTrailingSlash = cleanInputPath.replace(/\/+$/g, '');

      const stripWorkspaceNamePrefix = (candidatePath: string) => {
        if (!workspaceNamePrefix) {
          return null;
        }
        const trimmed = candidatePath.replace(/^\/+/, '');
        if (trimmed === workspaceNamePrefix) {
          return '';
        }
        if (trimmed.startsWith(`${workspaceNamePrefix}/`)) {
          return trimmed.slice(workspaceNamePrefix.length + 1);
        }
        return null;
      };

      const resolvedPath = (() => {
        if (!normalizedPathNoTrailingSlash) {
          return normalizedPathNoTrailingSlash;
        }

        if (
          normalizedWorkspacePath &&
          (normalizedPathNoTrailingSlash === normalizedWorkspacePath ||
            normalizedPathNoTrailingSlash.startsWith(`${normalizedWorkspacePath}/`))
        ) {
          return normalizedPathNoTrailingSlash;
        }

        if (normalizedPathNoTrailingSlash.startsWith('/workspace/')) {
          if (!normalizedWorkspacePath) {
            return normalizedPathNoTrailingSlash;
          }
          return `${normalizedWorkspacePath}/${normalizedPathNoTrailingSlash.slice('/workspace/'.length)}`;
        }

        const workspaceRelative = stripWorkspaceNamePrefix(normalizedPathNoTrailingSlash);
        if (workspaceRelative !== null) {
          if (!normalizedWorkspacePath) {
            return normalizedPathNoTrailingSlash;
          }
          return workspaceRelative
            ? `${normalizedWorkspacePath}/${workspaceRelative}`
            : normalizedWorkspacePath;
        }

        if (!normalizedPathNoTrailingSlash.startsWith('/') && normalizedWorkspacePath) {
          const relativePath = normalizedPathNoTrailingSlash.replace(/^\.\/+/, '');
          return relativePath
            ? `${normalizedWorkspacePath}/${relativePath}`
            : normalizedWorkspacePath;
        }

        return cleanInputPath;
      })();

      const buildWorkspaceDisplayPath = (targetPath: string) => {
        if (!normalizedWorkspacePath) {
          return targetPath;
        }
        if (targetPath === normalizedWorkspacePath) {
          return '/workspace';
        }
        if (targetPath.startsWith(`${normalizedWorkspacePath}/`)) {
          return `/workspace/${targetPath.slice(normalizedWorkspacePath.length + 1)}`;
        }
        return '';
      };

      const workspaceDisplayPath = buildWorkspaceDisplayPath(resolvedPath);
      const displayPath = source === 'files'
        ? workspaceDisplayPath || cleanInputPath || '/'
        : workspaceDisplayPath || resolvedPath;

      const resolvedPathWithoutTrailingSlash = resolvedPath.replace(/\/+$/g, '');
      const fileName = resolvedPathWithoutTrailingSlash.split('/').pop() || resolvedPathWithoutTrailingSlash;

      setEditingFile({
        name: fileName,
        path: resolvedPath,
        displayPath,
        projectName: selectedProject?.name,
        workspaceId: selectedProject?.workspaceId,
        diffInfo,
      });
    },
    [selectedProject?.fullPath, selectedProject?.name, selectedProject?.path, selectedProject?.workspaceId],
  );

  const handleCloseEditor = useCallback(() => {
    setEditingFile(null);
    setEditorExpanded(false);
  }, []);

  const handleToggleEditorExpand = useCallback(() => {
    setEditorExpanded((previous) => !previous);
  }, []);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isMobile) {
        return;
      }

      // After first drag interaction, the editor width is user-controlled.
      setHasManualWidth(true);
      setIsResizing(true);
      event.preventDefault();
    },
    [isMobile],
  );

  useEffect(() => {
    const handleMouseMove = (event: globalThis.MouseEvent) => {
      if (!isResizing) {
        return;
      }

      // Get the main container (parent of EditorSidebar's parent) that contains both left content and editor
      const editorContainer = resizeHandleRef.current?.parentElement;
      const mainContainer = editorContainer?.parentElement;
      if (!mainContainer) {
        return;
      }

      const containerRect = mainContainer.getBoundingClientRect();
      // Calculate new editor width: distance from mouse to right edge of main container
      const newWidth = containerRect.right - event.clientX;

      const minWidth = 300;
      const maxWidth = containerRect.width * 0.8;

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setEditorWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  return {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  };
};
