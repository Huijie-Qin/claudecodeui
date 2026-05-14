import { Settings, ArrowUpCircle, Bug, Shield, Building2, LogOut } from 'lucide-react';
import type { TFunction } from 'i18next';

import { IS_PLATFORM } from '../../../../constants/config';
import type { Tenant } from '../../../../types/app';
import { resolveTenantSelection, shouldShowTenantSwitcher } from '../../../tenant/tenantSwitcherUtils';
import { useAuth } from '../../../auth/context/AuthContext';

type SidebarFooterProps = {
  onShowSettings: () => void;
  showAdminEntry?: boolean;
  onShowAdminPanel?: () => void;
  tenants?: Tenant[];
  currentTenant?: Tenant | null;
  onTenantSwitch?: (tenant: Tenant) => void;
  t: TFunction;
};

export default function SidebarFooter({
  onShowSettings,
  showAdminEntry,
  onShowAdminPanel,
  tenants = [],
  currentTenant,
  onTenantSwitch,
  t,
}: SidebarFooterProps) {
  const { logout } = useAuth();
  const showTenantSwitcher = shouldShowTenantSwitcher(tenants) && currentTenant && onTenantSwitch;
  const showLogout = !IS_PLATFORM;

  const handleTenantChange = (tenantId: string) => {
    const tenant = resolveTenantSelection(tenants, tenantId);
    if (tenant && tenant.id !== currentTenant?.id) {
      onTenantSwitch?.(tenant);
    }
  };

  return (
    <div className="flex-shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>
      <div className="nav-divider" />

      {showTenantSwitcher && (
        <div className="px-2 py-1.5">
          <label className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground">
            <Building2 className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="sr-only">Tenant</span>
            <select
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
              value={String(currentTenant.id)}
              onChange={(event) => handleTenantChange(event.target.value)}
            >
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {showAdminEntry && (
        <div className="hidden px-2 md:block">
          <button
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            onClick={onShowAdminPanel}
          >
            <Shield className="h-3.5 w-3.5" />
            <span className="text-sm">Admin</span>
          </button>
        </div>
      )}

      <div className="hidden px-2 py-1.5 md:block">
        <button
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          onClick={onShowSettings}
        >
          <Settings className="h-3.5 w-3.5" />
          <span className="text-sm">{t('actions.settings')}</span>
        </button>
      </div>

      {showLogout && (
        <div className="hidden px-2 pb-1.5 md:block">
          <button
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            onClick={logout}
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="text-sm">{t('common:navigation.logout')}</span>
          </button>
        </div>
      )}

      {showAdminEntry && (
        <div className="px-3 pt-2 md:hidden">
          <button
            className="flex h-12 w-full items-center gap-3.5 rounded-xl bg-muted/40 px-4 transition-all hover:bg-muted/60 active:scale-[0.98]"
            onClick={onShowAdminPanel}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-background/80">
              <Shield className="w-4.5 h-4.5 text-muted-foreground" />
            </div>
            <span className="text-base font-medium text-foreground">Admin</span>
          </button>
        </div>
      )}

      <div className="px-3 pb-3 pt-2 md:hidden">
        <button
          className="flex h-12 w-full items-center gap-3.5 rounded-xl bg-muted/40 px-4 transition-all hover:bg-muted/60 active:scale-[0.98]"
          onClick={onShowSettings}
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-background/80">
            <Settings className="w-4.5 h-4.5 text-muted-foreground" />
          </div>
          <span className="text-base font-medium text-foreground">{t('actions.settings')}</span>
        </button>
      </div>

      {showLogout && (
        <div className="px-3 pb-3 md:hidden">
          <button
            className="flex h-12 w-full items-center gap-3.5 rounded-xl bg-destructive/10 px-4 transition-all hover:bg-destructive/15 active:scale-[0.98]"
            onClick={logout}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-background/80">
              <LogOut className="w-4.5 h-4.5 text-destructive" />
            </div>
            <span className="text-base font-medium text-destructive">{t('common:navigation.logout')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
