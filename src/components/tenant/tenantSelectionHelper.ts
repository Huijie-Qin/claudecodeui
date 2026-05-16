import type { Tenant } from '../../types/app';

export const CURRENT_TENANT_STORAGE_KEY = 'currentTenantId';

export function chooseInitialTenant(savedTenantId: string | null, tenants: Tenant[]): Tenant | null {
  if (!savedTenantId) {
    return null;
  }

  const numericId = Number(savedTenantId);
  if (!Number.isInteger(numericId)) {
    return null;
  }

  return tenants.find((tenant) => tenant.id === numericId) ?? null;
}

export function shouldShowTenantLoadingScreen(isLoadingTenants: boolean, currentTenant: Tenant | null): boolean {
  return isLoadingTenants && !currentTenant;
}
