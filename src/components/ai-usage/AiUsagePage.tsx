import { ArrowLeft, BarChart3 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../auth/context/AuthContext';
import { Button } from '../../shared/view/ui';

import AiUsagePanel from './AiUsagePanel';

export default function AiUsagePage() {
  const { t } = useTranslation('aiUsage');
  const navigate = useNavigate();
  const { user } = useAuth();
  const { currentTenant, tenants, selectTenant } = useTenant();
  return (
    <div className="fixed inset-0 flex flex-col bg-background text-foreground">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3 md:px-6">
        <Button variant="ghost" size="sm" onClick={() => navigate('/')}><ArrowLeft className="h-4 w-4" /><span className="hidden sm:inline">{t('back')}</span></Button>
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><BarChart3 className="h-5 w-5" /></div>
        <h1 className="text-base font-semibold">{t('title')}</h1>
        <label className="ml-auto flex max-w-full items-center gap-2 text-xs text-muted-foreground">
          <span className="hidden sm:inline">{t('tenant')}</span>
          <select className="h-9 max-w-[220px] rounded-md border border-input bg-background px-3 text-sm text-foreground" aria-label={t('tenant')} value={currentTenant?.id ?? ''} onChange={(event) => { const tenant = tenants.find((item) => String(item.id) === event.target.value); if (tenant) selectTenant(tenant); }}>
            {!currentTenant && <option value="">{t('noTenant')}</option>}
            {tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
          </select>
        </label>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        {currentTenant ? <AiUsagePanel key={`${user?.id}:${currentTenant.id}`} tenantId={currentTenant.id} /> : <p className="p-12 text-center text-muted-foreground">{t('noTenant')}</p>}
      </main>
    </div>
  );
}
