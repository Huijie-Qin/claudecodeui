import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { useAuth } from '../components/auth/context/AuthContext';
import { chooseInitialTenant, CURRENT_TENANT_STORAGE_KEY } from '../components/tenant/tenantSelection';
import type { Tenant } from '../types/app';
import { api } from '../utils/api';

type TenantContextValue = {
  tenants: Tenant[];
  currentTenant: Tenant | null;
  isLoadingTenants: boolean;
  needsTenantSelection: boolean;
  refreshTenants: () => Promise<void>;
  selectTenant: (tenant: Tenant) => void;
  clearTenant: () => void;
};

const TenantContext = createContext<TenantContextValue | null>(null);

export function useTenant(): TenantContextValue {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error('useTenant must be used within a TenantProvider');
  }
  return context;
}

export function TenantProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [currentTenant, setCurrentTenant] = useState<Tenant | null>(null);
  const [isLoadingTenants, setIsLoadingTenants] = useState(false);

  const selectTenant = useCallback((tenant: Tenant) => {
    setCurrentTenant(tenant);
    localStorage.setItem(CURRENT_TENANT_STORAGE_KEY, String(tenant.id));
  }, []);

  const clearTenant = useCallback(() => {
    setCurrentTenant(null);
    localStorage.removeItem(CURRENT_TENANT_STORAGE_KEY);
  }, []);

  const refreshTenants = useCallback(async () => {
    if (!user) {
      setTenants([]);
      setCurrentTenant(null);
      return;
    }

    setIsLoadingTenants(true);
    try {
      const response = await api.tenants.mine();
      if (!response.ok) {
        setTenants([]);
        setCurrentTenant(null);
        return;
      }

      const payload = await response.json();
      const nextTenants = (payload.tenants || []) as Tenant[];
      setTenants(nextTenants);
      const saved = localStorage.getItem(CURRENT_TENANT_STORAGE_KEY);
      const chosen = chooseInitialTenant(saved, nextTenants);
      setCurrentTenant((previous) => {
        if (previous && nextTenants.some((tenant) => tenant.id === previous.id)) {
          return previous;
        }
        return chosen;
      });
    } finally {
      setIsLoadingTenants(false);
    }
  }, [user]);

  useEffect(() => {
    void refreshTenants();
  }, [refreshTenants]);

  const value = useMemo<TenantContextValue>(() => ({
    tenants,
    currentTenant,
    isLoadingTenants,
    needsTenantSelection: Boolean(user) && !isLoadingTenants && !currentTenant,
    refreshTenants,
    selectTenant,
    clearTenant,
  }), [clearTenant, currentTenant, isLoadingTenants, refreshTenants, selectTenant, tenants, user]);

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}
