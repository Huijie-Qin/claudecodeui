import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, Loader2, Plus, Save, Sparkles } from 'lucide-react';

import { api } from '../../utils/api';
import { Button, Input } from '../../shared/view/ui';
import { cn } from '../../lib/utils';

type Tenant = { id: number; code: string; name: string; status: string };
type PresetRef = { tenantId: number; presetId: number };
type MarketSkill = {
  id?: string;
  skillId?: string;
  name: string;
  displayName?: string;
  description?: string;
  nspPath?: string;
  createUserId?: string;
  version?: number;
};
type AdminSkillPreset = {
  id: number;
  tenantId: number;
  name: string;
  displayName: string;
  description?: string;
  skillId?: string;
  remoteId?: string;
  status: 'draft' | 'published' | 'disabled';
  lastValidationStatus?: string | null;
};
type AgentTemplate = {
  id: number;
  name: string;
  category: string;
  summary: string;
  claudeMarkdown: string;
  agentMarkdown?: string;
  guideText: string;
  tenantIds: number[];
  skillPresetRefs: PresetRef[];
  mcpPresetRefs: PresetRef[];
  globalVisible: boolean;
  status: 'draft' | 'published' | 'disabled';
};
type Preset = { id: number; tenantId: number; name: string; displayName: string; description?: string };
type SkillCandidate = Preset & {
  sourceRef: string;
  presetId?: number;
  status?: AdminSkillPreset['status'];
  lastValidationStatus?: string | null;
  marketSkill?: MarketSkill;
};
type Catalog = { skills: SkillCandidate[]; mcps: Preset[] };

function normalizeId(value: unknown) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : 0;
}

function normalizePresetRef(ref: PresetRef): PresetRef {
  return {
    tenantId: normalizeId(ref.tenantId),
    presetId: normalizeId(ref.presetId),
  };
}

function normalizeTemplate(template: AgentTemplate): AgentTemplate {
  return {
    ...template,
    id: normalizeId(template.id),
    category: template.category || '',
    claudeMarkdown: template.claudeMarkdown ?? template.agentMarkdown ?? '',
    tenantIds: [...new Set((template.tenantIds || []).map(normalizeId).filter(Boolean))],
    skillPresetRefs: (template.skillPresetRefs || []).map(normalizePresetRef)
      .filter((ref) => ref.tenantId && ref.presetId),
    mcpPresetRefs: (template.mcpPresetRefs || []).map(normalizePresetRef)
      .filter((ref) => ref.tenantId && ref.presetId),
  };
}

function normalizeCatalog(payload: { skills?: Preset[]; mcps?: Preset[] }): Catalog {
  const normalizePreset = (preset: Preset): Preset => ({
    ...preset,
    id: normalizeId(preset.id),
    tenantId: normalizeId(preset.tenantId),
  });
  return {
    skills: (payload.skills || []).map(normalizePreset)
      .filter((preset) => preset.id && preset.tenantId)
      .map((preset) => ({ ...preset, sourceRef: preset.name, presetId: preset.id, status: 'published' })),
    mcps: (payload.mcps || []).map(normalizePreset).filter((preset) => preset.id && preset.tenantId),
  };
}

function normalizedSkillRef(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function marketSkillRef(skill: MarketSkill) {
  return String(skill.id || skill.skillId || skill.name || '').trim();
}

function buildSkillCandidates({
  tenantId,
  marketSkills,
  presets,
  publishedSkills,
}: {
  tenantId: number;
  marketSkills: MarketSkill[];
  presets: AdminSkillPreset[];
  publishedSkills: SkillCandidate[];
}) {
  const candidateByKey = new Map<string, SkillCandidate>();
  const findPreset = (skill: MarketSkill) => {
    const refs = new Set([
      skill.id,
      skill.skillId,
      skill.name,
    ].map(normalizedSkillRef).filter(Boolean));
    return presets.find((preset) => [preset.remoteId, preset.skillId, preset.name]
      .map(normalizedSkillRef)
      .some((ref) => refs.has(ref)));
  };

  for (const skill of marketSkills) {
    const sourceRef = marketSkillRef(skill);
    if (!sourceRef) continue;
    const preset = findPreset(skill);
    const presetId = normalizeId(preset?.id);
    const key = normalizedSkillRef(sourceRef);
    candidateByKey.set(key, {
      id: presetId,
      presetId: presetId || undefined,
      tenantId,
      sourceRef,
      name: skill.name || sourceRef,
      displayName: skill.displayName || skill.name || sourceRef,
      description: skill.description || '',
      status: preset?.status,
      lastValidationStatus: preset?.lastValidationStatus,
      marketSkill: skill,
    });
  }

  // Keep already-published presets selectable if the market temporarily omits
  // them (for example because of pagination or a transient remote failure).
  for (const skill of publishedSkills) {
    const key = normalizedSkillRef(skill.sourceRef || skill.name);
    const alreadyMapped = Boolean(skill.presetId)
      && [...candidateByKey.values()].some((candidate) => candidate.presetId === skill.presetId);
    if (!alreadyMapped && !candidateByKey.has(key)) candidateByKey.set(key, skill);
  }
  return [...candidateByKey.values()];
}

const EMPTY_TEMPLATE: Omit<AgentTemplate, 'id'> = {
  name: '',
  category: '',
  summary: '',
  claudeMarkdown: '',
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
  const activeTenants = useMemo(() => tenants
    .map((tenant) => ({ ...tenant, id: normalizeId(tenant.id) }))
    .filter((tenant) => tenant.id && tenant.status === 'active'), [tenants]);
  const normalizedCurrentTenantId = normalizeId(currentTenantId);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [editing, setEditing] = useState<(AgentTemplate | (Omit<AgentTemplate, 'id'> & { id?: undefined })) | null>(null);
  const [tenantId, setTenantId] = useState<number | null>(normalizedCurrentTenantId || activeTenants[0]?.id || null);
  const [catalogTenantId, setCatalogTenantId] = useState<number | null>(tenantId);
  const [catalog, setCatalog] = useState<Catalog>({ skills: [], mcps: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isAddingCategory, setIsAddingCategory] = useState(false);
  const [preparingSkillKeys, setPreparingSkillKeys] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const availableCategories = useMemo(() => [...new Set(templates
    .map((template) => template.category?.trim())
    .filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN')), [templates]);

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
      setTemplates((payload.templates || []).map(normalizeTemplate));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '模板加载失败');
    } finally {
      setIsLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void loadTemplates(); }, [loadTemplates]);

  useEffect(() => {
    if (!tenantId && activeTenants[0]?.id) {
      setTenantId(normalizedCurrentTenantId || activeTenants[0].id);
      setCatalogTenantId(normalizedCurrentTenantId || activeTenants[0].id);
    }
  }, [activeTenants, normalizedCurrentTenantId, tenantId]);

  useEffect(() => {
    if (!catalogTenantId) {
      setCatalog({ skills: [], mcps: [] });
      return;
    }
    let cancelled = false;
    void Promise.all([
      api.admin.agentTemplatePresetCatalog(catalogTenantId).then((response) => readJson<{ skills?: Preset[]; mcps?: Preset[] }>(response)),
      api.admin.searchSkillPresetMarket(catalogTenantId, { pageSize: 200 }).then((response) => readJson<{ skills?: MarketSkill[] }>(response)),
      api.admin.skillPresets(catalogTenantId).then((response) => readJson<{ presets?: AdminSkillPreset[] }>(response)),
    ])
      .then(([presetCatalog, marketCatalog, presetPayload]) => {
        if (cancelled) return;
        const normalized = normalizeCatalog(presetCatalog);
        setCatalog({
          ...normalized,
          skills: buildSkillCandidates({
            tenantId: catalogTenantId,
            marketSkills: marketCatalog.skills || [],
            presets: presetPayload.presets || [],
            publishedSkills: normalized.skills,
          }),
        });
      })
      .catch((catalogError) => { if (!cancelled) setError(catalogError instanceof Error ? catalogError.message : '预设加载失败'); });
    return () => { cancelled = true; };
  }, [catalogTenantId]);

  const beginCreate = () => {
    const initialTenantId = tenantId || normalizedCurrentTenantId || activeTenants[0]?.id;
    setEditing({ ...EMPTY_TEMPLATE, tenantIds: initialTenantId ? [initialTenantId] : [] });
    setCatalogTenantId(initialTenantId || null);
    setIsAddingCategory(availableCategories.length === 0);
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

  const toggleSkill = async (skill: SkillCandidate) => {
    if (!editing || !editing.tenantIds.includes(skill.tenantId)) return;
    const selected = skill.presetId
      ? editing.skillPresetRefs.some((ref) => ref.tenantId === skill.tenantId && ref.presetId === skill.presetId)
      : false;
    if (selected && skill.presetId) {
      togglePreset('skillPresetRefs', { ...skill, id: skill.presetId });
      return;
    }

    const skillKey = `${skill.tenantId}:${skill.sourceRef}`;
    if (preparingSkillKeys.has(skillKey)) return;
    setPreparingSkillKeys((previous) => new Set(previous).add(skillKey));
    setError(null);
    try {
      let preset: AdminSkillPreset | undefined = skill.presetId ? {
        id: skill.presetId,
        tenantId: skill.tenantId,
        name: skill.name,
        displayName: skill.displayName,
        description: skill.description,
        status: skill.status || 'draft',
        lastValidationStatus: skill.lastValidationStatus,
      } : undefined;

      if (!preset) {
        const created = await readJson<{ preset: AdminSkillPreset }>(await api.admin.createSkillPreset({
          tenantId: skill.tenantId,
          sourceRef: skill.sourceRef,
          skill: skill.marketSkill,
          preinstall: false,
          status: 'draft',
        }));
        preset = created.preset;
      }
      if (preset.lastValidationStatus !== 'healthy') {
        const validated = await readJson<{ preset: AdminSkillPreset; validation?: { status?: string; error?: string } }>(
          await api.admin.validateSkillPreset(preset.id, skill.tenantId),
        );
        if (validated.validation?.status && validated.validation.status !== 'healthy') {
          throw new Error(validated.validation.error || 'Skill 校验失败');
        }
        preset = validated.preset || preset;
      }
      if (preset.status !== 'published') {
        const published = await readJson<{ preset: AdminSkillPreset }>(
          await api.admin.publishSkillPreset(preset.id, skill.tenantId),
        );
        preset = published.preset;
      }

      const presetId = normalizeId(preset.id);
      setCatalog((previous) => ({
        ...previous,
        skills: previous.skills.map((candidate) => candidate.tenantId === skill.tenantId
          && candidate.sourceRef === skill.sourceRef
          ? {
            ...candidate,
            id: presetId,
            presetId,
            status: 'published',
            lastValidationStatus: 'healthy',
          }
          : candidate),
      }));
      setEditing((previous) => {
        if (!previous || !previous.tenantIds.includes(skill.tenantId)) return previous;
        if (previous.skillPresetRefs.some((ref) => ref.tenantId === skill.tenantId && ref.presetId === presetId)) {
          return previous;
        }
        return {
          ...previous,
          skillPresetRefs: [...previous.skillPresetRefs, { tenantId: skill.tenantId, presetId }],
        };
      });
    } catch (skillError) {
      setError(skillError instanceof Error ? skillError.message : 'Skill 准备失败');
    } finally {
      setPreparingSkillKeys((previous) => {
        const next = new Set(previous);
        next.delete(skillKey);
        return next;
      });
    }
  };

  const save = async (publish = false) => {
    if (!editing) return;
    if (!editing.category.trim()) {
      setError('请选择或新建模板分类');
      return;
    }
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
      setEditing(normalizeTemplate(finalTemplate));
      await loadTemplates();
      setIsAddingCategory(false);
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
          <div><h2 className="text-xl font-semibold text-foreground">Agent 模板</h2><p className="mt-1 text-sm text-muted-foreground">为不同租户预配置 CLAUDE.md、Skills、MCP 和引导语。</p></div>
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
            <button key={template.id} type="button" onClick={() => { setEditing(template); setIsAddingCategory(false); setCatalogTenantId(template.tenantIds.includes(Number(tenantId)) ? tenantId : template.tenantIds[0] || null); }} className="flex w-full items-center gap-4 border-b border-border px-4 py-4 text-left last:border-b-0 hover:bg-muted/50">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary"><Sparkles className="h-5 w-5" /></span>
              <span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="block font-medium text-foreground">{template.name}</span><span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{template.category || '未分类'}</span></span><span className="mt-1 block truncate text-sm text-muted-foreground">{template.summary || '暂无描述'}</span></span>
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
        <div className="space-y-1.5">
          <label htmlFor="agent-template-category" className="text-sm font-medium text-foreground">模板分类 <span className="text-destructive">*</span></label>
          <select
            id="agent-template-category"
            required
            value={isAddingCategory ? '__new__' : editing.category}
            onChange={(event) => {
              if (event.target.value === '__new__') {
                setIsAddingCategory(true);
                update('category', '');
                return;
              }
              setIsAddingCategory(false);
              update('category', event.target.value);
            }}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">请选择分类</option>
            {availableCategories.map((category) => <option key={category} value={category}>{category}</option>)}
            <option value="__new__">+新建分类</option>
          </select>
          {isAddingCategory ? <Input autoFocus required value={editing.category} onChange={(event) => update('category', event.target.value)} maxLength={50} placeholder="输入新分类名称，例如：市场分析" /> : null}
          <span className="block text-xs text-muted-foreground">分类为必填项，可选择当前租户已有分类或创建新分类。</span>
        </div>
        <label className="block space-y-1.5"><span className="text-sm font-medium text-foreground">模板简介</span><Input value={editing.summary} onChange={(event) => update('summary', event.target.value)} placeholder="简要说明模板能帮助用户完成什么" /></label>
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-5">
        <div><h3 className="font-semibold text-foreground">Agent 配置</h3><p className="mt-1 text-sm text-muted-foreground">内容会写入新项目的 CLAUDE.md，作为 Claude Code SDK 加载的项目记忆。</p></div>
        <label className="block space-y-1.5"><span className="text-sm font-medium text-foreground">CLAUDE.md</span><textarea value={editing.claudeMarkdown} onChange={(event) => update('claudeMarkdown', event.target.value)} rows={10} className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" placeholder="# Project Memory&#10;你是一名应用市场分析专家……" /></label>
      </section>

      <section className="space-y-5 rounded-lg border border-border bg-card p-5">
        <div><h3 className="font-semibold text-foreground">Skills 与 MCP</h3><p className="mt-1 text-sm text-muted-foreground">先指定可见租户，再从该租户技能市场选择 Skill，并选择已发布的 MCP。模板只保存引用，不保存密钥。</p></div>
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
            <PresetList title="Skills" emptyText="该租户技能市场暂无可用 Skill" presets={catalog.skills} refs={editing.skillPresetRefs} loadingKeys={preparingSkillKeys} onToggle={(preset) => void toggleSkill(preset as SkillCandidate)} />
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

function PresetList({ title, emptyText, presets, refs, loadingKeys = new Set(), onToggle }: { title: string; emptyText: string; presets: (Preset | SkillCandidate)[]; refs: PresetRef[]; loadingKeys?: Set<string>; onToggle: (preset: Preset | SkillCandidate) => void }) {
  return <div><h4 className="mb-2 text-sm font-medium text-foreground">{title}</h4><div className="space-y-2">{presets.length === 0 ? <div className="rounded-md border border-dashed border-border p-5 text-center text-sm text-muted-foreground">{emptyText}</div> : presets.map((preset) => { const presetId = 'presetId' in preset ? preset.presetId : preset.id; const skillKey = 'sourceRef' in preset ? `${preset.tenantId}:${preset.sourceRef}` : ''; const loading = loadingKeys.has(skillKey); const selected = Boolean(presetId) && refs.some((ref) => ref.tenantId === preset.tenantId && ref.presetId === presetId); return <button key={presetId || skillKey} type="button" disabled={loading} onClick={() => onToggle(preset)} className={cn('flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left disabled:cursor-wait disabled:opacity-70', selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50')}><span className={cn('flex h-5 w-5 items-center justify-center rounded border', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input')}>{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : selected ? <Check className="h-3.5 w-3.5" /> : null}</span><span><span className="block text-sm font-medium text-foreground">{preset.displayName || preset.name}</span>{preset.description ? <span className="mt-0.5 block text-xs text-muted-foreground">{preset.description}</span> : null}</span></button>; })}</div></div>;
}
