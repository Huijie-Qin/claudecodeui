import type { DragEvent, ReactNode, RefObject } from 'react';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';

import { cn } from '../../../lib/utils';
import { FILE_TREE_DROP_TARGET_ATTRIBUTE } from '../constants/constants';
import type { FileTreeNode as FileTreeNodeType, FileTreeViewMode } from '../types/types';
import { Input } from '../../../shared/view/ui';

import FileContextMenu from './FileContextMenu';
import FileTreeCreateInput from './FileTreeCreateInput';

type FileTreeNodeProps = {
  item: FileTreeNodeType;
  activePath?: string | null;
  showSelectionControls?: boolean;
  level: number;
  viewMode: FileTreeViewMode;
  expandedDirs: Set<string>;
  dropTarget?: string | null;
  selectedPaths?: Set<string>;
  internalDropTarget?: string | null;
  focusedDirectoryPath?: string | null;
  onSelectionChange?: (item: FileTreeNodeType, additive: boolean) => void;
  onInternalDragStart?: (item: FileTreeNodeType, event: DragEvent<HTMLDivElement>) => void;
  onInternalDragOver?: (item: FileTreeNodeType, event: DragEvent<HTMLDivElement>) => void;
  onInternalDragLeave?: (item: FileTreeNodeType, event: DragEvent<HTMLDivElement>) => void;
  onInternalDrop?: (item: FileTreeNodeType, event: DragEvent<HTMLDivElement>) => void;
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
  onMoveSelection?: () => void;
  onDeleteSelection?: () => void;
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

type TreeItemIconProps = {
  item: FileTreeNodeType;
  isOpen: boolean;
  renderFileIcon: (filename: string) => ReactNode;
};

function TreeItemIcon({ item, isOpen, renderFileIcon }: TreeItemIconProps) {
  if (item.type === 'directory') {
    return (
      <span className="flex flex-shrink-0 items-center gap-0.5">
        <ChevronRight
          className={cn(
            'w-3.5 h-3.5 text-muted-foreground/70 transition-transform duration-150',
            isOpen && 'rotate-90',
          )}
        />
        {isOpen ? (
          <FolderOpen className="h-4 w-4 flex-shrink-0 text-blue-500" />
        ) : (
          <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        )}
      </span>
    );
  }

  return <span className="ml-[18px] flex flex-shrink-0 items-center">{renderFileIcon(item.name)}</span>;
}

export default function FileTreeNode({
  item,
  activePath,
  showSelectionControls = false,
  level,
  viewMode,
  expandedDirs,
  dropTarget,
  selectedPaths = new Set(),
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
  onMoveSelection,
  onDeleteSelection,
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
}: FileTreeNodeProps) {
  const isDirectory = item.type === 'directory';
  const isOpen = isDirectory && expandedDirs.has(item.path);
  const hasChildren = Boolean(isDirectory && item.children && item.children.length > 0);
  const isRenaming = renamingItem?.path === item.path;
  const isDropTarget = isDirectory && dropTarget === item.path;
  const isSelected = selectedPaths.has(item.path);
  const isFocusedDirectory = isDirectory && focusedDirectoryPath === item.path;
  const isInternalDropTarget = isDirectory && internalDropTarget === item.path;
  const normalizedItemPath = String(item.path || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/g, '');
  const normalizedActivePath = String(activePath || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/g, '');
  const itemWorkspaceSuffix = normalizedItemPath.replace(/^.*\/workspace(?=\/|$)/, '');
  const activeWorkspaceSuffix = normalizedActivePath.replace(/^.*\/workspace(?=\/|$)/, '');
  const isActive = Boolean(normalizedActivePath) && (
    normalizedItemPath === normalizedActivePath
    || (Boolean(itemWorkspaceSuffix) && itemWorkspaceSuffix === activeWorkspaceSuffix)
    || (Boolean(activeWorkspaceSuffix) && normalizedItemPath.endsWith(activeWorkspaceSuffix))
  );
  const shouldRenderCreateInput = Boolean(isDirectory && isCreating && newItemParent === item.path);
  const shouldRenderChildren = Boolean(isDirectory && (shouldRenderCreateInput || (isOpen && hasChildren)));
  const dropTargetAttributes: Record<string, string> = isDirectory
    ? { [FILE_TREE_DROP_TARGET_ATTRIBUTE]: item.path }
    : {};

  const nameClassName = cn(
    'text-[13px] leading-tight truncate',
    isDirectory ? 'font-medium text-foreground' : 'text-foreground/90',
  );

  // View mode only changes the row layout; selection, expansion, and recursion stay shared.
  const rowClassName = cn(
    'data-agent-file-row',
    viewMode === 'detailed'
      ? 'group grid grid-cols-12 gap-2 py-[3px] pr-2 hover:bg-accent/60 cursor-pointer items-center rounded-sm transition-colors duration-100'
      : viewMode === 'compact'
      ? 'group flex items-center justify-between py-[3px] pr-2 hover:bg-accent/60 cursor-pointer rounded-sm transition-colors duration-100'
      : 'group flex items-center gap-1.5 py-[3px] pr-2 cursor-pointer rounded-sm hover:bg-accent/60 transition-colors duration-100',
    isDirectory && isOpen && 'border-l-2 border-primary/30',
    (isDirectory && !isOpen) || !isDirectory ? 'border-l-2 border-transparent' : '',
    isDropTarget && 'bg-blue-500/15 ring-1 ring-inset ring-blue-500/50',
    isSelected && 'bg-primary/15 ring-1 ring-inset ring-primary/40',
    isFocusedDirectory && 'bg-primary/10 ring-1 ring-inset ring-primary/30',
    isActive && !isSelected && 'data-file-tree-active',
    isDirectory ? 'is-directory' : 'is-file',
    isSelected && 'is-batch-selected',
    isActive && 'is-current-file',
    isInternalDropTarget && 'bg-green-500/15 ring-1 ring-inset ring-green-500/60',
  );

  // Render rename input if this item is being renamed
  if (isRenaming && setRenameValue && handleConfirmRename && handleCancelRename) {
    const renameInput = (
      <Input
        ref={renameInputRef}
        type="text"
        value={renameValue || ''}
        onChange={(e) => setRenameValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') handleConfirmRename();
          if (e.key === 'Escape') handleCancelRename();
        }}
        onBlur={() => {
          setTimeout(() => {
            handleConfirmRename();
          }, 100);
        }}
        className="h-6 min-w-0 flex-1 text-sm"
        disabled={operationLoading}
      />
    );

    return (
      <div
        className={cn(rowClassName, 'bg-accent/30')}
        {...dropTargetAttributes}
        style={{ paddingLeft: `${level * 16 + 4}px` }}
        onClick={(e) => e.stopPropagation()}
      >
        {viewMode === 'detailed' ? (
          <div className="col-span-12 flex min-w-0 items-center gap-1.5">
            <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
            {renameInput}
          </div>
        ) : (
          <>
            <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
            {renameInput}
          </>
        )}
      </div>
    );
  }

  const selectionControl = showSelectionControls ? (
    <input
      type="checkbox"
      checked={isSelected}
      aria-label={`选择 ${item.name}`}
      className="data-agent-file-selection"
      onChange={() => onSelectionChange?.(item, true)}
      onClick={(event) => event.stopPropagation()}
    />
  ) : null;

  const rowContent = (
    <div
      className={rowClassName}
      {...dropTargetAttributes}
      style={{ paddingLeft: `${level * 16 + 4}px` }}
      draggable={Boolean(onInternalDragStart)}
      onDragStart={(event) => onInternalDragStart?.(item, event)}
      onDragOver={(event) => onInternalDragOver?.(item, event)}
      onDragLeave={(event) => onInternalDragLeave?.(item, event)}
      onDrop={(event) => onInternalDrop?.(item, event)}
      onClick={(event) => {
        event.stopPropagation();
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          event.preventDefault();
          onSelectionChange?.(item, true);
          return;
        }
        onItemClick(item);
      }}
      aria-current={isActive ? 'true' : undefined}
    >
      {viewMode === 'detailed' ? (
        <>
          <div className="data-agent-file-name-cell col-span-5 flex min-w-0 items-center gap-1.5">
            {selectionControl}
            <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
            <span className={cn(nameClassName, 'data-agent-file-name')}>{item.name}</span>
          </div>
          <div className="data-agent-file-meta col-span-2 text-sm tabular-nums text-muted-foreground">
            {item.type === 'file' ? formatFileSize(item.size) : ''}
          </div>
          <div className="data-agent-file-meta col-span-3 text-sm text-muted-foreground">{formatRelativeTime(item.modified)}</div>
          <div className="data-agent-file-meta col-span-2 font-mono text-sm text-muted-foreground">{item.permissionsRwx || ''}</div>
        </>
      ) : viewMode === 'compact' ? (
        <>
          <div className="flex min-w-0 items-center gap-1.5">
            {selectionControl}
            <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
            <span className={cn(nameClassName, 'data-agent-file-name')}>{item.name}</span>
          </div>
          <div className="ml-2 flex flex-shrink-0 items-center gap-3 text-sm text-muted-foreground">
            {item.type === 'file' && (
              <>
                <span className="tabular-nums">{formatFileSize(item.size)}</span>
                <span className="font-mono">{item.permissionsRwx}</span>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          {selectionControl}
          <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
          <span className={cn(nameClassName, 'data-agent-file-name')}>{item.name}</span>
        </>
      )}
    </div>
  );

  // Check if context menu callbacks are provided
  const hasContextMenu = onRename || onDelete || onNewFile || onNewFolder || onCopyPath || onDownload || onMove || onUpload || onUploadFolder || onRefresh;

  return (
    <div className="select-none">
      {hasContextMenu ? (
        <FileContextMenu
          item={item}
          isMultiSelection={selectedPaths.size > 1 && isSelected}
          onMoveSelection={onMoveSelection}
          onDeleteSelection={onDeleteSelection}
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
        >
          {rowContent}
        </FileContextMenu>
      ) : (
        rowContent
      )}

      {shouldRenderChildren && (
        <div className="relative">
          <span
            className="absolute bottom-0 top-0 border-l border-border/40"
            style={{ left: `${level * 16 + 14}px` }}
            aria-hidden="true"
          />
          {shouldRenderCreateInput &&
            newItemType &&
            newItemName !== undefined &&
            setNewItemName &&
            handleConfirmCreate &&
            handleCancelCreate &&
            newItemInputRef && (
              <FileTreeCreateInput
                viewMode={viewMode}
                level={level + 1}
                newItemType={newItemType}
                newItemName={newItemName}
                setNewItemName={setNewItemName}
                handleConfirmCreate={handleConfirmCreate}
                handleCancelCreate={handleCancelCreate}
                newItemInputRef={newItemInputRef}
                operationLoading={operationLoading}
                renderFileIcon={renderFileIcon}
              />
            )}
          {isOpen && item.children?.map((child) => (
            <FileTreeNode
              key={child.path}
              item={child}
              activePath={activePath}
              showSelectionControls={showSelectionControls}
              level={level + 1}
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
              onMoveSelection={onMoveSelection}
              onDeleteSelection={onDeleteSelection}
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
      )}
    </div>
  );
}
