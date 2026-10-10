import { Building2, ChevronDown } from 'lucide-react';

import type { Tenant } from '../../types/app';

type ManagementTenantSelectorProps = {
  currentTenant: Tenant | null;
  tenants: Tenant[];
  onSelect: (tenant: Tenant) => void;
};

export default function ManagementTenantSelector({ currentTenant, tenants, onSelect }: ManagementTenantSelectorProps) {
  const name = currentTenant?.name || '尚未选择租户';
  const canSwitch = tenants.some((tenant) => tenant.id !== currentTenant?.id);
  const currentIsManageable = tenants.some((tenant) => tenant.id === currentTenant?.id);

  return <div className={`relative ml-auto flex min-w-0 max-w-full items-center gap-2.5 rounded-xl border border-border/60 bg-muted/40 py-1.5 pl-1.5 pr-3 transition-colors ${canSwitch ? 'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background hover:border-primary/25 hover:bg-muted/70' : ''}`}>
    <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
      <Building2 className="h-4 w-4" />
    </span>
    <div className="min-w-0 text-left">
      <p className="text-[10px] leading-4 tracking-wide text-muted-foreground">当前租户</p>
      <p title={name} className="max-w-[45vw] truncate text-sm font-medium leading-5 text-foreground sm:max-w-52">{name}</p>
    </div>
    {canSwitch && <>
      <ChevronDown aria-hidden="true" className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {/* Retain native keyboard/screen-reader selection without the browser-specific closed control. */}
      <select aria-label="切换管理租户" title={name}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        value={currentTenant?.id ?? ''}
        onChange={(event) => {
          const tenant = tenants.find((item) => String(item.id) === event.target.value);
          if (tenant && tenant.id !== currentTenant?.id) onSelect(tenant);
        }}>
        {!currentIsManageable && <option value={currentTenant?.id ?? ''} disabled>{name}</option>}
        {tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
      </select>
    </>}
  </div>;
}
