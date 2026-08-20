import type { DragEvent, ReactNode, RefObject } from 'react';
import { Folder, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FileTreeNode, FileTreeViewMode } from '../types/types';

import FileTreeEmptyState from './FileTreeEmptyState';
import FileTreeList from './FileTreeList';

type FileTreeBodyProps = {
  files: FileTreeNode[];
  filteredFiles: FileTreeNode[];
  searchQuery: string;
  viewMode: FileTreeViewMode;
  expandedDirs: Set<string>;
  dropTarget?: string | null;
  selectedPaths?: Set<string>;
  internalDropTarget?: string | null;
  focusedDirectoryPath?: string | null;
  onSelectionChange?: (item: FileTreeNode, additive: boolean) => void;
  onInternalDragStart?: (item: FileTreeNode, event: DragEvent<HTMLDivElement>) => void;
  onInternalDragOver?: (item: FileTreeNode, event: DragEvent<HTMLDivElement>) => void;
  onInternalDragLeave?: (item: FileTreeNode, event: DragEvent<HTMLDivElement>) => void;
  onInternalDrop?: (item: FileTreeNode, event: DragEvent<HTMLDivElement>) => void;
  onItemClick: (item: FileTreeNode) => void;
  renderFileIcon: (filename: string) => ReactNode;
  formatFileSize: (bytes?: number) => string;
  formatRelativeTime: (date?: string) => string;
  onRename?: (item: FileTreeNode) => void;
  onDelete?: (item: FileTreeNode) => void;
  onNewFile?: (path: string) => void;
  onNewFolder?: (path: string) => void;
  onCopyPath?: (item: FileTreeNode) => void;
  onDownload?: (item: FileTreeNode) => void;
  onMove?: (item: FileTreeNode) => void;
  onUpload?: (path: string) => void;
  onUploadFolder?: (path: string) => void;
  onRefresh?: () => void;
  // Rename state for inline editing
  renamingItem?: FileTreeNode | null;
  renameValue?: string;
  setRenameValue?: (value: string) => void;
  handleConfirmRename?: () => void;
  handleCancelRename?: () => void;
  renameInputRef?: RefObject<HTMLInputElement>;
  operationLoading?: boolean;
  isCreating?: boolean;
  newItemParent?: string;
  newItemType?: 'file' | 'directory';
  newItemName?: string;
  setNewItemName?: (name: string) => void;
  handleConfirmCreate?: () => void;
  handleCancelCreate?: () => void;
  newItemInputRef?: RefObject<HTMLInputElement>;
};

export default function FileTreeBody({
  files,
  filteredFiles,
  searchQuery,
  viewMode,
  expandedDirs,
  dropTarget,
  selectedPaths,
  internalDropTarget,
  focusedDirectoryPath,
  onSelectionChange,
  onInternalDragStart,
  onInternalDragOver,
  onInternalDragLeave,
  onInternalDrop,
  onItemClick,
  renderFileIcon,
  formatFileSize,
  formatRelativeTime,
  onRename,
  onDelete,
  onNewFile,
  onNewFolder,
  onCopyPath,
  onDownload,
  onMove,
  onUpload,
  onUploadFolder,
  onRefresh,
  renamingItem,
  renameValue,
  setRenameValue,
  handleConfirmRename,
  handleCancelRename,
  renameInputRef,
  operationLoading,
  isCreating,
  newItemParent,
  newItemType,
  newItemName,
  setNewItemName,
  handleConfirmCreate,
  handleCancelCreate,
  newItemInputRef,
}: FileTreeBodyProps) {
  const { t } = useTranslation();

  return (
    <>
      {files.length === 0 ? (
        <FileTreeEmptyState
          icon={Folder}
          title={t('fileTree.noFilesFound')}
          description={t('fileTree.checkProjectPath')}
        />
      ) : filteredFiles.length === 0 && searchQuery ? (
        <FileTreeEmptyState
          icon={Search}
          title={t('fileTree.noMatchesFound')}
          description={t('fileTree.tryDifferentSearch')}
        />
      ) : (
        <FileTreeList
          items={filteredFiles}
          viewMode={viewMode}
          expandedDirs={expandedDirs}
          dropTarget={dropTarget}
          selectedPaths={selectedPaths}
          internalDropTarget={internalDropTarget}
          focusedDirectoryPath={focusedDirectoryPath}
          onSelectionChange={onSelectionChange}
          onInternalDragStart={onInternalDragStart}
          onInternalDragOver={onInternalDragOver}
          onInternalDragLeave={onInternalDragLeave}
          onInternalDrop={onInternalDrop}
          onItemClick={onItemClick}
          renderFileIcon={renderFileIcon}
          formatFileSize={formatFileSize}
          formatRelativeTime={formatRelativeTime}
          onRename={onRename}
          onDelete={onDelete}
          onNewFile={onNewFile}
          onNewFolder={onNewFolder}
          onCopyPath={onCopyPath}
          onDownload={onDownload}
          onMove={onMove}
          onUpload={onUpload}
          onUploadFolder={onUploadFolder}
          onRefresh={onRefresh}
          renamingItem={renamingItem}
          renameValue={renameValue}
          setRenameValue={setRenameValue}
          handleConfirmRename={handleConfirmRename}
          handleCancelRename={handleCancelRename}
          renameInputRef={renameInputRef}
          operationLoading={operationLoading}
          isCreating={isCreating}
          newItemParent={newItemParent}
          newItemType={newItemType}
          newItemName={newItemName}
          setNewItemName={setNewItemName}
          handleConfirmCreate={handleConfirmCreate}
          handleCancelCreate={handleCancelCreate}
          newItemInputRef={newItemInputRef}
        />
      )}
    </>
  );
}
