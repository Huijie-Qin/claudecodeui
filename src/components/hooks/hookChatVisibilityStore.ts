export function createHookChatVisibilityStore() {
  const values = new Map<string, boolean>();
  const revisions = new Map<number, number>();
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    visible: (workspaceId?: number, hookId?: string) => values.get(`${workspaceId}:${hookId}`) !== false,
    revision: (workspaceId?: number) => revisions.get(workspaceId ?? 0) ?? 0,
    set: (workspaceId: number, hookId: string, visible: boolean) => {
      const key = `${workspaceId}:${hookId}`;
      if (values.get(key) === visible) return;
      values.set(key, visible);
      revisions.set(workspaceId, (revisions.get(workspaceId) ?? 0) + 1);
      listeners.forEach((listener) => listener());
    },
  };
}
