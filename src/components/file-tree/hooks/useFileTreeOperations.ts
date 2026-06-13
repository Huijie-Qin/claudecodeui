import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import JSZip from 'jszip';

import { api } from '../../../utils/api';
import type { FileTreeNode } from '../types/types';
import type { Project } from '../../../types/app';
import { dispatchProjectFilesChanged } from '../utils/fileTreeEvents';

// Invalid filename characters
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export type ToastMessage = {
  message: string;
  type: 'success' | 'error';
};

export type DeleteConfirmation = {
  isOpen: boolean;
  item: FileTreeNode | null;
};

export type MoveDialog = {
  isOpen: boolean;
  item: FileTreeNode | null;
  targetDirectory: string;
};

export type UseFileTreeOperationsOptions = {
  selectedProject: Project | null;
  onRefresh: () => void;
  showToast: (message: string, type: 'success' | 'error') => void;
  isReadOnly?: boolean;
};

export type UseFileTreeOperationsResult = {
  // Rename operations
  renamingItem: FileTreeNode | null;
  renameValue: string;
  handleStartRename: (item: FileTreeNode) => void;
  handleCancelRename: () => void;
  handleConfirmRename: () => Promise<void>;
  setRenameValue: (value: string) => void;

  // Delete operations
  deleteConfirmation: DeleteConfirmation;
  handleStartDelete: (item: FileTreeNode) => void;
  handleCancelDelete: () => void;
  handleConfirmDelete: () => Promise<void>;

  // Create operations
  isCreating: boolean;
  newItemParent: string;
  newItemType: 'file' | 'directory';
  newItemName: string;
  handleStartCreate: (parentPath: string, type: 'file' | 'directory') => void;
  handleCancelCreate: () => void;
  handleConfirmCreate: () => Promise<void>;
  setNewItemName: (name: string) => void;

  // Other operations
  handleCopyPath: (item: FileTreeNode) => void;
  handleDownload: (item: FileTreeNode) => Promise<void>;

  // Move operations
  moveDialog: MoveDialog;
  handleStartMove: (item: FileTreeNode) => void;
  handleCancelMove: () => void;
  handleConfirmMove: () => Promise<void>;
  setMoveTargetDirectory: (value: string) => void;

  // Loading state
  operationLoading: boolean;

  // Validation
  validateFilename: (name: string) => string | null;
};

export function getFileTreeDisplayPath(filePath: string, project?: Project | null): string {
  const normalizedPath = String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/g, '');
  if (!normalizedPath) {
    return '/workspace';
  }

  if (normalizedPath === '/workspace' || normalizedPath.startsWith('/workspace/')) {
    return normalizedPath;
  }

  const workspacePath = String(project?.fullPath || project?.path || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/g, '');
  if (workspacePath) {
    if (normalizedPath === workspacePath) {
      return '/workspace';
    }
    if (normalizedPath.startsWith(`${workspacePath}/`)) {
      return `/workspace/${normalizedPath.slice(workspacePath.length + 1)}`;
    }
  }

  return normalizedPath.startsWith('/') ? normalizedPath : `/workspace/${normalizedPath}`;
}

export function useFileTreeOperations({
  selectedProject,
  onRefresh,
  showToast,
  isReadOnly = false,
}: UseFileTreeOperationsOptions): UseFileTreeOperationsResult {
  const { t } = useTranslation();

  // State
  const [renamingItem, setRenamingItem] = useState<FileTreeNode | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmation>({
    isOpen: false,
    item: null,
  });
  const [moveDialog, setMoveDialog] = useState<MoveDialog>({
    isOpen: false,
    item: null,
    targetDirectory: '',
  });
  const [isCreating, setIsCreating] = useState(false);
  const [newItemParent, setNewItemParent] = useState('');
  const [newItemType, setNewItemType] = useState<'file' | 'directory'>('file');
  const [newItemName, setNewItemName] = useState('');
  const [operationLoading, setOperationLoading] = useState(false);

  // Validation
  const validateFilename = useCallback((name: string): string | null => {
    if (!name || !name.trim()) {
      return t('fileTree.validation.emptyName', 'Filename cannot be empty');
    }
    if (INVALID_FILENAME_CHARS.test(name)) {
      return t('fileTree.validation.invalidChars', 'Filename contains invalid characters');
    }
    if (RESERVED_NAMES.test(name)) {
      return t('fileTree.validation.reserved', 'Filename is a reserved name');
    }
    if (/^\.+$/.test(name)) {
      return t('fileTree.validation.dotsOnly', 'Filename cannot be only dots');
    }
    return null;
  }, [t]);

  // Rename operations
  const handleStartRename = useCallback((item: FileTreeNode) => {
    if (isReadOnly) return;
    setRenamingItem(item);
    setRenameValue(item.name);
    setIsCreating(false);
  }, [isReadOnly]);

  const handleCancelRename = useCallback(() => {
    setRenamingItem(null);
    setRenameValue('');
  }, []);

  const handleConfirmRename = useCallback(async () => {
    if (!renamingItem || !selectedProject || isReadOnly) return;

    const error = validateFilename(renameValue);
    if (error) {
      showToast(error, 'error');
      return;
    }

    if (renameValue === renamingItem.name) {
      handleCancelRename();
      return;
    }

    setOperationLoading(true);
    try {
      const response = await api.renameFile(selectedProject.name, {
        oldPath: renamingItem.path,
        newName: renameValue,
        workspaceId: selectedProject.workspaceId,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to rename');
      }

      showToast(t('fileTree.toast.renamed', 'Renamed successfully'), 'success');
      dispatchProjectFilesChanged({
        projectName: selectedProject.name,
        workspaceId: selectedProject.workspaceId,
        changedPath: renameValue,
        reason: 'rename',
      });
      onRefresh();
      handleCancelRename();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [renamingItem, renameValue, selectedProject, isReadOnly, validateFilename, showToast, t, onRefresh, handleCancelRename]);

  // Delete operations
  const handleStartDelete = useCallback((item: FileTreeNode) => {
    if (isReadOnly) return;
    setDeleteConfirmation({ isOpen: true, item });
  }, [isReadOnly]);

  const handleCancelDelete = useCallback(() => {
    setDeleteConfirmation({ isOpen: false, item: null });
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    const { item } = deleteConfirmation;
    if (!item || !selectedProject || isReadOnly) return;

    setOperationLoading(true);
    try {
      const response = await api.deleteFile(selectedProject.name, {
        path: item.path,
        type: item.type,
        workspaceId: selectedProject.workspaceId,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete');
      }

      showToast(
        item.type === 'directory'
          ? t('fileTree.toast.folderDeleted', 'Folder deleted')
          : t('fileTree.toast.fileDeleted', 'File deleted'),
        'success'
      );
      dispatchProjectFilesChanged({
        projectName: selectedProject.name,
        workspaceId: selectedProject.workspaceId,
        changedPath: item.path,
        reason: 'delete',
      });
      onRefresh();
      handleCancelDelete();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [deleteConfirmation, selectedProject, isReadOnly, showToast, t, onRefresh, handleCancelDelete]);

  // Create operations
  const handleStartCreate = useCallback((parentPath: string, type: 'file' | 'directory') => {
    if (isReadOnly) return;
    setNewItemParent(parentPath || '');
    setNewItemType(type);
    setNewItemName(type === 'file' ? 'untitled.txt' : 'new-folder');
    setIsCreating(true);
    setRenamingItem(null);
  }, [isReadOnly]);

  const handleCancelCreate = useCallback(() => {
    setIsCreating(false);
    setNewItemParent('');
    setNewItemName('');
  }, []);

  const handleConfirmCreate = useCallback(async () => {
    if (!selectedProject || isReadOnly) return;

    const error = validateFilename(newItemName);
    if (error) {
      showToast(error, 'error');
      return;
    }

    setOperationLoading(true);
    try {
      const response = await api.createFile(selectedProject.name, {
        path: newItemParent,
        type: newItemType,
        name: newItemName,
        workspaceId: selectedProject.workspaceId,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create');
      }

      showToast(
        newItemType === 'file'
          ? t('fileTree.toast.fileCreated', 'File created successfully')
          : t('fileTree.toast.folderCreated', 'Folder created successfully'),
        'success'
      );
      dispatchProjectFilesChanged({
        projectName: selectedProject.name,
        workspaceId: selectedProject.workspaceId,
        changedPath: newItemParent ? `${newItemParent}/${newItemName}` : newItemName,
        reason: 'create',
      });
      onRefresh();
      handleCancelCreate();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [selectedProject, isReadOnly, newItemParent, newItemType, newItemName, validateFilename, showToast, t, onRefresh, handleCancelCreate]);

  // Copy path to clipboard
  const handleCopyPath = useCallback((item: FileTreeNode) => {
    navigator.clipboard.writeText(item.path).catch(() => {
      // Clipboard API may fail in some contexts (e.g., non-HTTPS)
      showToast(t('fileTree.toast.copyFailed', 'Failed to copy path'), 'error');
      return;
    });
    showToast(t('fileTree.toast.pathCopied', 'Path copied to clipboard'), 'success');
  }, [showToast, t]);

  const triggerBrowserDownload = useCallback((blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = fileName;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
  }, []);

  // Download a single file
  const downloadSingleFile = useCallback(async (item: FileTreeNode) => {
    if (!selectedProject) return;

    // Use the binary streaming endpoint so downloads preserve raw bytes.
    const response = await api.readFileBlob(selectedProject.name, item.path, selectedProject.workspaceId);

    if (!response.ok) {
      throw new Error('Failed to download file');
    }

    const blob = await response.blob();
    triggerBrowserDownload(blob, item.name);
  }, [selectedProject, triggerBrowserDownload]);

  // Download folder as ZIP
  const downloadFolderAsZip = useCallback(async (folder: FileTreeNode) => {
    if (!selectedProject) return;

    const zip = new JSZip();

    // Recursively get all files in the folder
    const collectFiles = async (node: FileTreeNode, currentPath: string) => {
      const fullPath = currentPath ? `${currentPath}/${node.name}` : node.name;

      if (node.type === 'file') {
        const response = await api.readFileBlob(selectedProject.name, node.path, selectedProject.workspaceId);
        if (!response.ok) {
          throw new Error(`Failed to download "${node.name}" for ZIP export`);
        }

        // Store raw bytes in the archive so binary files stay intact.
        const fileBytes = await response.arrayBuffer();
        zip.file(fullPath, fileBytes);
      } else if (node.type === 'directory' && node.children) {
        // Recursively process children
        for (const child of node.children) {
          await collectFiles(child, fullPath);
        }
      }
    };

    // If the folder has children, process them
    if (folder.children && folder.children.length > 0) {
      for (const child of folder.children) {
        await collectFiles(child, '');
      }
    }

    // Generate ZIP file
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    triggerBrowserDownload(zipBlob, `${folder.name}.zip`);

    showToast(t('fileTree.toast.folderDownloaded', 'Folder downloaded as ZIP'), 'success');
  }, [selectedProject, showToast, t, triggerBrowserDownload]);

  // Download file or folder
  const handleDownload = useCallback(async (item: FileTreeNode) => {
    if (!selectedProject) return;

    setOperationLoading(true);
    try {
      if (item.type === 'directory') {
        // Download folder as ZIP
        await downloadFolderAsZip(item);
      } else {
        // Download single file
        await downloadSingleFile(item);
      }
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [downloadFolderAsZip, downloadSingleFile, selectedProject, showToast]);

  const handleStartMove = useCallback((item: FileTreeNode) => {
    if (isReadOnly) return;
    setMoveDialog({
      isOpen: true,
      item,
      targetDirectory: '',
    });
  }, [isReadOnly]);

  const handleCancelMove = useCallback(() => {
    setMoveDialog({
      isOpen: false,
      item: null,
      targetDirectory: '',
    });
  }, []);

  const setMoveTargetDirectory = useCallback((value: string) => {
    setMoveDialog((previous) => ({ ...previous, targetDirectory: value }));
  }, []);

  const handleConfirmMove = useCallback(async () => {
    const { item, targetDirectory } = moveDialog;
    if (!item || !selectedProject || isReadOnly) return;

    setOperationLoading(true);
    try {
      const response = await api.moveFile(selectedProject.name, {
        sourcePath: item.path,
        targetDirectory,
        workspaceId: selectedProject.workspaceId,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to move');
      }

      const result = await response.json();
      showToast(t('fileTree.toast.moved', 'Moved successfully'), 'success');
      dispatchProjectFilesChanged({
        projectName: selectedProject.name,
        workspaceId: selectedProject.workspaceId,
        changedPath: result.relativePath || item.path,
        reason: 'move',
      });
      onRefresh();
      handleCancelMove();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [moveDialog, selectedProject, isReadOnly, showToast, t, onRefresh, handleCancelMove]);

  return {
    // Rename operations
    renamingItem,
    renameValue,
    handleStartRename,
    handleCancelRename,
    handleConfirmRename,
    setRenameValue,

    // Delete operations
    deleteConfirmation,
    handleStartDelete,
    handleCancelDelete,
    handleConfirmDelete,

    // Create operations
    isCreating,
    newItemParent,
    newItemType,
    newItemName,
    handleStartCreate,
    handleCancelCreate,
    handleConfirmCreate,
    setNewItemName,

    // Other operations
    handleCopyPath,
    handleDownload,

    // Move operations
    moveDialog,
    handleStartMove,
    handleCancelMove,
    handleConfirmMove,
    setMoveTargetDirectory,

    // Loading state
    operationLoading,

    // Validation
    validateFilename,
  };
}
