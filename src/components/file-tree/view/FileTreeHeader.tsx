import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Eye, FileText, FolderPlus, FolderUp, List, RefreshCw, Search, TableProperties, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import type { FileTreeViewMode, WorkspaceStorageQuota } from '../types/types';

type FileTreeHeaderProps = {
  viewMode: FileTreeViewMode;
  onViewModeChange: (mode: FileTreeViewMode) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  // Toolbar actions
  onNewFile?: () => void;
  onNewFolder?: () => void;
  onUpload?: () => void;
  onUploadFolder?: () => void;
  onSelectRoot?: () => void;
  onRefresh?: () => void;
  onCollapseAll?: () => void;
  // Loading state
  loading?: boolean;
  operationLoading?: boolean;
  quota?: WorkspaceStorageQuota | null;
  quotaLoading?: boolean;
};

function formatQuotaMb(bytes: number) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

export default function FileTreeHeader({
  viewMode,
  onViewModeChange,
  searchQuery,
  onSearchQueryChange,
  onNewFile,
  onNewFolder,
  onUpload,
  onUploadFolder,
  onSelectRoot,
  onRefresh,
  onCollapseAll,
  loading,
  operationLoading,
  quota,
  quotaLoading,
}: FileTreeHeaderProps) {
  const { t } = useTranslation();
  const [isUploadMenuOpen, setIsUploadMenuOpen] = useState(false);
  const uploadMenuRef = useRef<HTMLDivElement | null>(null);
  const hasUploadOptions = Boolean(onUpload && onUploadFolder);

  const closeUploadMenu = useCallback(() => {
    setIsUploadMenuOpen(false);
  }, []);

  const runUploadAction = useCallback((action?: () => void) => {
    closeUploadMenu();
    action?.();
  }, [closeUploadMenu]);

  useEffect(() => {
    if (!isUploadMenuOpen) {
      return;
    }

    const handleMouseDown = (event: MouseEvent) => {
      if (uploadMenuRef.current && !uploadMenuRef.current.contains(event.target as Node)) {
        closeUploadMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeUploadMenu();
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeUploadMenu, isUploadMenuOpen]);

  return (
    <div className="space-y-2 border-b border-border px-3 pb-2 pt-3">
      {/* Title and Toolbar */}
      <div className="flex items-center justify-between">
        <div>
          <button
            type="button"
            onClick={onSelectRoot}
            className="rounded-sm text-left text-sm font-medium text-foreground outline-none transition hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/30"
            title={t('fileTree.useProjectRoot', 'Use project root directory')}
          >
            {t('fileTree.files')}
          </button>
          <div className={cn(
            'mt-0.5 text-xs',
            quota?.exceeded ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted-foreground',
          )}>
            {quota ? (
              <>
                {t('fileTree.storageUsage', '{{used}} / {{total}} MB', {
                  used: formatQuotaMb(quota.usedBytes),
                  total: formatQuotaMb(quota.limitBytes),
                })}
                {quota.exceeded ? (
                  <span className="ml-2">
                    {t('fileTree.storageExceeded', 'Please clean up the current file space, or contact the administrator for expansion')}
                  </span>
                ) : null}
              </>
            ) : (
              quotaLoading ? t('fileTree.storageLoading', 'Calculating space...') : null
            )}
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          {/* Action buttons */}
          {onNewFile && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onNewFile}
              title={t('fileTree.newFile', 'New File (Cmd+N)')}
              aria-label={t('fileTree.newFile', 'New File (Cmd+N)')}
              disabled={operationLoading}
            >
              <FileText className="h-3.5 w-3.5" />
            </Button>
          )}
          {onNewFolder && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onNewFolder}
              title={t('fileTree.newFolder', 'New Folder (Cmd+Shift+N)')}
              aria-label={t('fileTree.newFolder', 'New Folder (Cmd+Shift+N)')}
              disabled={operationLoading}
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </Button>
          )}
          {(onUpload || onUploadFolder) && (
            <div ref={uploadMenuRef} className="relative">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => {
                  if (hasUploadOptions) {
                    setIsUploadMenuOpen((current) => !current);
                    return;
                  }
                  runUploadAction(onUpload || onUploadFolder);
                }}
                title={t('fileTree.upload', 'Upload')}
                aria-label={t('fileTree.upload', 'Upload')}
                aria-haspopup={hasUploadOptions ? 'menu' : undefined}
                aria-expanded={hasUploadOptions ? isUploadMenuOpen : undefined}
                disabled={operationLoading}
              >
                <Upload className="h-3.5 w-3.5" />
              </Button>

              {hasUploadOptions && isUploadMenuOpen && (
                <div
                  role="menu"
                  aria-label={t('fileTree.uploadMenu', 'Upload menu')}
                  className="absolute right-0 top-full z-50 mt-1 min-w-[170px] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
                    onClick={() => runUploadAction(onUpload)}
                  >
                    <Upload className="h-4 w-4" />
                    <span>{t('fileTree.uploadFiles', 'Upload Files')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
                    onClick={() => runUploadAction(onUploadFolder)}
                  >
                    <FolderUp className="h-4 w-4" />
                    <span>{t('fileTree.uploadFolder', 'Upload Folder')}</span>
                  </button>
                </div>
              )}
            </div>
          )}
          {onRefresh && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onRefresh}
              title={t('fileTree.refresh', 'Refresh')}
              aria-label={t('fileTree.refresh', 'Refresh')}
              disabled={operationLoading}
            >
              <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            </Button>
          )}
          {onCollapseAll && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onCollapseAll}
              title={t('fileTree.collapseAll', 'Collapse All')}
              aria-label={t('fileTree.collapseAll', 'Collapse All')}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          )}
          {/* Divider */}
          <div className="mx-0.5 h-4 w-px bg-border" />
          {/* View mode buttons */}
          <Button
            variant={viewMode === 'simple' ? 'default' : 'ghost'}
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onViewModeChange('simple')}
            title={t('fileTree.simpleView')}
            aria-label={t('fileTree.simpleView')}
          >
            <List className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant={viewMode === 'compact' ? 'default' : 'ghost'}
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onViewModeChange('compact')}
            title={t('fileTree.compactView')}
            aria-label={t('fileTree.compactView')}
          >
            <Eye className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant={viewMode === 'detailed' ? 'default' : 'ghost'}
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onViewModeChange('detailed')}
            title={t('fileTree.detailedView')}
            aria-label={t('fileTree.detailedView')}
          >
            <TableProperties className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="relative">
        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          placeholder={t('fileTree.searchPlaceholder')}
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          className="h-8 pl-8 pr-8 text-sm"
        />
        {searchQuery && (
          <Button
            variant="ghost"
            size="sm"
            className="absolute right-0.5 top-1/2 h-5 w-5 -translate-y-1/2 p-0 hover:bg-accent"
            onClick={() => onSearchQueryChange('')}
            title={t('fileTree.clearSearch')}
            aria-label={t('fileTree.clearSearch')}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}
