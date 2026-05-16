import { useCallback, useState, useRef } from 'react';

import type { Project } from '../../../types/app';
import type { FileTreeNode } from '../types/types';
import { api } from '../../../utils/api';
import { FILE_TREE_DROP_TARGET_ATTRIBUTE } from '../constants/constants';
import { dispatchProjectFilesChanged } from '../utils/fileTreeEvents';

type UseFileTreeUploadOptions = {
  selectedProject: Project | null;
  onRefresh: () => void;
  showToast: (message: string, type: 'success' | 'error') => void;
  isReadOnly?: boolean;
  projectFiles: FileTreeNode[];
};

type UploadOverwriteDialogState = {
  isOpen: boolean;
  duplicates: string[];
  tooMany: number;
  targetPath: string;
};

// Helper function to read all files from a directory entry recursively
const readAllDirectoryEntries = async (directoryEntry: FileSystemDirectoryEntry, basePath = ''): Promise<File[]> => {
  const files: File[] = [];

  const reader = directoryEntry.createReader();
  let entries: FileSystemEntry[] = [];

  // Read all entries from the directory (may need multiple reads)
  let batch: FileSystemEntry[];
  do {
    batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    entries = entries.concat(batch);
  } while (batch.length > 0);

  // Files to ignore (system files)
  const ignoredFiles = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];

  for (const entry of entries) {
    const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const file = await new Promise<File>((resolve, reject) => {
        fileEntry.file(resolve, reject);
      });

      // Skip ignored files
      if (ignoredFiles.includes(file.name)) {
        continue;
      }

      // Create a new file with the relative path as the name
      const fileWithPath = new File([file], entryPath, {
        type: file.type,
        lastModified: file.lastModified,
      });
      files.push(fileWithPath);
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const subFiles = await readAllDirectoryEntries(dirEntry, entryPath);
      files.push(...subFiles);
    }
  }

  return files;
};

function getUploadRelativePath(file: File) {
  const browserRelativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return browserRelativePath || file.name;
}

function getUploadFileName(file: File, relativePath: string) {
  const pathParts = relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
  return pathParts[pathParts.length - 1] || file.name;
}

function normalizePath(pathValue: string) {
  return pathValue.replace(/\\/g, '/').replace(/\/+$/g, '');
}

function isAbsolutePath(pathValue: string) {
  const normalized = normalizePath(pathValue);
  return normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized);
}

function joinPath(basePath: string, childPath: string) {
  const normalizedBase = normalizePath(basePath);
  const normalizedChild = normalizePath(childPath).replace(/^\/+/, '');
  if (!normalizedBase) return normalizedChild;
  if (!normalizedChild) return normalizedBase;
  return `${normalizedBase}/${normalizedChild}`;
}

function collectAllPaths(nodes: FileTreeNode[], result: Set<string>) {
  for (const node of nodes) {
    result.add(normalizePath(node.path).toLowerCase());
    if (node.children?.length) {
      collectAllPaths(node.children, result);
    }
  }
}

function getProjectRoot(project: Project | null) {
  return normalizePath(project?.path || '');
}

function resolveTargetBase(targetPath: string, projectRoot: string) {
  if (!targetPath || targetPath === '.' || targetPath === './') {
    return projectRoot;
  }

  return isAbsolutePath(targetPath) ? normalizePath(targetPath) : joinPath(projectRoot, targetPath);
}

function getDisplayRelativePath(relativePath: string) {
  return normalizePath(relativePath).replace(/^\//, '');
}

function resolveDirectoryDropTarget(eventTarget: EventTarget | null) {
  if (!(eventTarget instanceof Node)) {
    return '';
  }

  const element = eventTarget instanceof Element ? eventTarget : eventTarget.parentElement;
  const dropTargetElement = element?.closest(`[${FILE_TREE_DROP_TARGET_ATTRIBUTE}]`);

  return dropTargetElement?.getAttribute(FILE_TREE_DROP_TARGET_ATTRIBUTE) || '';
}

export const useFileTreeUpload = ({
  selectedProject,
  onRefresh,
  showToast,
  isReadOnly = false,
  projectFiles,
}: UseFileTreeUploadOptions) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [operationLoading, setOperationLoading] = useState(false);
  const [overwriteDialog, setOverwriteDialog] = useState<UploadOverwriteDialogState>({
    isOpen: false,
    duplicates: [],
    tooMany: 0,
    targetPath: '',
  });

  const treeRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const pickerTargetPathRef = useRef('');
  const pendingUploadRef = useRef<{ files: File[]; targetPath: string } | null>(null);

  const performUpload = useCallback(async (files: File[], targetPath = '') => {
    if (isReadOnly || !selectedProject || files.length === 0) {
      return;
    }

    setOperationLoading(true);

    try {
      const formData = new FormData();
      formData.append('targetPath', targetPath);

      const relativePaths: string[] = [];
      files.forEach((file) => {
        const relativePath = getUploadRelativePath(file);
        const cleanFile = new File([file], getUploadFileName(file, relativePath), {
          type: file.type,
          lastModified: file.lastModified
        });
        formData.append('files', cleanFile);
        relativePaths.push(relativePath);
      });

      formData.append('relativePaths', JSON.stringify(relativePaths));

      const response = await api.uploadFiles(selectedProject.name, formData, selectedProject.workspaceId);

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Upload failed');
      }

      showToast(
        `Uploaded ${files.length} file(s)`,
        'success'
      );
      dispatchProjectFilesChanged({
        projectName: selectedProject.name,
        workspaceId: selectedProject.workspaceId,
        changedPath: targetPath,
        reason: 'upload',
      });
      onRefresh();
    } catch (err) {
      console.error('Upload error:', err);
      showToast(err instanceof Error ? err.message : 'Upload failed', 'error');
    } finally {
      setOperationLoading(false);
      setDropTarget(null);
    }
  }, [isReadOnly, onRefresh, selectedProject, showToast]);

  const uploadFiles = useCallback(async (files: File[], targetPath = '') => {
    if (isReadOnly || !selectedProject || files.length === 0) {
      return;
    }

    const projectRoot = getProjectRoot(selectedProject);
    const existingPaths = new Set<string>();
    collectAllPaths(projectFiles, existingPaths);

    const resolvedTargetPath = resolveTargetBase(targetPath, projectRoot);
    const duplicateFiles = files
      .map((file) => {
        const relativePath = getDisplayRelativePath(getUploadRelativePath(file) || file.name);
        const finalPath = joinPath(resolvedTargetPath, relativePath).toLowerCase();
        const isDuplicate = existingPaths.has(finalPath);

        return isDuplicate
          ? {
              relativePath,
              finalPath,
            }
          : null;
      })
      .filter(
        (
          item,
        ): item is {
          relativePath: string;
          finalPath: string;
        } => Boolean(item),
      );

    const uniqueDuplicateLabels = Array.from(
      new Map(duplicateFiles.map((item) => [item.finalPath, item.relativePath])).values(),
    );

    if (uniqueDuplicateLabels.length > 0) {
      const maxShow = 20;
      const shownConflicts = uniqueDuplicateLabels.slice(0, maxShow);
      const tooMany = uniqueDuplicateLabels.length > maxShow
        ? uniqueDuplicateLabels.length - maxShow
        : 0;

      pendingUploadRef.current = { files, targetPath };
      setOverwriteDialog({
        isOpen: true,
        duplicates: shownConflicts,
        tooMany,
        targetPath,
      });
      return;
    }

    await performUpload(files, targetPath);
  }, [isReadOnly, selectedProject, projectFiles, performUpload]);

  const handleConfirmOverwrite = useCallback(async () => {
    const pendingUpload = pendingUploadRef.current;
    pendingUploadRef.current = null;
    setOverwriteDialog({ isOpen: false, duplicates: [], tooMany: 0, targetPath: '' });

    if (!pendingUpload) {
      return;
    }

    await performUpload(pendingUpload.files, pendingUpload.targetPath);
  }, [performUpload]);

  const handleCancelOverwrite = useCallback(() => {
    pendingUploadRef.current = null;
    setOverwriteDialog({ isOpen: false, duplicates: [], tooMany: 0, targetPath: '' });
  }, []);

  const openFilePicker = useCallback((targetPath = '') => {
    if (isReadOnly) return;
    pickerTargetPathRef.current = targetPath;
    fileInputRef.current?.click();
  }, [isReadOnly]);

  const openFolderPicker = useCallback((targetPath = '') => {
    if (isReadOnly) return;
    pickerTargetPathRef.current = targetPath;
    folderInputRef.current?.setAttribute('webkitdirectory', '');
    folderInputRef.current?.setAttribute('directory', '');
    folderInputRef.current?.click();
  }, [isReadOnly]);

  const handleFileInputChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    void uploadFiles(files, pickerTargetPathRef.current);
  }, [uploadFiles]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isReadOnly) return;
    setIsDragOver(true);
    const nextDropTarget = resolveDirectoryDropTarget(e.target);
    setDropTarget((currentDropTarget) => (
      currentDropTarget === nextDropTarget ? currentDropTarget : nextDropTarget
    ));
  }, [isReadOnly]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isReadOnly) return;
    const nextDropTarget = resolveDirectoryDropTarget(e.target);
    setDropTarget((currentDropTarget) => (
      currentDropTarget === nextDropTarget ? currentDropTarget : nextDropTarget
    ));
  }, [isReadOnly]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set isDragOver to false if we're leaving the entire tree
    if (treeRef.current && !treeRef.current.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
      setDropTarget(null);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (isReadOnly || !selectedProject) {
      return;
    }

    const targetPath = resolveDirectoryDropTarget(e.target) || dropTarget || '';
    setDropTarget(null);

    try {
      const files: File[] = [];

      // Use DataTransferItemList for folder support
      const items = e.dataTransfer.items;
      if (items) {
        for (const item of Array.from(items)) {
          if (item.kind === 'file') {
            const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;

            if (entry) {
              if (entry.isFile) {
                const file = await new Promise<File>((resolve, reject) => {
                  (entry as FileSystemFileEntry).file(resolve, reject);
                });
                files.push(file);
              } else if (entry.isDirectory) {
                // Pass the directory name as basePath so files include the folder path
                const dirFiles = await readAllDirectoryEntries(entry as FileSystemDirectoryEntry, entry.name);
                files.push(...dirFiles);
              }
            }
          }
        }
      } else {
        // Fallback for browsers that don't support webkitGetAsEntry
        const fileList = e.dataTransfer.files;
        for (const file of Array.from(fileList)) {
          files.push(file);
        }
      }

      if (files.length === 0) {
        setDropTarget(null);
        return;
      }

      await uploadFiles(files, targetPath);
    } catch (err) {
      console.error('Upload error:', err);
      showToast(err instanceof Error ? err.message : 'Upload failed', 'error');
    }
  }, [dropTarget, selectedProject, isReadOnly, uploadFiles, showToast]);

  return {
    isDragOver,
    dropTarget,
    operationLoading,
    overwriteDialog,
    treeRef,
    fileInputRef,
    folderInputRef,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleFileInputChange,
    openFilePicker,
    openFolderPicker,
    setDropTarget,
    handleConfirmOverwrite,
    handleCancelOverwrite,
  };
};
