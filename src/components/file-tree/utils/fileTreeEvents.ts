export type ProjectFilesChangedReason =
  | 'create'
  | 'delete'
  | 'move'
  | 'plan'
  | 'rename'
  | 'upload'
  | 'websocket';

export type ProjectFilesChangedEvent = {
  projectName?: string | null;
  workspaceId?: number | string | null;
  changedPath?: string | null;
  reason?: ProjectFilesChangedReason | string;
  pathChanges?: Array<{ oldPath: string; newPath: string }>;
  deletedPaths?: string[];
};

type ProjectFilesChangedListener = (event: ProjectFilesChangedEvent) => void;

const listeners = new Set<ProjectFilesChangedListener>();

export function dispatchProjectFilesChanged(event: ProjectFilesChangedEvent = {}) {
  const payload = { ...event };
  listeners.forEach((listener) => listener(payload));
}

export function subscribeProjectFilesChanged(listener: ProjectFilesChangedListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
