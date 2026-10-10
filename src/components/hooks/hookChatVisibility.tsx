import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useAuth } from '../auth/context/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { createHookChatVisibilityStore } from './hookChatVisibilityStore';

const fallback = createHookChatVisibilityStore();
const Context = createContext(fallback);

export function HookChatVisibilityProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { currentTenant } = useTenant();
  // Never carry one user's/tenant's temporary visibility into another's session.
  const store = useMemo(() => createHookChatVisibilityStore(), [user?.id, currentTenant?.id]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}

export const useHookChatVisibilityStore = () => useContext(Context);

export function useHookChatVisibility(workspaceId?: number, hookId?: string) {
  const store = useContext(Context);
  return useSyncExternalStore(store.subscribe, () => store.visible(workspaceId, hookId), () => true);
}

export function useHookChatVisibilityRevision(workspaceId?: number) {
  const store = useContext(Context);
  return useSyncExternalStore(store.subscribe, () => store.revision(workspaceId), () => 0);
}
