import { useCallback, useEffect, useState } from 'react';

import {
  FILE_TREE_DEFAULT_VIEW_MODE,
  FILE_TREE_VIEW_MODES,
  FILE_TREE_VIEW_MODE_STORAGE_KEY,
} from '../constants/constants';
import type { FileTreeViewMode } from '../types/types';

type UseFileTreeViewModeResult = {
  viewMode: FileTreeViewMode;
  changeViewMode: (mode: FileTreeViewMode) => void;
};

type UseFileTreeViewModeOptions = {
  defaultMode?: FileTreeViewMode;
  storageKey?: string;
};

export function useFileTreeViewMode(options: UseFileTreeViewModeOptions = {}): UseFileTreeViewModeResult {
  const defaultMode = options.defaultMode ?? FILE_TREE_DEFAULT_VIEW_MODE;
  const storageKey = options.storageKey ?? FILE_TREE_VIEW_MODE_STORAGE_KEY;
  const [viewMode, setViewMode] = useState<FileTreeViewMode>(defaultMode);

  useEffect(() => {
    try {
      const savedViewMode = localStorage.getItem(storageKey);
      if (savedViewMode && FILE_TREE_VIEW_MODES.includes(savedViewMode as FileTreeViewMode)) {
        setViewMode(savedViewMode as FileTreeViewMode);
      }
    } catch {
      // Keep default view mode when storage is unavailable.
    }
  }, [defaultMode, storageKey]);

  const changeViewMode = useCallback((mode: FileTreeViewMode) => {
    setViewMode(mode);

    try {
      localStorage.setItem(storageKey, mode);
    } catch {
      // Keep runtime state even when persistence fails.
    }
  }, [storageKey]);

  return {
    viewMode,
    changeViewMode,
  };
}
