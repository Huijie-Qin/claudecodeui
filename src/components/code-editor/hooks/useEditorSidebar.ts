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

      const normalizedPath = filePath
        .trim()
        .replace(/^['"`]+|['"`]+$/g, '')
        .replace(/\\/g, '/');
      const sanitizedNormalizedPath = normalizedPath.replace(/\/+/g, '/');
      const normalizedPathNoTrailingSlash = sanitizedNormalizedPath.replace(/\/+$/, '');
      const normalizedNormalizedPath = normalizedPathNoTrailingSlash.replace(/^\/+/, '');
      const normalizedWorkspacePath = workspacePath.replace(/\/+$/, '');
      const hasWorkspaceNamePrefix =
        Boolean(
          workspaceName &&
            (normalizedNormalizedPath === workspaceName ||
              normalizedNormalizedPath.startsWith(`${workspaceName}/`)),
        );
      const hasWorkspacePathPrefix = Boolean(
        normalizedWorkspacePath &&
          (normalizedPathNoTrailingSlash === normalizedWorkspacePath ||
            normalizedPathNoTrailingSlash.startsWith(`${normalizedWorkspacePath}/`)),
      );
      const normalizedFromContainerPrefix = normalizedPath.replace(
        /^\/workspace\/?/,
        '',
      );

      const resolvedPath =
        normalizedWorkspacePath &&
        normalizedPath.startsWith('/workspace/') &&
        normalizedFromContainerPrefix
          ? hasWorkspaceNamePrefix
            ? `${normalizedWorkspacePath}/${normalizedFromContainerPrefix
                .slice(workspaceName.length)
                .replace(/^\/+/, '')}`
            : `${normalizedWorkspacePath}/${normalizedFromContainerPrefix}`
          : normalizedPath;

      const workspacePrefix = workspaceName ? `/${workspaceName}` : '';
      const relativePathFromWorkspace = hasWorkspacePathPrefix
        ? normalizedPathNoTrailingSlash.slice(normalizedWorkspacePath.length).replace(/^\/+/, '')
        : '';
      const workspaceDisplayPath = hasWorkspaceNamePrefix
        ? `/${normalizedNormalizedPath}`
        : hasWorkspacePathPrefix
          ? `${workspacePrefix}${relativePathFromWorkspace ? `/${relativePathFromWorkspace}` : ''}`
          : '';
      const containerRootRelativePath = normalizedPathNoTrailingSlash
        .replace(/^\/+workspace\/?/, '')
        .replace(/^\/+/, '');
      const filesDisplayPath = hasWorkspacePathPrefix
        ? `/workspace${relativePathFromWorkspace ? `/${relativePathFromWorkspace}` : ''}`
        : workspaceName
          ? normalizedNormalizedPath === workspaceName
            ? '/workspace'
            : normalizedNormalizedPath.startsWith(`${workspaceName}/`)
              ? `/workspace/${normalizedNormalizedPath.slice(workspaceName.length + 1)}`
              : containerRootRelativePath.startsWith(`${workspaceName}/`)
                ? `/workspace/${containerRootRelativePath.replace(`${workspaceName}/`, '')}`
                : workspaceDisplayPath
          : '';
      const displayPath = source === 'files'
        ? filesDisplayPath || workspaceDisplayPath || sanitizedNormalizedPath
        : sanitizedNormalizedPath.startsWith('/workspace/')
          ? sanitizedNormalizedPath
          : workspaceDisplayPath || sanitizedNormalizedPath;

      const fileName = resolvedPath.split('/').pop() || resolvedPath;

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
