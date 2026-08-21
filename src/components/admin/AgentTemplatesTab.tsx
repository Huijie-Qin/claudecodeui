import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, Loader2, Plus, Save, Sparkles } from 'lucide-react';

import { api } from '../../utils/api';
import { Button, Input } from '../../shared/view/ui';
import { cn } from '../../lib/utils';

type Tenant = { id: number; code: string; name: string; status: string };
type PresetRef = { tenantId: number; presetId: number };
type AgentTemplate = {
  id: number;
  name: string;
  summary: string;
  agentMarkdown: string;
  guideText: string;
  tenantIds: number[];
  skillPresetRefs: PresetRef[];
  mcpPresetRefs: PresetRef[];
  globalVisible: boolean;
  status: 'draft' | 'published' | 'disabled';
};
type Preset = { id: number; tenantId: number; name: string; displayName: string; description?: string };
type Catalog = { skills: Preset[]; mcps: Preset[] };

const EMPTY_TEMPLATE: Omit<AgentTemplate, 'id'> = {
  name: '',
  summary: '',
  agentMarkdown: '',
  guideText: '',
  tenantIds: [],
  skillPresetRefs: [],
  mcpPresetRefs: [],
  globalVisible: false,
  status: 'draft',
};

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}

function statusLabel(status: AgentTemplate['status']) {
  if (status === 'published') return '已发布';
  if (status === 'disabled') return '已停用';
  return '草稿';
}

function isDataAgentTenant(tenant?: Tenant) {
  return tenant?.name.replace(/\s+/g, '') === 'DataAgent管理'
    || ['dataagent', 'dataagent-admin', 'dataagent-management'].includes(tenant?.code || '');
}

export default function AgentTemplatesTab({
  tenants,
  currentTenantId,
}: {
  tenants: Tenant[];
  currentTenantId?: number;
}) {
  const activeTenants = useMemo(() => tenants.filter((tenant) => tenant.status === 'active'), [tenants]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [editing, setEditing] = useState<(AgentTemplate | (Omit<AgentTemplate, 'id'> & { id?: undefined })) | null>(null);
  const [tenantId, setTenantId] = useState<number | null>(currentTenantId || activeTenants[0]?.id || null);
  const [catalogTenantId, setCatalogTenantId] = useState<number | null>(tenantId);
  const [catalog, setCatalog] = useState<Catalog>({ skills: [], mcps: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTemplates = useCallback(async () => {
    if (!tenantId) {
      setTemplates([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const payload = await readJson<{ templates: AgentTemplate[] }>(await api.admin.agentTemplates(tenantId));
      setTemplates(payload.templates || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '模板加载失败');
    } finally {
      setIsLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void loadTemplates(); }, [loadTemplates]);

  useEffect(() => {
    if (!tenantId && activeTenants[0]?.id) {
      setTenantId(currentTenantId || activeTenants[0].id);
      setCatalogTenantId(currentTenantId || activeTenants[0].id);
    }
  }, [activeTenants, currentTenantId, tenantId]);

  useEffect(() => {
    if (!catalogTenantId) {
      setCatalog({ skills: [], mcps: [] });
      return;
    }
    let cancelled = false;
    void api.admin.agentTemplatePresetCatalog(catalogTenantId)
      .then((response) => readJson<Catalog>(response))
      .then((payload) => { if (!cancelled) setCatalog(payload); })
      .catch((catalogError) => { if (!cancelled) setError(catalogError instanceof Error ? catalogError.message : '预设加载失败'); });
    return () => { cancelled = true; };
  }, [catalogTenantId]);

  const beginCreate = () => {
    const initialTenantId = tenantId || currentTenantId || activeTenants[0]?.id;
    setEditing({ ...EMPTY_TEMPLATE, tenantIds: initialTenantId ? [initialTenantId] : [] });
    setCatalogTenantId(initialTenantId || null);
    setError(null);
  };

  const update = <K extends keyof Omit<AgentTemplate, 'id'>>(key: K, value: Omit<AgentTemplate, 'id'>[K]) => {
    setEditing((previous) => previous ? { ...previous, [key]: value } : previous);
  };

  const toggleTenant = (tenantId: number) => {
    if (!editing) return;
    const tenant = activeTenants.find((item) => item.id === tenantId);
    const selected = editing.tenantIds.includes(tenantId);
    if (!selected && isDataAgentTenant(tenant)) {
      setEditing({
        ...editing,
        tenantIds: [tenantId],
        skillPresetRefs: editing.skillPresetRefs.filter((ref) => ref.tenantId === tenantId),
        mcpPresetRefs: editing.mcpPresetRefs.filter((ref) => ref.tenantId === tenantId),
      });
      setCatalogTenantId(tenantId);
      return;
    }
    const tenantIds = selected
      ? editing.tenantIds.filter((id) => id !== tenantId)
      : [...editing.tenantIds, tenantId];
    setEditing({
      ...editing,
      tenantIds,
      skillPresetRefs: selected ? editing.skillPresetRefs.filter((ref) => ref.tenantId !== tenantId) : editing.skillPresetRefs,
      mcpPresetRefs: selected ? editing.mcpPresetRefs.filter((ref) => ref.tenantId !== tenantId) : editing.mcpPresetRefs,
    });
    if (!selected) setCatalogTenantId(tenantId);
  };

  const togglePreset = (kind: 'skillPresetRefs' | 'mcpPresetRefs', preset: Preset) => {
    if (!editing || !editing.tenantIds.includes(preset.tenantId)) return;
    const refs = editing[kind];
    const selected = refs.some((ref) => ref.tenantId === preset.tenantId && ref.presetId === preset.id);
    update(kind, selected
      ? refs.filter((ref) => !(ref.tenantId === preset.tenantId && ref.presetId === preset.id))
      : [...refs, { tenantId: preset.tenantId, presetId: preset.id }]);
  };

  const save = async (publish = false) => {
    if (!editing) return;
    setIsSaving(true);
    setError(null);
    try {
      const response = editing.id
        ? await api.admin.updateAgentTemplate(editing.id, editing)
        : await api.admin.createAgentTemplate(editing);
      const saved = (await readJson<{ template: AgentTemplate }>(response)).template;
      const finalTemplate = publish
        ? (await readJson<{ template: AgentTemplate }>(await api.admin.publishAgentTemplate(saved.id))).template
        : saved;
      setEditing(finalTemplate);
      await loadTemplates();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '模板保存失败');
    } finally {
      setIsSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div><h2 className="text-xl font-semibold text-foreground">Agent 模板</h2><p className="mt-1 text-sm text-muted-foreground">为不同租户预配置 Agent.md、Skills、MCP 和引导语。</p></div>
          <div className="flex items-center gap-2">
            <label htmlFor="agent-template-tenant" className="text-sm text-muted-foreground">配置租户</label>
            <select
              id="agent-template-tenant"
              className="h-9 min-w-40 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm"
              value={tenantId || ''}
              onChange={(event) => {
                const nextTenantId = Number(event.target.value);
                setTenantId(nextTenantId);
                setCatalogTenantId(nextTenantId);
                setError(null);
              }}
            >
              {activeTenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
            </select>
            <Button onClick={beginCreate} disabled={!tenantId}><Plus className="h-4 w-4" />新建模板</Button>
          </div>
        </div>
        {error ? <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div> : null}
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {isLoading ? <div className="flex justify-center p-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div> : null}
          {!isLoading && templates.length === 0 ? <div className="p-10 text-center text-sm text-muted-foreground">该租户暂无 Agent 模板</div> : null}
          {templates.map((template) => (
            <button key={template.id} type="button" onClick={() => { setEditing(template); setCatalogTenantId(template.tenantIds.includes(Number(tenantId)) ? tenantId : template.tenantIds[0] || null); }} className="flex w-full items-center gap-4 border-b border-border px-4 py-4 text-left last:border-b-0 hover:bg-muted/50">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary"><Sparkles className="h-5 w-5" /></span>
              <span className="min-w-0 flex-1"><span className="block font-medium text-foreground">{template.name}</span><span className="mt-1 block truncate text-sm text-muted-foreground">{template.summary || '暂无描述'}</span></span>
              <span className={cn('rounded-full px-2.5 py-1 text-xs', template.status === 'published' ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground')}>{statusLabel(template.status)}</span>
              <span className="text-sm text-muted-foreground">{template.globalVisible ? '全部租户可见' : `${template.tenantIds.length} 个租户`}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const selectedCatalogTenant = activeTenants.find((tenant) => tenant.id === catalogTenantId);
  const dataAgentSelected = editing.tenantIds.some((id) => isDataAgentTenant(activeTenants.find((item) => item.id === id)));

  return (
    <div className="mx-auto max-w-6xl space-y-4 pb-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><button type="button" onClick={() => setEditing(null)} className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ChevronLeft className="h-4 w-4" />返回模板列表</button><h2 className="text-xl font-semibold text-foreground">配置 Agent 模板</h2></div>
        <div className="flex gap-2"><Button variant="secondary" onClick={() => void save(false)} disabled={isSaving}><Save className="h-4 w-4" />保存草稿</Button><Button onClick={() => void save(true)} disabled={isSaving}>{isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}发布模板</Button></div>
      </div>
      {error ? <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div> : null}

      <section className="space-y-4 rounded-lg border border-border bg-card p-5">
        <div><h3 className="font-semibold text-foreground">基本信息</h3><p className="mt-1 text-sm text-muted-foreground">用于用户在创建项目时识别和选择模板。</p></div>
        <label className="block space-y-1.5"><span className="text-sm font-medium text-foreground">模板名称</span><Input value={editing.name} onChange={(event) => update('name', event.target.value)} placeholder="例如：应用市场分析专家" /></label>
        <label className="block space-y-1.5"><span className="text-sm font-medium text-foreground">模板简介</span><Input value={editing.summary} onChange={(event) => update('summary', event.target.value)} placeholder="简要说明模板能帮助用户完成什么" /></label>
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-5">
        <div><h3 className="font-semibold text-foreground">Agent 配置</h3><p className="mt-1 text-sm text-muted-foreground">内容会写入新项目的 Agent.md，并转换为 Claude Code SDK 项目指令。</p></div>
        <label className="block space-y-1.5"><span className="text-sm font-medium text-foreground">Agent.md</span><textarea value={editing.agentMarkdown} onChange={(event) => update('agentMarkdown', event.target.value)} rows={10} className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" placeholder="# Role&#10;你是一名应用市场分析专家……" /></label>
      </section>

      <section className="space-y-5 rounded-lg border border-border bg-card p-5">
        <div><h3 className="font-semibold text-foreground">Skills 与 MCP</h3><p className="mt-1 text-sm text-muted-foreground">先指定可见租户，再选择该租户下已发布的能力。模板只保存引用，不保存密钥。</p></div>
        <div>
          <div className="mb-2 text-sm font-medium text-foreground">指定租户</div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {activeTenants.map((tenant) => {
              const selected = editing.tenantIds.includes(tenant.id);
              const disabled = dataAgentSelected && !isDataAgentTenant(tenant);
              return <button key={tenant.id} type="button" disabled={disabled} onClick={() => toggleTenant(tenant.id)} className={cn('flex items-center gap-3 rounded-md border px-3 py-3 text-left disabled:cursor-not-allowed disabled:opacity-45', selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50')}><span className={cn('flex h-5 w-5 items-center justify-center rounded border', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input')}>{selected ? <Check className="h-3.5 w-3.5" /> : null}</span><span><span className="block text-sm font-medium text-foreground">{tenant.name}</span><span className="block text-xs text-muted-foreground">{tenant.code}</span></span></button>;
            })}
          </div>
          {dataAgentSelected ? <div className="mt-2 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">已选择 DataAgent管理：发布后该模板默认对全部租户可见。</div> : null}
        </div>

        {editing.tenantIds.length > 0 ? <div className="flex flex-wrap gap-2">{editing.tenantIds.map((tenantId) => { const tenant = activeTenants.find((item) => item.id === tenantId); return <button key={tenantId} type="button" onClick={() => setCatalogTenantId(tenantId)} className={cn('rounded-md border px-3 py-1.5 text-sm', catalogTenantId === tenantId ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground')}>{tenant?.name || tenantId}</button>; })}</div> : null}

        {selectedCatalogTenant && editing.tenantIds.includes(selectedCatalogTenant.id) ? (
          <div className="grid gap-5 lg:grid-cols-2">
            <PresetList title="Skills" emptyText="该租户暂无已发布 Skill" presets={catalog.skills} refs={editing.skillPresetRefs} onToggle={(preset) => togglePreset('skillPresetRefs', preset)} />
            <PresetList title="MCP 工具" emptyText="该租户暂无测试通过的已发布 MCP" presets={catalog.mcps} refs={editing.mcpPresetRefs} onToggle={(preset) => togglePreset('mcpPresetRefs', preset)} />
          </div>
        ) : <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">请先选择至少一个租户</div>}
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-5">
        <div><h3 className="font-semibold text-foreground">引导语</h3><p className="mt-1 text-sm text-muted-foreground">项目创建后展示给用户，不会自动发送给模型。</p></div>
        <textarea value={editing.guideText} onChange={(event) => update('guideText', event.target.value)} rows={5} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" placeholder="例如：告诉我需要分析的应用名称、目标市场和你最关注的问题。" />
      </section>
    </div>
  );
}

function PresetList({ title, emptyText, presets, refs, onToggle }: { title: string; emptyText: string; presets: Preset[]; refs: PresetRef[]; onToggle: (preset: Preset) => void }) {
  return <div><h4 className="mb-2 text-sm font-medium text-foreground">{title}</h4><div className="space-y-2">{presets.length === 0 ? <div className="rounded-md border border-dashed border-border p-5 text-center text-sm text-muted-foreground">{emptyText}</div> : presets.map((preset) => { const selected = refs.some((ref) => ref.tenantId === preset.tenantId && ref.presetId === preset.id); return <button key={preset.id} type="button" onClick={() => onToggle(preset)} className={cn('flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left', selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50')}><span className={cn('flex h-5 w-5 items-center justify-center rounded border', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input')}>{selected ? <Check className="h-3.5 w-3.5" /> : null}</span><span><span className="block text-sm font-medium text-foreground">{preset.displayName || preset.name}</span>{preset.description ? <span className="mt-0.5 block text-xs text-muted-foreground">{preset.description}</span> : null}</span></button>; })}</div></div>;
}
