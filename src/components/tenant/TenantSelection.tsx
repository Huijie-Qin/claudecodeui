import { Building2, Check, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useTenant } from '../../contexts/TenantContext';
import { Button, Card } from '../../shared/view/ui';

export default function TenantSelection() {
  const { t } = useTranslation('auth');
  const { tenants, isLoadingTenants, refreshTenants, selectTenant } = useTenant();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-lg space-y-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">{t('tenantSelection.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('tenantSelection.description')}</p>
        </div>

        <Card className="space-y-2 p-3">
          {tenants.length === 0 && !isLoadingTenants ? (
            <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
              {t('tenantSelection.empty')}
            </div>
          ) : null}

          {tenants.map((tenant) => (
            <button
              key={tenant.id}
              type="button"
              className="flex w-full items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent"
              onClick={() => selectTenant(tenant)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Building2 className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">{tenant.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {tenant.code} · {t(`tenantSelection.permissions.${tenant.permission}`, { defaultValue: tenant.permission })}
                  </span>
                </span>
              </span>
              <Check className="h-4 w-4 text-muted-foreground" />
            </button>
          ))}
        </Card>

        <Button variant="outline" onClick={() => void refreshTenants()} disabled={isLoadingTenants}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t('tenantSelection.refresh')}
        </Button>
      </div>
    </div>
  );
}
