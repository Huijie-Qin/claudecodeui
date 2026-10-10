import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { IMAGE_FILE_EXTENSIONS } from '../../file-tree/constants/constants';
import { subscribeProjectFilesChanged } from '../../file-tree/utils/fileTreeEvents';
import type { Project } from '../../../types/app';
import type { CodeEditorFile } from '../types/types';
import type { CodeEditorHandle } from '../view/CodeEditor';

export type MainFileTab = {
  id: string;
  file: CodeEditorFile;
  displayPath: string;
  kind: 'editor' | 'image';
  dirty: boolean;
  isReadOnly: boolean;
  projectPath?: string;
  workspaceRoot: string;
};

type TabsState = { tabs: MainFileTab[]; activeId: string | null };
type TabsAction =
  | { type: 'open'; tab: MainFileTab }
  | { type: 'activate'; id: string }
  | { type: 'close'; ids: string[] }
  | { type: 'dirty'; id: string; dirty: boolean }
  | { type: 'replace'; tabs: MainFileTab[]; activeId: string | null }
  | { type: 'clear' };

const EMPTY_STATE: TabsState = { tabs: [], activeId: null };

function normalizePath(value: string): string {
  return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/g, '');
}

export function displayPathFor(file: CodeEditorFile, workspaceRoot: string): string {
  const existing = normalizePath(String(file.displayPath || ''));
  if (existing.startsWith('/workspace/')) return existing;
  const path = normalizePath(file.path);
  if (workspaceRoot && path.startsWith(`${workspaceRoot}/`)) {
    return `/workspace/${path.slice(workspaceRoot.length + 1)}`;
  }
  if (path.startsWith('/workspace/')) return path;
  return `/workspace/${path.replace(/^\/+/, '')}`;
}

function tabWithinPath(tabPath: string, parentPath: string): boolean {
  const tab = normalizePath(tabPath);
  const parent = normalizePath(parentPath);
  return tab === parent || tab.startsWith(`${parent}/`);
}

export function replacePathPrefix(path: string, oldPath: string, newPath: string): string {
  const oldPrefix = normalizePath(oldPath);
  if (path === oldPrefix) return normalizePath(newPath);
  return path.startsWith(`${oldPrefix}/`)
    ? `${normalizePath(newPath)}${path.slice(oldPrefix.length)}`
    : path;
}

function nextActiveAfterClose(state: TabsState, closingIds: Set<string>): string | null {
  if (state.activeId && !closingIds.has(state.activeId)) return state.activeId;
  const index = state.tabs.findIndex((tab) => tab.id === state.activeId);
  for (let right = index + 1; right < state.tabs.length; right += 1) {
    if (!closingIds.has(state.tabs[right].id)) return state.tabs[right].id;
  }
  for (let left = index - 1; left >= 0; left -= 1) {
    if (!closingIds.has(state.tabs[left].id)) return state.tabs[left].id;
  }
  return null;
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'open': {
      const existing = state.tabs.find((tab) => tab.id === action.tab.id);
      return existing
        ? { ...state, activeId: existing.id }
        : { tabs: [...state.tabs, action.tab], activeId: action.tab.id };
    }
    case 'activate':
      return state.tabs.some((tab) => tab.id === action.id)
        ? { ...state, activeId: action.id }
        : state;
    case 'close': {
      const closingIds = new Set(action.ids);
      return {
        tabs: state.tabs.filter((tab) => !closingIds.has(tab.id)),
        activeId: nextActiveAfterClose(state, closingIds),
      };
    }
    case 'dirty':
      if (!state.tabs.some((tab) => tab.id === action.id && tab.dirty !== action.dirty)) return state;
      return {
        ...state,
        tabs: state.tabs.map((tab) => tab.id === action.id ? { ...tab, dirty: action.dirty } : tab),
      };
    case 'replace':
      return { tabs: action.tabs, activeId: action.activeId };
    case 'clear':
      return EMPTY_STATE;
    default:
      return state;
  }
}

export type MainFileTabsManager = {
  tabs: MainFileTab[];
  activeTab: MainFileTab | null;
  ownerScope: string | null;
  isClearing: boolean;
  activationVersion: number;
  saveError: string | null;
  openFile: (file: CodeEditorFile, project: Project, scopeKey: string) => Promise<boolean>;
  activateTab: (id: string) => void;
  closeTabs: (ids: string[]) => Promise<boolean>;
  flushAndClear: () => Promise<boolean>;
  adoptScope: (oldScope: string, newScope: string) => void;
  beforeFileMutation: (paths: string[]) => Promise<boolean>;
  registerEditor: (id: string, handle: CodeEditorHandle | null) => void;
  setTabDirty: (id: string, dirty: boolean) => void;
};

export function useMainFileTabs(): MainFileTabsManager {
  const { t } = useTranslation('codeEditor');
  const [state, dispatch] = useReducer(tabsReducer, EMPTY_STATE);
  const [activationVersion, setActivationVersion] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [ownerScope, setOwnerScope] = useState<string | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const stateRef = useRef(state);
  const ownerScopeRef = useRef<string | null>(null);
  const pendingClearRef = useRef<Promise<boolean> | null>(null);
  const errorTabIdRef = useRef<string | null>(null);
  const editorHandlesRef = useRef(new Map<string, CodeEditorHandle>());
  stateRef.current = state;

  const registerEditor = useCallback((id: string, handle: CodeEditorHandle | null) => {
    if (handle) editorHandlesRef.current.set(id, handle);
    else editorHandlesRef.current.delete(id);
  }, []);

  const setTabDirty = useCallback((id: string, dirty: boolean) => {
    dispatch({ type: 'dirty', id, dirty });
    if (!dirty && errorTabIdRef.current === id) {
      errorTabIdRef.current = null;
      setSaveError(null);
    }
  }, []);

  const saveTab = useCallback(async (tab: MainFileTab): Promise<boolean> => {
    if (tab.kind === 'image' || tab.isReadOnly) return true;
    const editor = editorHandlesRef.current.get(tab.id);
    if (!editor) return !tab.dirty;
    try {
      const saved = await editor.save();
      if (!saved) {
        errorTabIdRef.current = tab.id;
        setSaveError(t('tabs.saveFailed', { fileName: tab.file.name }));
      } else if (errorTabIdRef.current === tab.id) {
        errorTabIdRef.current = null;
        setSaveError(null);
      }
      return saved;
    } catch {
      errorTabIdRef.current = tab.id;
      setSaveError(t('tabs.saveFailed', { fileName: tab.file.name }));
      return false;
    }
  }, [t]);

  const flushAndClear = useCallback((): Promise<boolean> => {
    if (pendingClearRef.current) return pendingClearRef.current;
    setIsClearing(true);
    const pending = (async () => {
      const tabs = stateRef.current.tabs;
      const saved = await Promise.all(tabs.map(saveTab));
      if (saved.some((result) => !result)) return false;
      dispatch({ type: 'clear' });
      editorHandlesRef.current.clear();
      ownerScopeRef.current = null;
      setOwnerScope(null);
      errorTabIdRef.current = null;
      setSaveError(null);
      return true;
    })();
    pendingClearRef.current = pending;
    void pending.finally(() => {
      if (pendingClearRef.current === pending) pendingClearRef.current = null;
      setIsClearing(false);
    });
    return pending;
  }, [saveTab]);

  const openFile = useCallback(async (file: CodeEditorFile, project: Project, scopeKey: string) => {
    if (pendingClearRef.current && !await pendingClearRef.current) return false;
    if (ownerScopeRef.current && ownerScopeRef.current !== scopeKey) {
      const cleared = await flushAndClear();
      if (!cleared) return false;
    }
    ownerScopeRef.current = scopeKey;
    setOwnerScope(scopeKey);
    const workspaceRoot = normalizePath(project.fullPath || project.path || '');
    const displayPath = displayPathFor(file, workspaceRoot);
    const workspaceKey = `${project.tenantId ?? 'tenant'}:${project.workspaceId ?? project.name}`;
    const extension = file.name.split('.').pop()?.toLowerCase() || '';
    const tab: MainFileTab = {
      id: `${workspaceKey}:${normalizePath(file.path)}`,
      file,
      displayPath,
      kind: IMAGE_FILE_EXTENSIONS.has(extension) ? 'image' : 'editor',
      dirty: false,
      isReadOnly: project.accessRole === 'view',
      projectPath: project.path,
      workspaceRoot,
    };
    const active = stateRef.current.tabs.find((candidate) => candidate.id === stateRef.current.activeId);
    if (active && active.id !== tab.id) void saveTab(active);
    dispatch({ type: 'open', tab });
    setActivationVersion((version) => version + 1);
    return true;
  }, [flushAndClear, saveTab]);

  const activateTab = useCallback((id: string) => {
    const active = stateRef.current.tabs.find((tab) => tab.id === stateRef.current.activeId);
    if (active && active.id !== id) void saveTab(active);
    dispatch({ type: 'activate', id });
    setActivationVersion((version) => version + 1);
  }, [saveTab]);

  const closeTabs = useCallback(async (ids: string[]) => {
    const closingIds = new Set(ids);
    const closingTabs = stateRef.current.tabs.filter((tab) => closingIds.has(tab.id));
    const results = await Promise.all(closingTabs.map(saveTab));
    const savedIds = closingTabs.filter((_, index) => results[index]).map((tab) => tab.id);
    if (savedIds.length) dispatch({ type: 'close', ids: savedIds });
    const failure = closingTabs.find((_, index) => !results[index]);
    if (failure) {
      dispatch({ type: 'activate', id: failure.id });
      setActivationVersion((version) => version + 1);
    }
    return !failure;
  }, [saveTab]);

  const beforeFileMutation = useCallback(async (paths: string[]) => {
    const affected = stateRef.current.tabs.filter((tab) => paths.some((path) => {
      const normalized = normalizePath(path);
      return tabWithinPath(tab.displayPath, normalized) || tabWithinPath(tab.file.path, normalized);
    }));
    const results = await Promise.all(affected.map(saveTab));
    return results.every(Boolean);
  }, [saveTab]);

  const adoptScope = useCallback((oldScope: string, newScope: string) => {
    if (ownerScopeRef.current !== oldScope) return;
    ownerScopeRef.current = newScope;
    setOwnerScope(newScope);
  }, []);

  useEffect(() => subscribeProjectFilesChanged((event) => {
    void (async () => {
      const current = stateRef.current;
      if (!current.tabs.length) return;
      const appliesTo = (tab: MainFileTab) =>
        (event.workspaceId == null || String(event.workspaceId) === String(tab.file.workspaceId)) &&
        (!event.projectName || event.projectName === tab.file.projectName);
      if (event.deletedPaths?.length) {
        const deletedTabs = current.tabs.filter((tab) => appliesTo(tab) && event.deletedPaths?.some((path) =>
          tabWithinPath(tab.displayPath, path)));
        const saved = await Promise.all(deletedTabs.map(saveTab));
        const safeIds = deletedTabs.filter((_, index) => saved[index]).map((tab) => tab.id);
        if (safeIds.length) dispatch({ type: 'close', ids: safeIds });
      }
      if (!event.pathChanges?.length) return;
      const changedTabs = current.tabs.filter((tab) => appliesTo(tab) && event.pathChanges?.some((change) =>
        tabWithinPath(tab.displayPath, change.oldPath)));
      if (!(await Promise.all(changedTabs.map(saveTab))).every(Boolean)) return;
      const idChanges = new Map<string, string>();
      const tabs = stateRef.current.tabs.map((tab) => {
        if (!appliesTo(tab)) return tab;
        const displayPath = event.pathChanges!.reduce(
          (path, change) => replacePathPrefix(path, change.oldPath, change.newPath), tab.displayPath,
        );
        if (displayPath === tab.displayPath) return tab;
        const relative = displayPath.replace(/^\/workspace\/?/, '');
        const filePath = tab.workspaceRoot && tab.workspaceRoot !== '/workspace'
          ? `${tab.workspaceRoot}/${relative}` : displayPath;
        const id = `${tab.id.slice(0, tab.id.length - normalizePath(tab.file.path).length)}${filePath}`;
        idChanges.set(tab.id, id);
        return {
          ...tab,
          id,
          displayPath,
          file: { ...tab.file, name: displayPath.split('/').pop() || tab.file.name, path: filePath, displayPath },
        };
      });
      if (idChanges.size) dispatch({
        type: 'replace', tabs,
        activeId: stateRef.current.activeId ? idChanges.get(stateRef.current.activeId) ?? stateRef.current.activeId : null,
      });
    })();
  }), [saveTab]);

  const activeTab = useMemo(() => state.tabs.find((tab) => tab.id === state.activeId) ?? null, [state]);
  return {
    tabs: state.tabs,
    activeTab,
    ownerScope,
    isClearing,
    activationVersion,
    saveError,
    openFile,
    activateTab,
    closeTabs,
    flushAndClear,
    adoptScope,
    beforeFileMutation,
    registerEditor,
    setTabDirty,
  };
}
