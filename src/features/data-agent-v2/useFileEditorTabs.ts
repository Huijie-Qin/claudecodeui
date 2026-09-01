import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import type { CodeEditorHandle } from '../../components/code-editor/view/CodeEditor';
import { subscribeProjectFilesChanged } from '../../components/file-tree/utils/fileTreeEvents';
import type { Project } from '../../types/app';

import {
  createFileEditorTab,
  fileEditorTabsReducer,
  getFileTabsStorageKey,
  isFileTabWithinPath,
  normalizeFileTabPath,
  parsePersistedFileEditorTabs,
  replaceFileTabPathPrefix,
  serializeFileEditorTabs,
  type FileEditorTab,
  type FileEditorTabsState,
} from './fileEditorTabs';

const EMPTY_STATE: FileEditorTabsState = { tabs: [], activeId: null };

function readInitialState(project: Project): FileEditorTabsState {
  try {
    const persisted = parsePersistedFileEditorTabs(localStorage.getItem(getFileTabsStorageKey(project)));
    if (!persisted) return EMPTY_STATE;
    const tabs = persisted.paths.map((path) => createFileEditorTab(project, path));
    const activeId = tabs.find((tab) => tab.displayPath === persisted.activePath)?.id ?? tabs[0]?.id ?? null;
    return { tabs, activeId };
  } catch {
    return EMPTY_STATE;
  }
}

export type UseFileEditorTabsResult = {
  tabs: FileEditorTab[];
  activeTab: FileEditorTab | null;
  visitedIds: Set<string>;
  openFile: (path: string) => void;
  activateTab: (id: string) => void;
  reorderTabs: (sourceId: string, targetId: string) => void;
  requestCloseTabs: (ids: string[]) => Promise<boolean>;
  closeOtherTabs: (id: string) => Promise<void>;
  closeTabsToRight: (id: string) => Promise<void>;
  closeAllTabs: () => Promise<void>;
  registerEditor: (id: string, handle: CodeEditorHandle | null) => void;
  setTabDirty: (id: string, dirty: boolean) => void;
  beforeFileMutation: (paths: string[]) => Promise<boolean>;
};

export function useFileEditorTabs(project: Project): UseFileEditorTabsResult {
  const [state, dispatch] = useReducer(fileEditorTabsReducer, project, readInitialState);
  const [visitedIds, setVisitedIds] = useState<Set<string>>(
    () => new Set(state.activeId ? [state.activeId] : []),
  );
  const stateRef = useRef(state);
  const editorHandlesRef = useRef(new Map<string, CodeEditorHandle>());
  stateRef.current = state;

  useEffect(() => {
    try {
      localStorage.setItem(getFileTabsStorageKey(project), JSON.stringify(serializeFileEditorTabs(state)));
    } catch {
      // Keep in-memory tabs when browser storage is unavailable.
    }
  }, [project, state]);

  useEffect(() => subscribeProjectFilesChanged((event) => {
    if (event.workspaceId != null && String(event.workspaceId) !== String(project.workspaceId)) return;
    if (event.projectName && event.projectName !== project.name) return;

    const current = stateRef.current;
    if (event.reason === 'delete' && event.deletedPaths?.length) {
      const ids = current.tabs
        .filter((tab) => event.deletedPaths?.some((path) => isFileTabWithinPath(tab.displayPath, path)))
        .map((tab) => tab.id);
      if (ids.length) dispatch({ type: 'close', ids });
      return;
    }

    if (!event.pathChanges?.length) return;
    const idChanges = new Map<string, string>();
    const tabs = current.tabs.map((tab) => {
      let nextPath = tab.displayPath;
      event.pathChanges?.forEach((change) => {
        nextPath = replaceFileTabPathPrefix(nextPath, change.oldPath, change.newPath);
      });
      if (nextPath === tab.displayPath) return tab;
      const nextTab = createFileEditorTab(project, nextPath);
      idChanges.set(tab.id, nextTab.id);
      return { ...nextTab, dirty: tab.dirty };
    });
    if (!idChanges.size) return;
    const activeId = current.activeId ? idChanges.get(current.activeId) ?? current.activeId : null;
    setVisitedIds((previous) => new Set(Array.from(previous, (id) => idChanges.get(id) ?? id)));
    dispatch({ type: 'replace', tabs, activeId });
  }), [project]);

  const openFile = useCallback((path: string) => {
    const tab = createFileEditorTab(project, path);
    dispatch({ type: 'open', tab });
    setVisitedIds((previous) => new Set(previous).add(tab.id));
  }, [project]);

  const activateTab = useCallback((id: string) => {
    dispatch({ type: 'activate', id });
    setVisitedIds((previous) => new Set(previous).add(id));
  }, []);

  const reorderTabs = useCallback((sourceId: string, targetId: string) => {
    dispatch({ type: 'reorder', sourceId, targetId });
  }, []);

  const registerEditor = useCallback((id: string, handle: CodeEditorHandle | null) => {
    if (handle) editorHandlesRef.current.set(id, handle);
    else editorHandlesRef.current.delete(id);
  }, []);

  const setTabDirty = useCallback((id: string, dirty: boolean) => {
    dispatch({ type: 'dirty', id, dirty });
  }, []);

  const saveTabs = useCallback(async (ids: string[]) => {
    const current = stateRef.current;
    const results = await Promise.all(ids.map(async (id) => {
      const tab = current.tabs.find((candidate) => candidate.id === id);
      if (!tab?.dirty) return { id, saved: true };
      const editor = editorHandlesRef.current.get(id);
      return { id, saved: editor ? await editor.save() : false };
    }));
    return {
      savedIds: results.filter((result) => result.saved).map((result) => result.id),
      failedIds: results.filter((result) => !result.saved).map((result) => result.id),
    };
  }, []);

  const requestCloseTabs = useCallback(async (ids: string[]) => {
    const uniqueIds = Array.from(new Set(ids));
    if (!uniqueIds.length) return true;
    const { savedIds, failedIds } = await saveTabs(uniqueIds);
    if (savedIds.length) {
      dispatch({ type: 'close', ids: savedIds });
      setVisitedIds((previous) => {
        const next = new Set(previous);
        savedIds.forEach((id) => next.delete(id));
        return next;
      });
    }
    if (failedIds.length) activateTab(failedIds[0]);
    return failedIds.length === 0;
  }, [activateTab, saveTabs]);

  const closeOtherTabs = useCallback(async (id: string) => {
    const closed = await requestCloseTabs(stateRef.current.tabs.filter((tab) => tab.id !== id).map((tab) => tab.id));
    if (closed) activateTab(id);
  }, [activateTab, requestCloseTabs]);

  const closeTabsToRight = useCallback(async (id: string) => {
    const current = stateRef.current.tabs;
    const index = current.findIndex((tab) => tab.id === id);
    if (index >= 0) await requestCloseTabs(current.slice(index + 1).map((tab) => tab.id));
  }, [requestCloseTabs]);

  const closeAllTabs = useCallback(async () => {
    await requestCloseTabs(stateRef.current.tabs.map((tab) => tab.id));
  }, [requestCloseTabs]);

  const beforeFileMutation = useCallback(async (paths: string[]) => {
    const normalizedPaths = paths.map(normalizeFileTabPath);
    const affectedIds = stateRef.current.tabs
      .filter((tab) => normalizedPaths.some((path) => isFileTabWithinPath(tab.displayPath, path)))
      .map((tab) => tab.id);
    const { failedIds } = await saveTabs(affectedIds);
    return failedIds.length === 0;
  }, [saveTabs]);

  const activeTab = useMemo(
    () => state.tabs.find((tab) => tab.id === state.activeId) ?? null,
    [state.activeId, state.tabs],
  );

  return {
    tabs: state.tabs,
    activeTab,
    visitedIds,
    openFile,
    activateTab,
    reorderTabs,
    requestCloseTabs,
    closeOtherTabs,
    closeTabsToRight,
    closeAllTabs,
    registerEditor,
    setTabDirty,
    beforeFileMutation,
  };
}
