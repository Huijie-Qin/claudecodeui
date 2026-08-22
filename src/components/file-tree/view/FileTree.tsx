import { useCallback, useState, useEffect, useMemo, useRef, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, X, Loader2, Upload, Move, Trash2 } from 'lucide-react';

import { cn } from '../../../lib/utils';
import { ICON_SIZE_CLASS, getFileIconData } from '../constants/fileIcons';
import { useExpandedDirectories } from '../hooks/useExpandedDirectories';
import { useFileTreeData } from '../hooks/useFileTreeData';
import { getFileTreeDisplayPath, useFileTreeOperations } from '../hooks/useFileTreeOperations';
import { useFileTreeSearch } from '../hooks/useFileTreeSearch';
import { useFileTreeViewMode } from '../hooks/useFileTreeViewMode';
import { useFileTreeUpload } from '../hooks/useFileTreeUpload';
import { useWorkspaceStorageQuota } from '../hooks/useWorkspaceStorageQuota';
import type { FileTreeImageSelection, FileTreeNode } from '../types/types';
import { formatFileSize, formatRelativeTime, isImageFile } from '../utils/fileTreeUtils';
import { Project } from '../../../types/app';
import { ScrollArea, Input } from '../../../shared/view/ui';
import { api } from '../../../utils/api';
import { dispatchProjectFilesChanged } from '../utils/fileTreeEvents';

import FileTreeBody from './FileTreeBody';
import FileTreeCreateInput from './FileTreeCreateInput';
import FileTreeDetailedColumns from './FileTreeDetailedColumns';
import FileTreeHeader from './FileTreeHeader';
import FileTreeLoadingState from './FileTreeLoadingState';
import ImageViewer from './ImageViewer';


type FileTreeProps = {
  selectedProject: Project | null;
  onFileOpen?: (filePath: string) => void;
  isReadOnly?: boolean;
  presentation?: 'default' | 'data-agent';
  activePath?: string | null;
  beforeFileMutation?: (paths: string[]) => Promise<boolean>;
};

export default function FileTree({
  selectedProject,
  onFileOpen,
  isReadOnly = false,
  presentation = 'default',
  activePath,
  beforeFileMutation,
}: FileTreeProps) {
  const { t } = useTranslation();
  const [selectedImage, setSelectedImage] = useState<FileTreeImageSelection | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [focusedDirectoryPath, setFocusedDirectoryPath] = useState<string | null>(null);
  const [internalDropTarget, setInternalDropTarget] = useState<string | null>(null);
  const [batchMoveOpen, setBatchMoveOpen] = useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchTargetDirectory, setBatchTargetDirectory] = useState('/workspace');
  const [batchLoading, setBatchLoading] = useState(false);
  const draggedItemsRef = useRef<FileTreeNode[]>([]);
  const newItemInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Show toast notification
  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
  }, []);

  // Auto-hide toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const { files, loading, refreshFiles } = useFileTreeData(selectedProject);
  const { quota, loading: quotaLoading, refreshQuota } = useWorkspaceStorageQuota(selectedProject);
  const { viewMode, changeViewMode } = useFileTreeViewMode(presentation === 'data-agent'
    ? { defaultMode: 'detailed', storageKey: 'data-agent-file-tree-view-mode' }
    : undefined);
  const effectiveViewMode = viewMode;
  const { expandedDirs, toggleDirectory, expandDirectories, collapseAll } = useExpandedDirectories();
  const { searchQuery, setSearchQuery, filteredFiles } = useFileTreeSearch({
    files,
    expandDirectories,
  });

  const allItemsByPath = useMemo(() => {
    const result = new Map<string, FileTreeNode>();
    const visit = (nodes: FileTreeNode[]) => nodes.forEach((node) => {
      result.set(node.path, node);
      if (node.children) visit(node.children);
    });
    visit(files);
    return result;
  }, [files]);

  const selectedItems = useMemo(
    () => Array.from(selectedPaths).map((path) => allItemsByPath.get(path)).filter((item): item is FileTreeNode => Boolean(item)),
    [allItemsByPath, selectedPaths],
  );

  const filteredItemCount = useMemo(() => {
    let count = 0;
    const visit = (nodes: FileTreeNode[]) => nodes.forEach((node) => {
      count += 1;
      if (node.children) visit(node.children);
    });
    visit(filteredFiles);
    return count;
  }, [filteredFiles]);

  useEffect(() => {
    setSelectedPaths((previous) => new Set(Array.from(previous).filter((path) => allItemsByPath.has(path))));
    setFocusedDirectoryPath((previous) => (
      previous && allItemsByPath.get(previous)?.type === 'directory' ? previous : null
    ));
  }, [allItemsByPath]);

  useEffect(() => {
    setFocusedDirectoryPath(null);
  }, [selectedProject?.name, selectedProject?.workspaceId]);

  const refreshWorkspaceFiles = useCallback(() => {
    refreshFiles();
    refreshQuota();
  }, [refreshFiles, refreshQuota]);

  // File operations
  const operations = useFileTreeOperations({
    selectedProject,
    onRefresh: refreshWorkspaceFiles,
    showToast,
    isReadOnly,
    beforeFileMutation,
  });

  // File upload (drag and drop)
  const upload = useFileTreeUpload({
    selectedProject,
    onRefresh: refreshWorkspaceFiles,
    showToast,
    isReadOnly,
    projectFiles: files,
    quota,
    getUploadQuotaErrorMessage: (uploadMb, remainingMb) => t('fileTree.upload.quotaExceeded', {
      uploadSize: uploadMb,
      remainingSize: remainingMb,
    }),
  });

  // Focus input when creating new item
  useEffect(() => {
    if (operations.isCreating && newItemInputRef.current) {
      newItemInputRef.current.focus();
      newItemInputRef.current.select();
    }
  }, [operations.isCreating]);

  // Focus input when renaming
  useEffect(() => {
    if (operations.renamingItem && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [operations.renamingItem]);

  const renderFileIcon = useCallback((filename: string) => {
    const { icon: Icon, color } = getFileIconData(filename);
    return <Icon className={cn(ICON_SIZE_CLASS, color)} />;
  }, []);

  // Centralized click behavior keeps file actions identical across all presentation modes.
  const handleItemClick = useCallback(
    (item: FileTreeNode) => {
      if (item.type === 'directory') {
        setFocusedDirectoryPath(item.path);
        toggleDirectory(item.path);
        return;
      }

      if (presentation !== 'data-agent' && isImageFile(item.name) && selectedProject) {
        setSelectedImage({
          name: item.name,
          path: item.path,
          projectPath: selectedProject.path,
          projectName: selectedProject.name,
        });
        return;
      }

      onFileOpen?.(item.path);
    },
    [onFileOpen, presentation, selectedProject, toggleDirectory],
  );

  const formatRelativeTimeLabel = useCallback(
    (date?: string) => formatRelativeTime(date, t),
    [t],
  );

  const handleSelectionChange = useCallback((item: FileTreeNode) => {
    setSelectedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(item.path)) next.delete(item.path);
      else next.add(item.path);
      return next;
    });
  }, []);

  const getTopLevelItems = useCallback((items: FileTreeNode[]) => items.filter((item) =>
    !items.some((candidate) => candidate.path !== item.path && item.path.replace(/\\/g, '/').startsWith(`${candidate.path.replace(/\\/g, '/')}/`))
  ), []);

  const moveItems = useCallback(async (items: FileTreeNode[], targetDirectory: string) => {
    if (!selectedProject || items.length === 0) return;
    const normalizedTarget = targetDirectory.trim().replace(/\\/g, '/').replace(/\/+$/g, '') || '/workspace';
    if (normalizedTarget !== '/workspace' && !normalizedTarget.startsWith('/workspace/')) {
      showToast(t('fileTree.move.workspacePathRequired', 'Path must be /workspace or start with /workspace/'), 'error');
      return;
    }
    const movableItems = getTopLevelItems(items);
    const sourcePaths = movableItems.map((item) => getFileTreeDisplayPath(item.path, selectedProject));
    const invalidDestination = movableItems.find((item) => {
      if (item.type !== 'directory') return false;
      const sourcePath = getFileTreeDisplayPath(item.path, selectedProject).replace(/\/+$/g, '');
      return normalizedTarget === sourcePath || normalizedTarget.startsWith(`${sourcePath}/`);
    });
    if (invalidDestination) {
      showToast(
        t('fileTree.move.invalidDescendant', 'A folder cannot be moved into itself or one of its subfolders.'),
        'error',
      );
      setInternalDropTarget(null);
      draggedItemsRef.current = [];
      return;
    }
    if (beforeFileMutation && !await beforeFileMutation(sourcePaths)) return;
    setBatchLoading(true);
    try {
      const pathChanges: Array<{ oldPath: string; newPath: string }> = [];
      for (const item of movableItems) {
        const sourcePath = getFileTreeDisplayPath(item.path, selectedProject);
        const response = await api.moveFile(selectedProject.name, {
          sourcePath,
          targetDirectory: normalizedTarget,
          workspaceId: selectedProject.workspaceId,
        });
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || `Failed to move ${item.name}`);
        }
        const payload = await response.json().catch(() => ({}));
        const returnedPath = String(payload.relativePath || '').replace(/\\/g, '/');
        pathChanges.push({
          oldPath: sourcePath,
          newPath: returnedPath.startsWith('/workspace')
            ? returnedPath
            : `${normalizedTarget}/${item.name}`.replace(/\/+/g, '/'),
        });
      }
      showToast(t('fileTree.toast.itemsMoved', '{{count}} item(s) moved', { count: movableItems.length }), 'success');
      setSelectedPaths(new Set());
      setBatchMoveOpen(false);
      dispatchProjectFilesChanged({ projectName: selectedProject.name, workspaceId: selectedProject.workspaceId, changedPath: normalizedTarget, reason: 'move', pathChanges });
      refreshWorkspaceFiles();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Move failed', 'error');
    } finally {
      setBatchLoading(false);
      setInternalDropTarget(null);
      draggedItemsRef.current = [];
    }
  }, [beforeFileMutation, getTopLevelItems, refreshWorkspaceFiles, selectedProject, showToast, t]);

  const deleteSelectedItems = useCallback(async () => {
    if (!selectedProject) return;
    const deletableItems = getTopLevelItems(selectedItems);
    const deletedPaths = deletableItems.map((item) => getFileTreeDisplayPath(item.path, selectedProject));
    if (beforeFileMutation && !await beforeFileMutation(deletedPaths)) return;
    setBatchLoading(true);
    try {
      for (const item of deletableItems) {
        const response = await api.deleteFile(selectedProject.name, {
          path: item.path, type: item.type, workspaceId: selectedProject.workspaceId,
        });
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || `Failed to delete ${item.name}`);
        }
      }
      showToast(t('fileTree.toast.itemsDeleted', '{{count}} item(s) deleted', { count: deletableItems.length }), 'success');
      setSelectedPaths(new Set());
      setBatchDeleteOpen(false);
      dispatchProjectFilesChanged({ projectName: selectedProject.name, workspaceId: selectedProject.workspaceId, changedPath: '', reason: 'delete', deletedPaths });
      refreshWorkspaceFiles();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Delete failed', 'error');
    } finally {
      setBatchLoading(false);
    }
  }, [beforeFileMutation, getTopLevelItems, refreshWorkspaceFiles, selectedItems, selectedProject, showToast, t]);

  const handleInternalDragStart = useCallback((item: FileTreeNode, event: DragEvent<HTMLDivElement>) => {
    const items = selectedPaths.has(item.path) ? selectedItems : [item];
    draggedItemsRef.current = items;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-cloudcli-file-tree', item.path);
    event.dataTransfer.setData('text/plain', item.name);
  }, [selectedItems, selectedPaths]);

  const handleInternalDragOver = useCallback((item: FileTreeNode, event: DragEvent<HTMLDivElement>) => {
    if (item.type !== 'directory' || !event.dataTransfer.types.includes('application/x-cloudcli-file-tree')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setInternalDropTarget(item.path);
  }, []);

  const handleInternalDrop = useCallback((item: FileTreeNode, event: DragEvent<HTMLDivElement>) => {
    if (item.type !== 'directory' || !event.dataTransfer.types.includes('application/x-cloudcli-file-tree')) return;
    event.preventDefault();
    event.stopPropagation();
    void moveItems(draggedItemsRef.current, getFileTreeDisplayPath(item.path, selectedProject));
  }, [moveItems, selectedProject]);

  if (loading) {
    return <FileTreeLoadingState />;
  }

  return (
    <div
      ref={upload.treeRef}
      className={cn(
        'relative flex h-full flex-col bg-background',
        presentation === 'data-agent' && 'data-agent-file-tree',
      )}
      onDragEnter={isReadOnly ? undefined : (event) => {
        if (!event.dataTransfer.types.includes('application/x-cloudcli-file-tree')) upload.handleDragEnter(event);
      }}
      onDragOver={isReadOnly ? undefined : (event) => {
        if (!event.dataTransfer.types.includes('application/x-cloudcli-file-tree')) upload.handleDragOver(event);
      }}
      onDragLeave={isReadOnly ? undefined : upload.handleDragLeave}
      onDrop={isReadOnly ? undefined : upload.handleDrop}
    >
      {/* Drag overlay */}
      {upload.isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center border-2 border-dashed border-blue-500 bg-blue-500/10">
          <div className="flex items-center gap-3 rounded-lg bg-background/95 px-6 py-4 shadow-lg">
            <Upload className="h-6 w-6 text-blue-500" />
            <span className="text-sm font-medium">{t('fileTree.dropToUpload', 'Drop files to upload')}</span>
          </div>
        </div>
      )}

      <FileTreeHeader
        viewMode={effectiveViewMode}
        onViewModeChange={changeViewMode}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onNewFile={isReadOnly ? undefined : () => operations.handleStartCreate(focusedDirectoryPath ?? '', 'file')}
        onNewFolder={isReadOnly ? undefined : () => operations.handleStartCreate(focusedDirectoryPath ?? '', 'directory')}
        onUpload={isReadOnly ? undefined : () => upload.openFilePicker(focusedDirectoryPath ?? '')}
        onUploadFolder={isReadOnly ? undefined : () => upload.openFolderPicker(focusedDirectoryPath ?? '')}
        onSelectRoot={() => setFocusedDirectoryPath(null)}
        onRefresh={refreshWorkspaceFiles}
        onCollapseAll={collapseAll}
        loading={loading}
        operationLoading={operations.operationLoading || upload.operationLoading}
        quota={quota}
        quotaLoading={quotaLoading}
        presentation={presentation}
        workspaceName={selectedProject?.displayName || selectedProject?.name}
        itemCount={files.length}
        totalItemCount={allItemsByPath.size}
        filteredItemCount={filteredItemCount}
      />

      {!isReadOnly && selectedItems.length > 0 && (
        <div className="mx-2 mt-1 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5">
          <span className="mr-auto text-xs text-muted-foreground">
            {t('fileTree.selectedCount', '{{count}} selected', { count: selectedItems.length })}
          </span>
          <button onClick={() => { setBatchTargetDirectory('/workspace'); setBatchMoveOpen(true); }}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-accent">
            <Move className="h-3.5 w-3.5" />{t('fileTree.move.confirm', 'Move')}
          </button>
          <button onClick={() => setBatchDeleteOpen(true)}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-red-600 hover:bg-red-500/10">
            <Trash2 className="h-3.5 w-3.5" />{t('fileTree.delete.confirm', 'Delete')}
          </button>
          <button onClick={() => setSelectedPaths(new Set())} className="rounded p-1 hover:bg-accent" aria-label="Clear selection"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <input
        ref={upload.fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={upload.handleFileInputChange}
      />
      <input
        ref={upload.folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={upload.handleFileInputChange}
      />

      {effectiveViewMode === 'detailed' && filteredFiles.length > 0 && <FileTreeDetailedColumns />}

      <ScrollArea className="flex-1 px-2 py-1">
        <div className="min-h-full" onClick={() => setFocusedDirectoryPath(null)}>
        {/* New item input */}
        {operations.isCreating && operations.newItemParent === '' && (
          <FileTreeCreateInput
            viewMode={effectiveViewMode}
            level={0}
            newItemType={operations.newItemType}
            newItemName={operations.newItemName}
            setNewItemName={operations.setNewItemName}
            handleConfirmCreate={operations.handleConfirmCreate}
            handleCancelCreate={operations.handleCancelCreate}
            newItemInputRef={newItemInputRef}
            operationLoading={operations.operationLoading}
            renderFileIcon={renderFileIcon}
          />
        )}

        <FileTreeBody
          files={files}
          filteredFiles={filteredFiles}
          searchQuery={searchQuery}
          activePath={activePath}
          showSelectionControls={presentation === 'data-agent' && !isReadOnly}
          viewMode={effectiveViewMode}
          expandedDirs={expandedDirs}
          dropTarget={upload.dropTarget}
          selectedPaths={selectedPaths}
          internalDropTarget={internalDropTarget}
          focusedDirectoryPath={focusedDirectoryPath}
          onSelectionChange={isReadOnly ? undefined : handleSelectionChange}
          onInternalDragStart={isReadOnly ? undefined : handleInternalDragStart}
          onInternalDragOver={isReadOnly ? undefined : handleInternalDragOver}
          onInternalDragLeave={isReadOnly ? undefined : (_item, event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setInternalDropTarget(null);
          }}
          onInternalDrop={isReadOnly ? undefined : handleInternalDrop}
          onItemClick={handleItemClick}
          renderFileIcon={renderFileIcon}
          formatFileSize={formatFileSize}
          formatRelativeTime={formatRelativeTimeLabel}
          onRename={isReadOnly ? undefined : operations.handleStartRename}
          onDelete={isReadOnly ? undefined : operations.handleStartDelete}
          onNewFile={isReadOnly ? undefined : (path) => operations.handleStartCreate(path, 'file')}
          onNewFolder={isReadOnly ? undefined : (path) => operations.handleStartCreate(path, 'directory')}
          onCopyPath={operations.handleCopyPath}
          onDownload={operations.handleDownload}
          onMove={isReadOnly ? undefined : operations.handleStartMove}
          onUpload={isReadOnly ? undefined : upload.openFilePicker}
          onUploadFolder={isReadOnly ? undefined : upload.openFolderPicker}
          onRefresh={refreshWorkspaceFiles}
          // Pass rename state and handlers for inline editing
          renamingItem={operations.renamingItem}
          renameValue={operations.renameValue}
          setRenameValue={operations.setRenameValue}
          handleConfirmRename={operations.handleConfirmRename}
          handleCancelRename={operations.handleCancelRename}
          renameInputRef={renameInputRef}
          operationLoading={operations.operationLoading || upload.operationLoading}
          isCreating={operations.isCreating}
          newItemParent={operations.newItemParent}
          newItemType={operations.newItemType}
          newItemName={operations.newItemName}
          setNewItemName={operations.setNewItemName}
          handleConfirmCreate={operations.handleConfirmCreate}
          handleCancelCreate={operations.handleCancelCreate}
          newItemInputRef={newItemInputRef}
        />
        </div>
      </ScrollArea>

      {selectedImage && (
        <ImageViewer
          file={selectedImage}
          onClose={() => setSelectedImage(null)}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {operations.deleteConfirmation.isOpen && operations.deleteConfirmation.item && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="mx-4 max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-full bg-red-100 p-2 dark:bg-red-900/30">
                <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <h3 className="font-medium text-foreground">
                  {t('fileTree.delete.title', 'Delete {{type}}', {
                    type: operations.deleteConfirmation.item.type === 'directory' ? 'Folder' : 'File'
                  })}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {operations.deleteConfirmation.item.name}
                </p>
              </div>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              {operations.deleteConfirmation.item.type === 'directory'
                ? t('fileTree.delete.folderWarning', 'This folder and all its contents will be permanently deleted.')
                : t('fileTree.delete.fileWarning', 'This file will be permanently deleted.')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={operations.handleCancelDelete}
                disabled={operations.operationLoading}
                className="rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent"
              >
                {t('fileTree.upload.overwriteCancel', 'Cancel')}
              </button>
              <button
                onClick={operations.handleConfirmDelete}
                disabled={operations.operationLoading}
                className="flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-red-700 disabled:opacity-50"
              >
                {operations.operationLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('fileTree.delete.confirm', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Upload Overwrite Confirmation Dialog */}
      {upload.overwriteDialog.isOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-lg rounded-lg border border-border bg-background p-4 shadow-lg">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-full bg-amber-100 p-2 dark:bg-amber-900/30">
                <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <h3 className="font-medium text-foreground">
                  {t('fileTree.upload.overwriteTitle', 'Overwrite existing files')}
                </h3>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {t('fileTree.upload.overwriteWarning', 'The following files already exist in the target folder and will be overwritten:')}
                </p>
              </div>
            </div>
            <div className="mb-4 max-h-48 overflow-auto rounded border border-border bg-muted/20 p-3">
              {upload.overwriteDialog.duplicates.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {upload.overwriteDialog.duplicates.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
              )}
              {upload.overwriteDialog.tooMany > 0 && (
                <p className="mt-2 text-sm text-muted-foreground">
                  {t('fileTree.upload.overwriteMore', '{{count}} more', { count: upload.overwriteDialog.tooMany })}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={upload.handleCancelOverwrite}
                disabled={operations.operationLoading || upload.operationLoading}
                className="rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent"
              >
                {t('fileTree.upload.overwriteCancel', 'Cancel')}
              </button>
              <button
                onClick={upload.handleConfirmOverwrite}
                disabled={operations.operationLoading || upload.operationLoading}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {upload.operationLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  t('fileTree.upload.overwriteConfirm', 'Continue upload')
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Move Dialog */}
      {operations.moveDialog.isOpen && operations.moveDialog.item && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-lg">
            <div className="mb-4">
              <h3 className="font-medium text-foreground">
                {t('fileTree.move.title', 'Move {{type}}', {
                  type: operations.moveDialog.item.type === 'directory' ? 'Folder' : 'File',
                })}
              </h3>
              <p className="mt-1 truncate text-sm text-muted-foreground">
                {getFileTreeDisplayPath(operations.moveDialog.item.path, selectedProject)}
              </p>
            </div>
            <label className="mb-2 block text-sm font-medium text-foreground">
              {t('fileTree.move.targetDirectory', 'Target directory')}
            </label>
            <Input
              type="text"
              value={operations.moveDialog.targetDirectory}
              onChange={(event) => operations.setMoveTargetDirectory(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') operations.handleConfirmMove();
                if (event.key === 'Escape') operations.handleCancelMove();
              }}
              placeholder={t('fileTree.move.rootPlaceholder', 'Must start with /workspace, e.g. /workspace or /workspace/docs/examples')}
              disabled={operations.operationLoading}
              className="mb-4"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={operations.handleCancelMove}
                disabled={operations.operationLoading}
                className="rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent"
              >
                {t('fileTree.upload.overwriteCancel', 'Cancel')}
              </button>
              <button
                onClick={operations.handleConfirmMove}
                disabled={operations.operationLoading}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {operations.operationLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  t('fileTree.move.confirm', 'Move')
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {batchMoveOpen && selectedItems.length > 0 && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-lg">
            <h3 className="mb-1 font-medium">{t('fileTree.move.selectedTitle', 'Move selected items')}</h3>
            <p className="mb-4 text-sm text-muted-foreground">{t('fileTree.selectedCount', '{{count}} selected', { count: selectedItems.length })}</p>
            <Input value={batchTargetDirectory} onChange={(event) => setBatchTargetDirectory(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void moveItems(selectedItems, batchTargetDirectory); if (event.key === 'Escape') setBatchMoveOpen(false); }}
              disabled={batchLoading} autoFocus className="mb-4" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setBatchMoveOpen(false)} disabled={batchLoading} className="rounded-md px-3 py-1.5 text-sm hover:bg-accent">{t('fileTree.upload.overwriteCancel', 'Cancel')}</button>
              <button onClick={() => void moveItems(selectedItems, batchTargetDirectory)} disabled={batchLoading}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">
                {batchLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : t('fileTree.move.confirm', 'Move')}
              </button>
            </div>
          </div>
        </div>
      )}

      {batchDeleteOpen && selectedItems.length > 0 && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="mx-4 max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg">
            <h3 className="mb-2 font-medium">{t('fileTree.delete.selectedTitle', 'Delete selected items')}</h3>
            <p className="mb-4 text-sm text-muted-foreground">
              {t('fileTree.delete.selectedWarning', '{{count}} selected item(s) and all contents of selected folders will be permanently deleted.', { count: selectedItems.length })}
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setBatchDeleteOpen(false)} disabled={batchLoading} className="rounded-md px-3 py-1.5 text-sm hover:bg-accent">{t('fileTree.upload.overwriteCancel', 'Cancel')}</button>
              <button onClick={() => void deleteSelectedItems()} disabled={batchLoading}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">
                {batchLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : t('fileTree.delete.confirm', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div
          className={cn(
            'fixed bottom-4 right-4 z-[9999] px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-in slide-in-from-bottom-2',
            toast.type === 'success'
              ? 'bg-green-600 text-white'
              : 'bg-red-600 text-white'
          )}
        >
          {toast.type === 'success' ? (
            <Check className="h-4 w-4" />
          ) : (
            <X className="h-4 w-4" />
          )}
          <span className="text-sm">{toast.message}</span>
        </div>
      )}
    </div>
  );
}
