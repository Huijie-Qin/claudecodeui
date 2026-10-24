import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import AiUsagePanel from './AiUsagePanel';
import type { ReportTenantId } from './types';

type Props = {
  tenants: { id: number; name: string }[];
  currentTenantId?: number;
  userId: number | null;
};

// Report scope is local to this admin view; selecting it does not switch the
// application's active tenant or grant access. The API rechecks system admin.
export default function AdminAiUsagePanel({ tenants, currentTenantId, userId }: Props) {
  const { t } = useTranslation('aiUsage');
  const [selected, setSelected] = useState('');
  const value = selected || String(currentTenantId || '');
  const tenantId: ReportTenantId | null = value === 'all' ? 'all'
    : Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
  return <div className="h-full overflow-y-auto">
    <div className="flex items-center gap-3 border-b border-border px-6 py-4">
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        {t('tenant')}
        <select aria-label={t('tenant')} className="h-9 max-w-[280px] rounded-md border border-input bg-background px-3 text-sm text-foreground" value={value} onChange={event => setSelected(event.target.value)}>
          {!value && <option value="">{t('noTenant')}</option>}
          <option value="all">{t('allTenants')}</option>
          {tenants.map(tenant => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
        </select>
      </label>
    </div>
    {tenantId !== null ? <AiUsagePanel key={`${userId}:${tenantId}`} tenantId={tenantId} />
      : <p className="p-12 text-center text-muted-foreground">{t('noTenant')}</p>}
  </div>;
}
