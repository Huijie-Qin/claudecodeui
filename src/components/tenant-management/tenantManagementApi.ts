import { authenticatedFetch } from '../../utils/api';

export function createTenantManagementApi(tenantId: number, onForbidden?: () => void) {
  const base = `/api/tenant-management/${encodeURIComponent(tenantId)}`;
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await authenticatedFetch(`${base}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 401 || response.status === 403) onForbidden?.();
    return response;
  };
  const id = (value: string | number) => encodeURIComponent(value);
  // No fallback to platform Admin endpoints, including currently hidden actions.
  const denied = async (..._args: unknown[]) => new Response(JSON.stringify({ error: '此操作仅限系统管理员' }), { status: 403 });
  return {
    capabilities: () => request('/capabilities'),
    hooks: () => request('/hooks'),
    hookResources: () => request('/hooks/resources'),
    createHook: (body: unknown) => request('/hooks', 'POST', body),
    updateHook: (hookId: string, body: unknown) => request(`/hooks/${id(hookId)}`, 'PUT', body),
    publishHook: (hookId: string, defaultEnabled: boolean) => request(`/hooks/${id(hookId)}/publish`, 'POST', { defaultEnabled }),
    deleteHook: (hookId: string) => request(`/hooks/${id(hookId)}`, 'DELETE'),
    agentTemplates: () => request('/agent-templates'),
    agentTemplateCategories: () => request('/agent-template-categories'),
    agentTemplatePresetCatalog: (_tenantId?: number) => request('/agent-templates/preset-catalog'),
    agentTemplateHookCatalog: (_tenantId?: number) => request('/agent-templates/hook-catalog'),
    getAgentTemplate: (templateId: number) => request(`/agent-templates/${id(templateId)}`),
    createAgentTemplate: (body: unknown) => request('/agent-templates', 'POST', body),
    updateAgentTemplate: (templateId: number, body: unknown) => request(`/agent-templates/${id(templateId)}`, 'PUT', body),
    publishAgentTemplate: (templateId: number) => request(`/agent-templates/${id(templateId)}/publish`, 'POST'),
    disableAgentTemplate: (templateId: number) => request(`/agent-templates/${id(templateId)}/disable`, 'POST'),
    deleteAgentTemplate: (templateId: number) => request(`/agent-templates/${id(templateId)}`, 'DELETE'),
    createAgentTemplateCategory: denied,
    deleteAgentTemplateCategory: denied,
    searchSkillPresetMarket: denied,
    skillPresets: denied,
    createSkillPreset: denied,
    validateSkillPreset: denied,
    publishSkillPreset: denied,
  };
}

export type TenantManagementApi = ReturnType<typeof createTenantManagementApi>;

export async function readManagementJson<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '请求失败');
  return body as T;
}
