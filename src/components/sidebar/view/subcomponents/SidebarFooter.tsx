import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown, LogOut, Search, Settings, Shield } from 'lucide-react';
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
  const showTenantSwitcher = Boolean(shouldShowTenantSwitcher(tenants) && currentTenant && onTenantSwitch);
  const showLogout = !IS_PLATFORM;
  const [isTenantMenuOpen, setIsTenantMenuOpen] = useState(false);
  const [tenantSearch, setTenantSearch] = useState('');
  const tenantSwitcherRef = useRef<HTMLDivElement>(null);
  const tenantSearchInputRef = useRef<HTMLInputElement>(null);
  const filteredTenants = useMemo(() => {
    const query = tenantSearch.trim().toLowerCase();
    if (!query) return tenants;

    return tenants.filter((tenant) => (
      `${tenant.name} ${tenant.code} ${tenant.permission}`.toLowerCase().includes(query)
    ));
  }, [tenantSearch, tenants]);

  useEffect(() => {
    if (!isTenantMenuOpen) return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      if (!tenantSwitcherRef.current?.contains(event.target as Node)) {
        setIsTenantMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsTenantMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isTenantMenuOpen]);

  useEffect(() => {
    if (isTenantMenuOpen) {
      tenantSearchInputRef.current?.focus();
    }
  }, [isTenantMenuOpen]);

  useEffect(() => {
    if (!showTenantSwitcher) {
      setIsTenantMenuOpen(false);
      setTenantSearch('');
    }
  }, [showTenantSwitcher]);

  const handleTenantChange = (tenantId: string) => {
    const tenant = resolveTenantSelection(tenants, tenantId);
    if (tenant && tenant.id !== currentTenant?.id) {
      onTenantSwitch?.(tenant);
    }
    setIsTenantMenuOpen(false);
    setTenantSearch('');
  };

  return (
    <div className="flex-shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>
      <div className="nav-divider" />

      {showTenantSwitcher && currentTenant && (
        <div ref={tenantSwitcherRef} className="relative px-2 py-2">
          {isTenantMenuOpen && (
            <div
              className="absolute bottom-full left-2 right-2 z-50 mb-2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
              role="listbox"
              aria-label={t('tenantSwitcher.switch')}
            >
              <div className="border-b border-border p-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    ref={tenantSearchInputRef}
                    className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-2 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
                    value={tenantSearch}
                    onChange={(event) => setTenantSearch(event.target.value)}
                    placeholder={t('tenantSwitcher.search')}
                    type="search"
                  />
                </div>
              </div>
              <div className="max-h-64 overflow-y-auto p-1.5">
                {filteredTenants.length === 0 ? (
                  <div className="px-3 py-5 text-center text-xs text-muted-foreground">
                    {t('tenantSwitcher.noMatches')}
                  </div>
                ) : (
                  filteredTenants.map((tenant) => {
                    const isSelected = tenant.id === currentTenant.id;
                    return (
                      <button
                        key={tenant.id}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors ${
                          isSelected
                            ? 'bg-primary/10 text-primary'
                            : 'text-foreground hover:bg-accent/70'
                        }`}
                        onClick={() => handleTenantChange(String(tenant.id))}
                        role="option"
                        aria-selected={isSelected}
                        type="button"
                      >
                        <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-xs font-semibold ${
                          isSelected
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground'
                        }`}
                        >
                          {getTenantInitial(tenant)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center justify-between gap-2">
                            <span className="truncate text-xs font-medium">
                              {tenant.name}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                            {tenant.code}
                          </span>
                        </span>
                        <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                          {isSelected ? <Check className="h-3.5 w-3.5" /> : null}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}

          <button
            className="group flex h-9 w-full items-center gap-2 rounded-lg border border-transparent bg-muted/50 px-2.5 text-left text-muted-foreground transition-colors hover:border-primary/20 hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            onClick={() => setIsTenantMenuOpen((value) => !value)}
            aria-expanded={isTenantMenuOpen}
            aria-haspopup="listbox"
            aria-label={t('tenantSwitcher.switch')}
            type="button"
          >
            <span className="h-2 w-2 flex-shrink-0 rounded-full bg-emerald-500 ring ring-emerald-500/15" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">
                {currentTenant.name}
              </span>
            </span>
            <ChevronsUpDown className={`h-3.5 w-3.5 flex-shrink-0 transition-colors ${
              isTenantMenuOpen ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
            }`}
            />
            <span className="sr-only">{t('tenantSwitcher.switch')}</span>
          </button>
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

function getTenantInitial(tenant?: Tenant | null): string {
  return (tenant?.name || tenant?.code || '?').trim().slice(0, 1).toUpperCase();
}
