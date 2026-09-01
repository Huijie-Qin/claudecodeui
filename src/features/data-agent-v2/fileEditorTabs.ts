import type { CodeEditorFile } from '../../components/code-editor/types/types';
import type { Project } from '../../types/app';

export type FileEditorTabKind = 'editor' | 'image';

export type FileEditorTab = {
  id: string;
  file: CodeEditorFile;
  displayPath: string;
  kind: FileEditorTabKind;
  dirty: boolean;
};

export type FileEditorTabsState = {
  tabs: FileEditorTab[];
  activeId: string | null;
};

export type PersistedFileEditorTabs = {
  version: 1;
  paths: string[];
  activePath: string | null;
};

export type FileEditorTabsAction =
  | { type: 'restore'; tabs: FileEditorTab[]; activeId: string | null }
  | { type: 'open'; tab: FileEditorTab }
  | { type: 'activate'; id: string }
  | { type: 'close'; ids: string[] }
  | { type: 'reorder'; sourceId: string; targetId: string }
  | { type: 'dirty'; id: string; dirty: boolean }
  | { type: 'replace'; tabs: FileEditorTab[]; activeId?: string | null };

export const FILE_EDITOR_TABS_STORAGE_PREFIX = 'data-agent-file-tabs:v1';

export function normalizeFileTabPath(pathValue: string): string {
  const normalized = String(pathValue || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/g, '');

  if (!normalized) return '/workspace';
  if (normalized === '/workspace' || normalized.startsWith('/workspace/')) return normalized;
  if (normalized.startsWith('/')) return normalized;
  return `/workspace/${normalized.replace(/^\.\/+/, '')}`;
}

export function getFileTabsWorkspaceKey(project: Project): string {
  return String(project.workspaceId ?? project.name ?? project.path ?? 'workspace');
}

export function getFileTabsStorageKey(project: Project): string {
  return `${FILE_EDITOR_TABS_STORAGE_PREFIX}:${getFileTabsWorkspaceKey(project)}`;
}

function getWorkspaceRoot(project: Project): string {
  return String(project.fullPath || project.path || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/g, '');
}

function toWorkspaceDisplayPath(project: Project, pathValue: string): string {
  const rawPath = String(pathValue || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/g, '');
  const workspaceRoot = getWorkspaceRoot(project);
  if (workspaceRoot && rawPath === workspaceRoot) return '/workspace';
  if (workspaceRoot && rawPath.startsWith(`${workspaceRoot}/`)) {
    return `/workspace/${rawPath.slice(workspaceRoot.length + 1)}`;
  }
  return normalizeFileTabPath(rawPath);
}

export function resolveFileTabFile(project: Project, displayPathValue: string): CodeEditorFile {
  const displayPath = toWorkspaceDisplayPath(project, displayPathValue);
  const workspaceRoot = getWorkspaceRoot(project);
  const relativePath = displayPath === '/workspace'
    ? ''
    : displayPath.replace(/^\/workspace\/?/, '');
  const resolvedPath = workspaceRoot && workspaceRoot !== '/workspace'
    ? `${workspaceRoot}${relativePath ? `/${relativePath}` : ''}`
    : displayPath;
  const name = displayPath.split('/').filter(Boolean).pop() || project.displayName || project.name || 'workspace';

  return {
    name,
    path: resolvedPath,
    displayPath,
    projectName: project.name,
    workspaceId: project.workspaceId,
  };
}

export function inferFileEditorTabKind(pathValue: string): FileEditorTabKind {
  const extension = normalizeFileTabPath(pathValue).split('.').pop()?.toLowerCase();
  return new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']).has(extension || '')
    ? 'image'
    : 'editor';
}

export function createFileEditorTab(project: Project, pathValue: string): FileEditorTab {
  const displayPath = toWorkspaceDisplayPath(project, pathValue);
  const file = resolveFileTabFile(project, displayPath);

  return {
    id: `${getFileTabsWorkspaceKey(project)}:${displayPath}`,
    file,
    displayPath,
    kind: inferFileEditorTabKind(displayPath),
    dirty: false,
  };
}

function nextActiveIdAfterClose(state: FileEditorTabsState, closingIds: Set<string>): string | null {
  if (!state.activeId || !closingIds.has(state.activeId)) return state.activeId;

  const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeId);
  for (let index = activeIndex + 1; index < state.tabs.length; index += 1) {
    if (!closingIds.has(state.tabs[index].id)) return state.tabs[index].id;
  }
  for (let index = activeIndex - 1; index >= 0; index -= 1) {
    if (!closingIds.has(state.tabs[index].id)) return state.tabs[index].id;
  }
  return null;
}

export function fileEditorTabsReducer(
  state: FileEditorTabsState,
  action: FileEditorTabsAction,
): FileEditorTabsState {
  switch (action.type) {
    case 'restore':
      return { tabs: action.tabs, activeId: action.activeId };
    case 'open': {
      const existing = state.tabs.find((tab) => tab.id === action.tab.id);
      return existing
        ? { ...state, activeId: existing.id }
        : { tabs: [...state.tabs, action.tab], activeId: action.tab.id };
    }
    case 'activate':
      return state.tabs.some((tab) => tab.id === action.id) ? { ...state, activeId: action.id } : state;
    case 'close': {
      const closingIds = new Set(action.ids);
      return {
        tabs: state.tabs.filter((tab) => !closingIds.has(tab.id)),
        activeId: nextActiveIdAfterClose(state, closingIds),
      };
    }
    case 'reorder': {
      if (action.sourceId === action.targetId) return state;
      const sourceIndex = state.tabs.findIndex((tab) => tab.id === action.sourceId);
      const targetIndex = state.tabs.findIndex((tab) => tab.id === action.targetId);
      if (sourceIndex < 0 || targetIndex < 0) return state;
      const tabs = [...state.tabs];
      const [source] = tabs.splice(sourceIndex, 1);
      tabs.splice(targetIndex, 0, source);
      return { ...state, tabs };
    }
    case 'dirty':
      if (state.tabs.find((tab) => tab.id === action.id)?.dirty === action.dirty) return state;
      return {
        ...state,
        tabs: state.tabs.map((tab) => tab.id === action.id ? { ...tab, dirty: action.dirty } : tab),
      };
    case 'replace':
      return {
        tabs: action.tabs,
        activeId: action.activeId === undefined ? state.activeId : action.activeId,
      };
    default:
      return state;
  }
}

export function serializeFileEditorTabs(state: FileEditorTabsState): PersistedFileEditorTabs {
  const activePath = state.tabs.find((tab) => tab.id === state.activeId)?.displayPath ?? null;
  return {
    version: 1,
    paths: state.tabs.map((tab) => tab.displayPath),
    activePath,
  };
}

export function parsePersistedFileEditorTabs(rawValue: string | null): PersistedFileEditorTabs | null {
  if (!rawValue) return null;
  try {
    const parsed = JSON.parse(rawValue) as Partial<PersistedFileEditorTabs>;
    if (parsed.version !== 1 || !Array.isArray(parsed.paths)) return null;
    const paths = Array.from(new Set(parsed.paths
      .filter((path): path is string => typeof path === 'string' && Boolean(path.trim()))
      .map(normalizeFileTabPath)));
    const activePath = typeof parsed.activePath === 'string'
      ? normalizeFileTabPath(parsed.activePath)
      : null;
    return {
      version: 1,
      paths,
      activePath: activePath && paths.includes(activePath) ? activePath : paths[0] ?? null,
    };
  } catch {
    return null;
  }
}

export function replaceFileTabPathPrefix(pathValue: string, oldPrefixValue: string, newPrefixValue: string): string {
  const path = normalizeFileTabPath(pathValue);
  const oldPrefix = normalizeFileTabPath(oldPrefixValue);
  const newPrefix = normalizeFileTabPath(newPrefixValue);
  if (path === oldPrefix) return newPrefix;
  if (!path.startsWith(`${oldPrefix}/`)) return path;
  return `${newPrefix}${path.slice(oldPrefix.length)}`;
}

export function isFileTabWithinPath(pathValue: string, parentValue: string): boolean {
  const path = normalizeFileTabPath(pathValue);
  const parent = normalizeFileTabPath(parentValue);
  return path === parent || path.startsWith(`${parent}/`);
}
