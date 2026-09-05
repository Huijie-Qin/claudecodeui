import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, ChevronLeft, Loader2, Plus, Power, Save, Search, SlidersHorizontal, Sparkles, Tags, Trash2, X } from 'lucide-react';

import { api } from '../../utils/api';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../shared/view/ui';
import { cn } from '../../lib/utils';
import type { WorkspaceMcpTool } from '../tools-market/hooks/useWorkspaceMcpTools';
import type { McpTemplateToolSettings } from '../tools-market/mcpToolOverrides';

import AgentTemplateMcpSettingsDialog from './AgentTemplateMcpSettingsDialog';

type Tenant = { id: number; code: string; name: string; status: string };
type PresetRef = { tenantId: number; presetId: number; toolSettings?: McpTemplateToolSettings };
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
  source?: {
    id?: string;
    skillId?: string;
    name?: string;
    displayName?: string;
    downloadedSkillName?: string;
  };
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
  unavailableCapabilities?: Array<{
    type: 'skill' | 'mcp';
    id: number;
    name: string;
    unavailableReason?: string;
  }>;
};
type Preset = {
  id: number;
  tenantId: number;
  name: string;
  displayName: string;
  description?: string;
  toolCount?: number;
  tools?: WorkspaceMcpTool[];
};
type SkillCandidate = Preset & {
  sourceRef: string;
  presetId?: number;
  status?: AdminSkillPreset['status'];
  lastValidationStatus?: string | null;
  marketSkill?: MarketSkill;
};
type Catalog = { skills: SkillCandidate[]; mcps: Preset[] };
type TemplateCategory = { id: number; name: string; templateCount: number };
type Toast = { type: 'success' | 'error'; message: string } | null;
type CategoryFeedback = { type: 'success' | 'error'; message: string } | null;

function normalizeId(value: unknown) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : 0;
}

function normalizePresetRef(ref: PresetRef): PresetRef {
  return {
    tenantId: normalizeId(ref.tenantId),
    presetId: normalizeId(ref.presetId),
    ...(ref.toolSettings ? { toolSettings: ref.toolSettings } : {}),
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
      skill.displayName,
    ].map(normalizedSkillRef).filter(Boolean));
    return presets.find((preset) => [
      preset.remoteId,
      preset.skillId,
      preset.name,
      preset.displayName,
      preset.source?.id,
      preset.source?.skillId,
      preset.source?.name,
      preset.source?.displayName,
      preset.source?.downloadedSkillName,
    ]
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
  const [categories, setCategories] = useState<TemplateCategory[]>([]);
  const [editing, setEditing] = useState<(AgentTemplate | (Omit<AgentTemplate, 'id'> & { id?: undefined })) | null>(null);
  const [tenantFilterIds, setTenantFilterIds] = useState<number[]>(normalizedCurrentTenantId ? [normalizedCurrentTenantId] : []);
  const [tenantFilterSearch, setTenantFilterSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [catalogTenantId, setCatalogTenantId] = useState<number | null>(normalizedCurrentTenantId || activeTenants[0]?.id || null);
  const [catalog, setCatalog] = useState<Catalog>({ skills: [], mcps: [] });
  const [isCatalogLoading, setIsCatalogLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isAddingCategory, setIsAddingCategory] = useState(false);
  const [preparingSkillKeys, setPreparingSkillKeys] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<Toast>(null);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [categoryFeedback, setCategoryFeedback] = useState<CategoryFeedback>(null);
  const [isCategorySaving, setIsCategorySaving] = useState(false);
  const [actionTemplateId, setActionTemplateId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentTemplate | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [configuringMcp, setConfiguringMcp] = useState<Preset | null>(null);
  const isEditing = editing !== null;
  const availableCategories = useMemo(() => categories.map((category) => category.name), [categories]);
  const filteredTenantOptions = useMemo(() => {
    const keyword = tenantFilterSearch.trim().toLocaleLowerCase();
    return keyword
      ? activeTenants.filter((tenant) => `${tenant.name} ${tenant.code}`.toLocaleLowerCase().includes(keyword))
      : activeTenants;
  }, [activeTenants, tenantFilterSearch]);
  const filteredTemplates = useMemo(() => templates.filter((template) => {
    const matchesTenants = tenantFilterIds.length === 0
      || template.globalVisible
      || tenantFilterIds.every((tenantId) => template.tenantIds.includes(tenantId));
    const matchesCategory = !categoryFilter || template.category === categoryFilter;
    return matchesTenants && matchesCategory;
  }), [categoryFilter, templates, tenantFilterIds]);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const loadTemplates = useCallback(async () => {
    setIsLoading(true);
    setListError(null);
    try {
      const payload = await readJson<{ templates: AgentTemplate[] }>(await api.admin.agentTemplates());
      setTemplates((payload.templates || []).map(normalizeTemplate));
    } catch (loadError) {
      setListError(loadError instanceof Error ? loadError.message : '模板加载失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadCategories = useCallback(async () => {
    const payload = await readJson<{ categories: TemplateCategory[] }>(await api.admin.agentTemplateCategories());
    setCategories((payload.categories || []).map((category) => ({
      ...category,
      id: normalizeId(category.id),
      templateCount: Number(category.templateCount || 0),
    })));
  }, []);

  useEffect(() => {
    void Promise.all([loadTemplates(), loadCategories()]).catch((loadError) => {
      setListError(loadError instanceof Error ? loadError.message : '模板数据加载失败');
    });
  }, [loadCategories, loadTemplates]);

  useEffect(() => {
    if (!isEditing || !catalogTenantId) {
      setCatalog({ skills: [], mcps: [] });
      setIsCatalogLoading(false);
      return;
    }
    let cancelled = false;
    setCatalog({ skills: [], mcps: [] });
    setIsCatalogLoading(true);
    void Promise.allSettled([
      api.admin.agentTemplatePresetCatalog(catalogTenantId).then((response) => readJson<{ skills?: Preset[]; mcps?: Preset[] }>(response)),
      api.admin.searchSkillPresetMarket(catalogTenantId, { complete: true }).then((response) => readJson<{ skills?: MarketSkill[] }>(response)),
      api.admin.skillPresets(catalogTenantId).then((response) => readJson<{ presets?: AdminSkillPreset[] }>(response)),
    ])
      .then(([presetResult, marketResult, presetListResult]) => {
        if (cancelled) return;
        const presetCatalog = presetResult.status === 'fulfilled' ? presetResult.value : {};
        const marketCatalog = marketResult.status === 'fulfilled' ? marketResult.value : {};
        const presetPayload = presetListResult.status === 'fulfilled' ? presetListResult.value : {};
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
        const failedCatalogLabels = [
          ...(presetResult.status === 'rejected' ? ['Skill 与 MCP'] : []),
          ...(marketResult.status === 'rejected' ? ['技能市场'] : []),
          ...(presetListResult.status === 'rejected' ? ['Skill 预置'] : []),
        ];
        if (failedCatalogLabels.length > 0) {
          setEditorError(`部分能力目录加载失败：${failedCatalogLabels.join('、')}。其余已加载能力仍可配置。`);
        }
      })
      .finally(() => { if (!cancelled) setIsCatalogLoading(false); });
    return () => { cancelled = true; };
  }, [catalogTenantId, isEditing]);

  const closeEditor = () => {
    setConfiguringMcp(null);
    setEditing(null);
    setIsAddingCategory(false);
    setEditorError(null);
  };

  const beginEdit = (template: AgentTemplate) => {
    setListError(null);
    setEditorError(null);
    setEditing(template);
    setIsAddingCategory(false);
    setCatalogTenantId(template.tenantIds[0] || null);
  };

  const beginCreate = () => {
    const initialTenantId = tenantFilterIds[0] || normalizedCurrentTenantId || activeTenants[0]?.id;
    setEditing({ ...EMPTY_TEMPLATE, tenantIds: initialTenantId ? [initialTenantId] : [] });
    setCatalogTenantId(initialTenantId || null);
    setIsAddingCategory(availableCategories.length === 0);
    setListError(null);
    setEditorError(null);
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

  const saveMcpToolSettings = (preset: Preset, toolSettings: McpTemplateToolSettings) => {
    setEditing((previous) => {
      if (!previous) return previous;
      return {
        ...previous,
        mcpPresetRefs: previous.mcpPresetRefs.map((ref) => (
          ref.tenantId === preset.tenantId && ref.presetId === preset.id
            ? { ...ref, toolSettings }
            : ref
        )),
      };
    });
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
    setEditorError(null);
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
      setEditorError(skillError instanceof Error ? skillError.message : 'Skill 准备失败');
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
      setEditorError('请选择或新建模板分类');
      return;
    }
    setIsSaving(true);
    setEditorError(null);
    try {
      const response = editing.id
        ? await api.admin.updateAgentTemplate(editing.id, editing)
        : await api.admin.createAgentTemplate(editing);
      const saved = (await readJson<{ template: AgentTemplate }>(response)).template;
      const finalTemplate = publish
        ? (await readJson<{ template: AgentTemplate }>(await api.admin.publishAgentTemplate(saved.id))).template
        : saved;
      await Promise.all([loadTemplates(), loadCategories()]);
      setIsAddingCategory(false);
      if (publish) {
        setTenantFilterIds(finalTemplate.tenantIds || []);
        closeEditor();
        showToast(`Agent 模板“${finalTemplate.name}”发布成功`);
      } else {
        setEditing(normalizeTemplate(finalTemplate));
        showToast('草稿保存成功');
      }
    } catch (saveError) {
      setEditorError(saveError instanceof Error ? saveError.message : '模板保存失败');
    } finally {
      setIsSaving(false);
    }
  };

  const toggleTenantFilter = (filterTenantId: number) => {
    setTenantFilterIds((previous) => previous.includes(filterTenantId)
      ? previous.filter((id) => id !== filterTenantId)
      : [...previous, filterTenantId]);
  };

  const disableTemplate = async (template: AgentTemplate) => {
    setActionTemplateId(template.id);
    setListError(null);
    try {
      await readJson(await api.admin.disableAgentTemplate(template.id));
      await loadTemplates();
      showToast(`Agent 模板“${template.name}”${template.status === 'published' ? '已下线' : '已停用'}`);
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : '模板下线失败';
      setListError(message);
      showToast(message, 'error');
    } finally {
      setActionTemplateId(null);
    }
  };

  const deleteTemplate = async () => {
    if (!deleteTarget) return;
    setActionTemplateId(deleteTarget.id);
    setListError(null);
    try {
      await readJson(await api.admin.deleteAgentTemplate(deleteTarget.id));
      await Promise.all([loadTemplates(), loadCategories()]);
      showToast(`Agent 模板“${deleteTarget.name}”已删除`);
      setDeleteTarget(null);
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : '模板删除失败';
      setListError(message);
      showToast(message, 'error');
    } finally {
      setActionTemplateId(null);
    }
  };

  const createCategory = async () => {
    const name = newCategoryName.trim();
    if (!name) return;
    if (categories.some((category) => category.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setCategoryFeedback({ type: 'error', message: `Agent 模板分类“${name}”已存在，请使用其他名称` });
      return;
    }
    setIsCategorySaving(true);
    setCategoryFeedback(null);
    try {
      await readJson(await api.admin.createAgentTemplateCategory(name));
      await loadCategories();
      setNewCategoryName('');
      setCategoryFeedback({ type: 'success', message: `分类“${name}”已创建` });
    } catch (categoryError) {
      setCategoryFeedback({ type: 'error', message: categoryError instanceof Error ? categoryError.message : '分类创建失败' });
    } finally {
      setIsCategorySaving(false);
    }
  };

  const deleteCategory = async (category: TemplateCategory) => {
    if (category.templateCount > 0) return;
    setIsCategorySaving(true);
    setCategoryFeedback(null);
    try {
      await readJson(await api.admin.deleteAgentTemplateCategory(category.id));
      await loadCategories();
      setCategoryFeedback({ type: 'success', message: `分类“${category.name}”已删除` });
    } catch (categoryError) {
      setCategoryFeedback({ type: 'error', message: categoryError instanceof Error ? categoryError.message : '分类删除失败' });
    } finally {
      setIsCategorySaving(false);
    }
  };

  if (!editing) {
    return (
      <>
        <div className="mx-auto max-w-6xl space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div><h2 className="text-xl font-semibold text-foreground">Agent 模板</h2><p className="mt-1 text-sm text-muted-foreground">为不同租户预配置 CLAUDE.md、Skills、MCP 和引导语。</p></div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => { setCategoryFeedback(null); setCategoryDialogOpen(true); }}><Tags className="h-4 w-4" />分类管理</Button>
              <Button onClick={beginCreate} disabled={activeTenants.length === 0}><Plus className="h-4 w-4" />新建模板</Button>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="grid gap-5 md:grid-cols-[minmax(0,2fr)_minmax(220px,1fr)]">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-foreground">租户 · {tenantFilterIds.length}</div>
                  {tenantFilterIds.length > 0 ? <button type="button" className="text-xs text-primary hover:underline" onClick={() => setTenantFilterIds([])}>清空选择</button> : null}
                </div>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={tenantFilterSearch} onChange={(event) => setTenantFilterSearch(event.target.value)} placeholder="搜索租户" className="pl-9" aria-label="搜索租户" />
                </div>
                <div className="max-h-40 min-h-28 overflow-y-auto rounded-md border border-border px-3 py-2">
                  {filteredTenantOptions.length === 0 ? <div className="py-6 text-center text-sm text-muted-foreground">没有匹配的租户</div> : filteredTenantOptions.map((tenant) => {
                    const selected = tenantFilterIds.includes(tenant.id);
                    return (
                      <label key={tenant.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-sm text-foreground hover:bg-muted/50">
                        <input type="checkbox" checked={selected} onChange={() => toggleTenantFilter(tenant.id)} className="h-4 w-4 rounded border-input accent-primary" />
                        <span className="truncate">{tenant.name}</span>
                      </label>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">多选租户时，仅显示同时配置到所有已选租户的模板。</p>
              </div>

              <div className="space-y-2">
                <label htmlFor="agent-template-category-filter" className="text-sm font-medium text-foreground">模板分类</label>
                <select id="agent-template-category-filter" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary">
                  <option value="">全部分类</option>
                  {availableCategories.map((category) => <option key={category} value={category}>{category}</option>)}
                </select>
                <p className="text-xs text-muted-foreground">分类与租户条件会同时生效。</p>
              </div>
            </div>
          </div>

          {listError ? <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{listError}</div> : null}
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {isLoading ? <div className="flex justify-center p-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div> : null}
            {!isLoading && filteredTemplates.length === 0 ? <div className="p-10 text-center text-sm text-muted-foreground">当前筛选条件下暂无 Agent 模板</div> : null}
            {filteredTemplates.map((template) => {
              const tenantNames = template.tenantIds
                .map((id) => activeTenants.find((tenant) => tenant.id === id)?.name)
                .filter(Boolean);
              const actionLoading = actionTemplateId === template.id;
              return (
                <div key={template.id} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-muted/30">
                  <button type="button" onClick={() => beginEdit(template)} className="flex min-w-0 flex-1 items-center gap-4 rounded-md px-1 py-2 text-left">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Sparkles className="h-5 w-5" /></span>
                    <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><span className="block font-medium text-foreground">{template.name}</span><span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{template.category || '未分类'}</span>{template.unavailableCapabilities?.length ? <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"><AlertTriangle className="h-3 w-3" />{template.unavailableCapabilities.length} 项能力不可用</span> : null}</span><span className="mt-1 block truncate text-sm text-muted-foreground">{template.summary || '暂无描述'}</span><span className="mt-1 block truncate text-xs text-muted-foreground">配置租户：{template.globalVisible ? `全部租户可见（${tenantNames.join('、') || 'DataAgent管理'}）` : tenantNames.join('、') || '未知租户'}</span></span>
                    <span className={cn('rounded-full px-2.5 py-1 text-xs', template.status === 'published' ? 'bg-emerald-100 text-emerald-700' : template.status === 'disabled' ? 'bg-amber-100 text-amber-700' : 'bg-muted text-muted-foreground')}>{statusLabel(template.status)}</span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    {template.status !== 'disabled' ? <Button size="sm" variant="ghost" disabled={actionLoading} onClick={() => void disableTemplate(template)}><Power className="h-4 w-4" />{template.status === 'published' ? '下线' : '停用'}</Button> : null}
                    <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={actionLoading || template.status !== 'disabled'} title={template.status === 'disabled' ? '删除模板' : '请先下线或停用模板'} onClick={() => setDeleteTarget(template)}>{actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}删除</Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <CategoryManagementDialog open={categoryDialogOpen} onOpenChange={(open) => { setCategoryDialogOpen(open); if (!open) setCategoryFeedback(null); }} categories={categories} newCategoryName={newCategoryName} onNewCategoryNameChange={(name) => { setNewCategoryName(name); setCategoryFeedback(null); }} feedback={categoryFeedback} isSaving={isCategorySaving} onCreate={() => void createCategory()} onDelete={(category) => void deleteCategory(category)} />
        <DeleteTemplateDialog template={deleteTarget} isDeleting={deleteTarget != null && actionTemplateId === deleteTarget.id} onClose={() => setDeleteTarget(null)} onConfirm={() => void deleteTemplate()} />
        <ToastNotice toast={toast} onClose={() => setToast(null)} />
      </>
    );
  }

  const selectedCatalogTenant = activeTenants.find((tenant) => tenant.id === catalogTenantId);
  const dataAgentSelected = editing.tenantIds.some((id) => isDataAgentTenant(activeTenants.find((item) => item.id === id)));

  return (
    <div className="mx-auto max-w-6xl space-y-4 pb-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><button type="button" onClick={closeEditor} className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ChevronLeft className="h-4 w-4" />返回模板列表</button><h2 className="text-xl font-semibold text-foreground">配置 Agent 模板</h2></div>
        <div className="flex gap-2"><Button variant="secondary" onClick={() => void save(false)} disabled={isSaving}><Save className="h-4 w-4" />保存草稿</Button><Button onClick={() => void save(true)} disabled={isSaving}>{isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}发布模板</Button></div>
      </div>
      {editorError ? <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{editorError}</div> : null}
      {editing.unavailableCapabilities?.length ? <div className="flex items-start gap-2 rounded-md border border-amber-400/60 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>以下模板能力当前不可用，新项目创建时会自动跳过：{editing.unavailableCapabilities.map((capability) => `${capability.name}（${capability.unavailableReason || '不可用'}）`).join('、')}</span></div> : null}

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
              setEditorError(null);
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
          {isAddingCategory ? <Input autoFocus required value={editing.category} onChange={(event) => { setEditorError(null); update('category', event.target.value); }} maxLength={50} placeholder="输入新分类名称，例如：市场分析" /> : null}
          <span className="block text-xs text-muted-foreground">分类为必填项，可选择当前租户已有分类或创建新分类。</span>
        </div>
        <label className="block space-y-1.5"><span className="text-sm font-medium text-foreground">模板简介</span><Input value={editing.summary} onChange={(event) => update('summary', event.target.value)} placeholder="简要说明模板能帮助用户完成什么" /></label>
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-5">
        <div><h3 className="font-semibold text-foreground">Agent 配置</h3><p className="mt-1 text-sm text-muted-foreground">内容会写入新项目的 CLAUDE.md，作为 Claude Code SDK 加载的项目记忆。</p></div>
        <label className="block space-y-1.5"><span className="text-sm font-medium text-foreground">CLAUDE.md</span><textarea value={editing.claudeMarkdown} onChange={(event) => update('claudeMarkdown', event.target.value)} rows={10} className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" placeholder="# Project Memory&#10;你是一名应用市场分析专家……" /></label>
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-5">
        <div><h3 className="font-semibold text-foreground">引导语</h3><p className="mt-1 text-sm text-muted-foreground">项目创建后展示给用户，不会自动发送给模型。</p></div>
        <textarea value={editing.guideText} onChange={(event) => update('guideText', event.target.value)} rows={5} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring" placeholder="例如：告诉我需要分析的应用名称、目标市场和你最关注的问题。" />
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

        {isCatalogLoading ? (
          <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border p-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在加载该租户的能力目录…</div>
        ) : selectedCatalogTenant && editing.tenantIds.includes(selectedCatalogTenant.id) ? (
          <div className="space-y-6">
            <div className="grid gap-5 lg:grid-cols-2">
              <PresetList key={`${selectedCatalogTenant.id}:skills`} title="Skills" itemLabel="Skill" emptyText="该租户技能市场暂无可用 Skill" presets={catalog.skills} refs={editing.skillPresetRefs} loadingKeys={preparingSkillKeys} onToggle={(preset) => void toggleSkill(preset as SkillCandidate)} />
              <PresetList key={`${selectedCatalogTenant.id}:mcps`} title="MCP 工具" itemLabel="MCP" emptyText="该租户暂无测试通过的已发布 MCP" presets={catalog.mcps} refs={editing.mcpPresetRefs} onToggle={(preset) => togglePreset('mcpPresetRefs', preset)} onConfigure={(preset) => setConfiguringMcp(preset)} />
            </div>
          </div>
        ) : <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">请先选择至少一个租户</div>}
      </section>
      {configuringMcp ? <AgentTemplateMcpSettingsDialog
        key={`${configuringMcp.tenantId}:${configuringMcp.id}`}
        preset={configuringMcp}
        value={editing.mcpPresetRefs.find((ref) => ref.tenantId === configuringMcp.tenantId && ref.presetId === configuringMcp.id)?.toolSettings}
        onClose={() => setConfiguringMcp(null)}
        onSave={(toolSettings) => saveMcpToolSettings(configuringMcp, toolSettings)}
      /> : null}
      <ToastNotice toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}

function CategoryManagementDialog({
  open,
  onOpenChange,
  categories,
  newCategoryName,
  onNewCategoryNameChange,
  feedback,
  isSaving,
  onCreate,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: TemplateCategory[];
  newCategoryName: string;
  onNewCategoryNameChange: (name: string) => void;
  feedback: CategoryFeedback;
  isSaving: boolean;
  onCreate: () => void;
  onDelete: (category: TemplateCategory) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl overflow-hidden">
        <DialogTitle>Agent 模板分类管理</DialogTitle>
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div><h3 className="font-semibold text-foreground">分类管理</h3><p className="mt-1 text-sm text-muted-foreground">仅未被模板使用的分类可以删除。</p></div>
          <button type="button" onClick={() => onOpenChange(false)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-4 p-5">
          <div className="flex gap-2">
            <Input value={newCategoryName} maxLength={50} placeholder="输入新分类名称" onChange={(event) => onNewCategoryNameChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && newCategoryName.trim()) onCreate(); }} />
            <Button disabled={isSaving || !newCategoryName.trim()} onClick={onCreate}>{isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}新增</Button>
          </div>
          {feedback ? (
            <div className={cn(
              'flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm font-medium leading-5',
              feedback.type === 'error'
                ? 'border-red-500/70 bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300'
                : 'border-emerald-500/60 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
            )} role={feedback.type === 'error' ? 'alert' : 'status'} aria-live="polite">
              {feedback.type === 'error' ? <X className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
              <span>{feedback.message}</span>
            </div>
          ) : null}
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {categories.length === 0 ? <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">暂无分类</div> : categories.map((category) => (
              <div key={category.id} className="flex items-center gap-3 rounded-md border border-border px-3 py-3">
                <Tags className="h-4 w-4 text-primary" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{category.name}</span>
                <span className="text-xs text-muted-foreground">{category.templateCount} 个模板</span>
                <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={isSaving || category.templateCount > 0} title={category.templateCount > 0 ? '该分类下仍有模板，无法删除' : '删除分类'} onClick={() => onDelete(category)}><Trash2 className="h-4 w-4" />删除</Button>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeleteTemplateDialog({
  template,
  isDeleting,
  onClose,
  onConfirm,
}: {
  template: AgentTemplate | null;
  isDeleting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={template != null} onOpenChange={(open) => { if (!open && !isDeleting) onClose(); }}>
      <DialogContent className="max-w-md p-5">
        <DialogTitle>删除 Agent 模板</DialogTitle>
        <h3 className="font-semibold text-foreground">确认删除模板？</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">将从管理端永久删除“{template?.name}”。已有项目中保存的 CLAUDE.md、Skills、MCP 和引导语快照不会受到影响。此操作不可恢复。</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" disabled={isDeleting} onClick={onClose}>取消</Button>
          <Button variant="destructive" disabled={isDeleting} onClick={onConfirm}>{isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}确认删除</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ToastNotice({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  if (!toast) return null;
  return (
    <div className={cn('fixed right-6 top-6 z-[70] flex max-w-sm items-center gap-2 rounded-lg px-4 py-3 text-sm text-white shadow-lg', toast.type === 'success' ? 'bg-emerald-600' : 'bg-destructive')} role="status">
      {toast.type === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <X className="h-4 w-4" />}
      <span className="flex-1">{toast.message}</span>
      <button type="button" onClick={onClose} className="rounded p-0.5 hover:bg-white/10" aria-label="关闭提示"><X className="h-4 w-4" /></button>
    </div>
  );
}

function PresetList({
  title,
  itemLabel,
  emptyText,
  presets,
  refs,
  loadingKeys = new Set(),
  onToggle,
  onConfigure,
}: {
  title: string;
  itemLabel: string;
  emptyText: string;
  presets: (Preset | SkillCandidate)[];
  refs: PresetRef[];
  loadingKeys?: Set<string>;
  onToggle: (preset: Preset | SkillCandidate) => void;
  onConfigure?: (preset: Preset) => void;
}) {
  const [searchText, setSearchText] = useState('');
  const [viewMode, setViewMode] = useState<'all' | 'selected'>('all');
  const items = useMemo(() => presets.map((preset) => {
    const presetId = 'presetId' in preset ? preset.presetId : preset.id;
    const skillKey = 'sourceRef' in preset ? `${preset.tenantId}:${preset.sourceRef}` : '';
    const ref = presetId ? refs.find((candidate) => (
      candidate.tenantId === preset.tenantId && candidate.presetId === presetId
    )) : undefined;
    return {
      preset,
      presetId,
      skillKey,
      loading: loadingKeys.has(skillKey),
      selected: Boolean(ref),
      configured: Boolean(ref?.toolSettings),
    };
  }), [loadingKeys, presets, refs]);
  const selectedCount = items.filter((item) => item.selected).length;
  const normalizedSearch = searchText.trim().toLocaleLowerCase();
  const visibleItems = items.filter(({ preset, selected }) => {
    if (viewMode === 'selected' && !selected) return false;
    if (!normalizedSearch) return true;
    return [preset.displayName, preset.name, preset.description]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedSearch);
  });
  const noResultsText = viewMode === 'selected'
    ? `当前租户暂无已选 ${itemLabel}`
    : normalizedSearch
      ? `没有匹配的 ${itemLabel}`
      : emptyText;

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-foreground">{title}</h4>
        <span className="text-xs text-muted-foreground">已选 {selectedCount} / {items.length}</span>
      </div>
      <div className="grid grid-cols-2 rounded-md bg-muted p-1">
        <button type="button" onClick={() => setViewMode('all')} className={cn('rounded px-3 py-1.5 text-xs font-medium transition-colors', viewMode === 'all' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>全部 ({items.length})</button>
        <button type="button" onClick={() => setViewMode('selected')} className={cn('rounded px-3 py-1.5 text-xs font-medium transition-colors', viewMode === 'selected' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>已选 ({selectedCount})</button>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder={`搜索${itemLabel}名称或描述`} className="pl-9" aria-label={`搜索${itemLabel}`} />
        {searchText ? <button type="button" onClick={() => setSearchText('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`清空${itemLabel}搜索`}><X className="h-3.5 w-3.5" /></button> : null}
      </div>
      <div className="max-h-[32rem] space-y-2 overflow-y-auto pr-1">
        {visibleItems.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-5 text-center text-sm text-muted-foreground">{noResultsText}</div>
        ) : visibleItems.map(({ preset, presetId, skillKey, loading, selected, configured }) => (
          <div key={presetId || skillKey} className={cn('flex items-center rounded-md border', selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50')}>
            <button type="button" disabled={loading} onClick={() => onToggle(preset)} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left disabled:cursor-wait disabled:opacity-70">
              <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded border', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input')}>{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : selected ? <Check className="h-3.5 w-3.5" /> : null}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-foreground">{preset.displayName || preset.name}</span>{preset.description ? <span className="mt-0.5 block text-xs text-muted-foreground">{preset.description}</span> : null}{configured ? <span className="mt-1 block text-xs font-medium text-primary">已设置 Tool 权限与参数</span> : null}</span>
            </button>
            {onConfigure && selected ? <button type="button" onClick={() => onConfigure(preset as Preset)} className="mr-2 inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground hover:bg-muted"><SlidersHorizontal className="h-3.5 w-3.5" />设置</button> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
