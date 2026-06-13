import type { ReactNode, RefObject } from 'react';

import type { FileTreeNode as FileTreeNodeType, FileTreeViewMode } from '../types/types';

import FileTreeNode from './FileTreeNode';

type FileTreeListProps = {
  items: FileTreeNodeType[];
  viewMode: FileTreeViewMode;
  expandedDirs: Set<string>;
  dropTarget?: string | null;
  onItemClick: (item: FileTreeNodeType) => void;
  renderFileIcon: (filename: string) => ReactNode;
  formatFileSize: (bytes?: number) => string;
  formatRelativeTime: (date?: string) => string;
  onRename?: (item: FileTreeNodeType) => void;
  onDelete?: (item: FileTreeNodeType) => void;
  onNewFile?: (path: string) => void;
  onNewFolder?: (path: string) => void;
  onCopyPath?: (item: FileTreeNodeType) => void;
  onDownload?: (item: FileTreeNodeType) => void;
  onMove?: (item: FileTreeNodeType) => void;
  onUpload?: (path: string) => void;
  onUploadFolder?: (path: string) => void;
  onRefresh?: () => void;
  // Rename state for inline editing
  renamingItem?: FileTreeNodeType | null;
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

export default function FileTreeList({
  items,
  viewMode,
  expandedDirs,
  dropTarget,
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
}: FileTreeListProps) {
  return (
    <div>
      {items.map((item) => (
        <FileTreeNode
          key={item.path}
          item={item}
          level={0}
          viewMode={viewMode}
          expandedDirs={expandedDirs}
          dropTarget={dropTarget}
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
      ))}
    </div>
  );
}
