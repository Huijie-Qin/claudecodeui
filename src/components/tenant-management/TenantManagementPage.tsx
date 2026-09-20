import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BarChart3, Building2, FileText, Webhook } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../auth/context/AuthContext';
import { Button } from '../../shared/view/ui';
import AgentTemplatesTab from '../admin/AgentTemplatesTab';
import AiUsagePanel from '../ai-usage/AiUsagePanel';
import type { Tenant } from '../../types/app';

import TenantHooksTab from './TenantHooksTab';
import { createTenantManagementApi, readManagementJson } from './tenantManagementApi';
import { canManageTenant } from './tenantManagementAccess';

function TenantManagementContent({ tenant }: { tenant: Tenant }) {
  const [tab, setTab] = useState('hooks');
  const [allowed, setAllowed] = useState(false);
  const [error, setError] = useState('');
  const forbidden = useCallback(() => { setAllowed(false); setError('当前账号没有此租户的管理权限，请联系系统管理员。'); }, []);
  const managementApi = useMemo(() => createTenantManagementApi(tenant.id, forbidden), [tenant.id, forbidden]);
  const templateTenants = useMemo(() => [{ ...tenant, status: 'active' }], [tenant]);
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await managementApi.capabilities();
        if (response.status === 401 || response.status === 403) {
          if (active) forbidden();
          return;
        }
        await readManagementJson(response);
        if (active) { setAllowed(true); setError(''); }
      } catch (reason) { if (active) { setAllowed(false); setError(reason instanceof Error ? reason.message : '权限检查失败'); } }
    };
    void check();
    window.addEventListener('focus', check);
    return () => { active = false; window.removeEventListener('focus', check); };
  }, [managementApi, forbidden]);
  if (!allowed) return <p role={error ? 'alert' : 'status'} className="p-12 text-center text-muted-foreground">{error || '正在检查租户管理权限…'}</p>;
  return <>
    <nav aria-label="租户管理功能" className="flex shrink-0 flex-wrap gap-2 border-b border-border px-4 py-3 md:px-6">
      {[{ id: 'hooks', name: 'Hook 配置', icon: Webhook }, { id: 'reports', name: '租户 AI 使用报表', icon: BarChart3 }, { id: 'templates', name: 'Agent 模板', icon: FileText }].map(({ id, name, icon: Icon }) => <Button key={id} variant={tab === id ? 'secondary' : 'ghost'} aria-pressed={tab === id} onClick={() => setTab(id)}><Icon className="h-4 w-4" />{name}</Button>)}
      <p className="basis-full text-sm text-muted-foreground">仅可管理本租户创建的 Hook 和 Agent 模板。Admin 创建或下发的配置仅可使用或引用，不可编辑、重新发布、下线或删除。</p>
    </nav>
    <main className="min-h-0 flex-1 overflow-auto">
      <div className={tab === 'hooks' ? 'mx-auto max-w-7xl p-4 md:p-6' : 'hidden'}><TenantHooksTab managementApi={managementApi} /></div>
      {tab === 'reports' && <AiUsagePanel tenantId={tenant.id} />}
      <div className={tab === 'templates' ? 'mx-auto max-w-7xl p-4 md:p-6' : 'hidden'}><AgentTemplatesTab tenants={templateTenants} currentTenantId={tenant.id} managementApi={managementApi} tenantManaged /></div>
    </main>
  </>;
}

export default function TenantManagementPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { currentTenant, tenants, selectTenant } = useTenant();
  const manageable = tenants.filter((tenant) => canManageTenant(user, tenant));
  return <div className="fixed inset-0 flex flex-col bg-background text-foreground">
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3 md:px-6">
      <Button variant="ghost" size="sm" onClick={() => navigate('/')}><ArrowLeft className="h-4 w-4" />返回</Button>
      <Building2 className="h-5 w-5 text-primary" /><h1 className="text-lg font-semibold">租户管理</h1>
      <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">当前租户<select aria-label="当前租户" className="h-9 max-w-56 rounded-md border border-input bg-background px-3 text-foreground" value={currentTenant?.id ?? ''} onChange={(event) => { const tenant = manageable.find((item) => String(item.id) === event.target.value); if (tenant) selectTenant(tenant); }}>
        {!manageable.some((tenant) => tenant.id === currentTenant?.id) && <option value={currentTenant?.id ?? ''}>{currentTenant?.name || '选择租户'}</option>}
        {manageable.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
      </select></label>
    </header>
    {currentTenant ? <TenantManagementContent key={`${user?.id}:${currentTenant.id}`} tenant={currentTenant} /> : <p className="p-12 text-center text-muted-foreground">请先选择有管理权限的租户。</p>}
  </div>;
}
