import { useCallback, useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, X, Loader2, Folder, Upload } from 'lucide-react';

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

import FileTreeBody from './FileTreeBody';
import FileTreeDetailedColumns from './FileTreeDetailedColumns';
import FileTreeHeader from './FileTreeHeader';
import FileTreeLoadingState from './FileTreeLoadingState';
import ImageViewer from './ImageViewer';


type FileTreeProps = {
  selectedProject: Project | null;
  onFileOpen?: (filePath: string) => void;
  isReadOnly?: boolean;
};

export default function FileTree({ selectedProject, onFileOpen, isReadOnly = false }: FileTreeProps) {
  const { t } = useTranslation();
  const [selectedImage, setSelectedImage] = useState<FileTreeImageSelection | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
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
  const { viewMode, changeViewMode } = useFileTreeViewMode();
  const { expandedDirs, toggleDirectory, expandDirectories, collapseAll } = useExpandedDirectories();
  const { searchQuery, setSearchQuery, filteredFiles } = useFileTreeSearch({
    files,
    expandDirectories,
  });

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
        toggleDirectory(item.path);
        return;
      }

      if (isImageFile(item.name) && selectedProject) {
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
    [onFileOpen, selectedProject, toggleDirectory],
  );

  const formatRelativeTimeLabel = useCallback(
    (date?: string) => formatRelativeTime(date, t),
    [t],
  );

  if (loading) {
    return <FileTreeLoadingState />;
  }

  return (
    <div
      ref={upload.treeRef}
      className="relative flex h-full flex-col bg-background"
      onDragEnter={isReadOnly ? undefined : upload.handleDragEnter}
      onDragOver={isReadOnly ? undefined : upload.handleDragOver}
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
        viewMode={viewMode}
        onViewModeChange={changeViewMode}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onNewFile={isReadOnly ? undefined : () => operations.handleStartCreate('', 'file')}
        onNewFolder={isReadOnly ? undefined : () => operations.handleStartCreate('', 'directory')}
        onUpload={isReadOnly ? undefined : () => upload.openFilePicker('')}
        onUploadFolder={isReadOnly ? undefined : () => upload.openFolderPicker('')}
        onRefresh={refreshWorkspaceFiles}
        onCollapseAll={collapseAll}
        loading={loading}
        operationLoading={operations.operationLoading || upload.operationLoading}
        quota={quota}
        quotaLoading={quotaLoading}
      />

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

      {viewMode === 'detailed' && filteredFiles.length > 0 && <FileTreeDetailedColumns />}

      <ScrollArea className="flex-1 px-2 py-1">
        {/* New item input */}
        {operations.isCreating && (
          <div
            className="mb-1 flex items-center gap-1.5 py-[3px] pr-2"
            style={{ paddingLeft: `${(operations.newItemParent.split('/').length - 1) * 16 + 4}px` }}
          >
            {operations.newItemType === 'directory' ? (
              <Folder className={cn(ICON_SIZE_CLASS, 'text-blue-500')} />
            ) : (
              <span className="ml-[18px]">{renderFileIcon(operations.newItemName)}</span>
            )}
            <Input
              ref={newItemInputRef}
              type="text"
              value={operations.newItemName}
              onChange={(e) => operations.setNewItemName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') operations.handleConfirmCreate();
                if (e.key === 'Escape') operations.handleCancelCreate();
              }}
              onBlur={() => {
                setTimeout(() => {
                  if (operations.isCreating) operations.handleConfirmCreate();
                }, 100);
              }}
              className="h-6 flex-1 text-sm"
              disabled={operations.operationLoading}
            />
          </div>
        )}

        <FileTreeBody
          files={files}
          filteredFiles={filteredFiles}
          searchQuery={searchQuery}
          viewMode={viewMode}
          expandedDirs={expandedDirs}
          dropTarget={upload.dropTarget}
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
        />
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
              placeholder={t('fileTree.move.rootPlaceholder', 'Leave empty for project root, or enter docs/examples')}
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
