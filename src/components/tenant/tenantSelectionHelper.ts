import type { Tenant } from '../../types/app';

export const CURRENT_TENANT_STORAGE_KEY = 'currentTenantId';

export function chooseInitialTenant(savedTenantId: string | null, tenants: Tenant[]): Tenant | null {
  if (savedTenantId) {
    const numericId = Number(savedTenantId);
    if (Number.isInteger(numericId)) {
      const savedTenant = tenants.find((tenant) => tenant.id === numericId);
      if (savedTenant) return savedTenant;
    }
  }

  return tenants.length === 1 ? tenants[0] : null;
}

export function shouldShowTenantLoadingScreen(isLoadingTenants: boolean, currentTenant: Tenant | null): boolean {
  return isLoadingTenants && !currentTenant;
}
