import { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  PackagePlus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../shared/view/ui';

import {
  useAdminSkillPresets,
  type AdminSkillPreset,
  type MarketSkillSummary,
  type SkillPresetFormValues,
} from './hooks/useAdminSkillPresets';

type AdminTenant = {
  id: number;
  code: string;
  name: string;
  status: string;
};

type SkillPresetsTabProps = {
  tenants: AdminTenant[];
  currentTenantId?: number;
};

const EMPTY_VALUES: SkillPresetFormValues = {
  tenantId: 0,
  sourceRef: '',
  selectedSkill: null,
  selectedSkills: [],
  preinstall: true,
  status: 'draft',
};

const MARKET_PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

function getSkillDisplayName(skill: MarketSkillSummary) {
  return skill.displayName || skill.name || skill.skillId || skill.id || '';
}

function getSkillRef(skill: MarketSkillSummary) {
  return skill.id || skill.skillId || skill.name;
}

function getPresetRefs(preset: AdminSkillPreset) {
  return [preset.remoteId, preset.skillId, preset.name].filter(Boolean);
}

function findPresetForSkill(skill: MarketSkillSummary, presetBySkillRef: Map<string, AdminSkillPreset>) {
  return presetBySkillRef.get(getSkillRef(skill))
    || presetBySkillRef.get(skill.skillId || '')
    || presetBySkillRef.get(skill.name);
}

export default function SkillPresetsTab({ tenants, currentTenantId }: SkillPresetsTabProps) {
  const { t } = useTranslation('admin');
  const defaultTenantId = currentTenantId || tenants[0]?.id || 0;
  const [tenantId, setTenantId] = useState(defaultTenantId);
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [values, setValues] = useState<SkillPresetFormValues>({ ...EMPTY_VALUES, tenantId: defaultTenantId });
  const [saveResult, setSaveResult] = useState<{ created: number } | null>(null);
  const {
    presets,
    marketSkills,
    marketPageInfo,
    error,
    isLoading,
    isSearching,
    isSaving,
    reload,
    searchMarket,
    savePresets,
    deletePreset,
  } = useAdminSkillPresets(tenantId || undefined);

  useEffect(() => {
    if (!tenantId && defaultTenantId) {
      setTenantId(defaultTenantId);
      setValues((current) => ({ ...current, tenantId: defaultTenantId }));
    }
  }, [defaultTenantId, tenantId]);

  const selectedTenant = useMemo(
    () => tenants.find((tenant) => tenant.id === tenantId) || null,
    [tenantId, tenants],
  );
  const presetBySkillRef = useMemo(() => {
    const refs = new Map<string, AdminSkillPreset>();
    for (const preset of presets) {
      for (const ref of getPresetRefs(preset)) {
        if (!refs.has(ref)) {
          refs.set(ref, preset);
        }
      }
    }
    return refs;
  }, [presets]);
  const selectedMarketRefs = useMemo(() => new Set(values.selectedSkills.map(getSkillRef).filter(Boolean)), [values.selectedSkills]);
  const selectedSkillCount = values.selectedSkills.length;
  const selectableMarketCount = useMemo(
    () => marketSkills.filter((skill) => !findPresetForSkill(skill, presetBySkillRef)).length,
    [marketSkills, presetBySkillRef],
  );

  const handleTenantChange = (nextTenantId: number) => {
    setTenantId(nextTenantId);
    setQuery('');
    setActiveQuery('');
    setSaveResult(null);
    setValues({ ...EMPTY_VALUES, tenantId: nextTenantId });
  };

  const clearSelectedMarketSkills = () => {
    setValues((current) => ({
      ...current,
      sourceRef: '',
      selectedSkill: null,
      selectedSkills: [],
    }));
    setSaveResult(null);
  };

  const toggleMarketSkill = (skill: MarketSkillSummary) => {
    if (findPresetForSkill(skill, presetBySkillRef)) return;
    const skillRef = getSkillRef(skill);
    setValues((current) => {
      const selectedSkills = current.selectedSkills.some((selectedSkill) => getSkillRef(selectedSkill) === skillRef)
        ? current.selectedSkills.filter((selectedSkill) => getSkillRef(selectedSkill) !== skillRef)
        : [...current.selectedSkills, skill];
      return {
        ...current,
        selectedSkill: selectedSkills[0] || null,
        selectedSkills,
        sourceRef: selectedSkills[0] ? getSkillRef(selectedSkills[0]) : '',
      };
    });
    setSaveResult(null);
  };

  const selectVisibleMarketSkills = () => {
    const selectableSkills = marketSkills.filter((skill) => !findPresetForSkill(skill, presetBySkillRef));
    setValues((current) => {
      const selectedByRef = new Map(current.selectedSkills.map((skill) => [getSkillRef(skill), skill]));
      for (const skill of selectableSkills) {
        selectedByRef.set(getSkillRef(skill), skill);
      }
      const selectedSkills = Array.from(selectedByRef.values());
      return {
        ...current,
        selectedSkill: selectedSkills[0] || null,
        selectedSkills,
        sourceRef: selectedSkills[0] ? getSkillRef(selectedSkills[0]) : '',
      };
    });
    setSaveResult(null);
  };

  const removePresetFromSelection = (preset: AdminSkillPreset) => {
    const presetRefs = new Set(getPresetRefs(preset));
    setValues((current) => {
      const selectedSkills = current.selectedSkills.filter((skill) => {
        const skillRefs = [getSkillRef(skill), skill.skillId || '', skill.name].filter(Boolean);
        return !skillRefs.some((ref) => presetRefs.has(ref));
      });
      return {
        ...current,
        selectedSkill: selectedSkills[0] || null,
        selectedSkills,
        sourceRef: selectedSkills[0] ? getSkillRef(selectedSkills[0]) : '',
      };
    });
  };

  const handlePreset = async () => {
    const saved = await savePresets({ ...values, tenantId });
    if (saved.length > 0) {
      setSaveResult({ created: saved.length });
      setValues({ ...EMPTY_VALUES, tenantId });
    }
  };

  const handleDeletePreset = async (preset: AdminSkillPreset) => {
    const deleted = await deletePreset(preset.id);
    if (deleted) {
      removePresetFromSelection(preset);
      setSaveResult(null);
    }
  };

  const handleDeleteMarketPreset = async (skill: MarketSkillSummary) => {
    const preset = findPresetForSkill(skill, presetBySkillRef);
    if (!preset) return;
    await handleDeletePreset(preset);
  };

  const handleMarketSearch = () => {
    const nextQuery = query.trim();
    setActiveQuery(nextQuery);
    void searchMarket(nextQuery, { page: 1, pageSize: marketPageInfo.pageSize });
  };

  const handleMarketPageChange = (page: number) => {
    void searchMarket(activeQuery, { page, pageSize: marketPageInfo.pageSize });
  };

  const handleMarketPageSizeChange = (pageSize: number) => {
    void searchMarket(activeQuery, { page: 1, pageSize });
  };

  return (
    <div className="min-w-0 max-w-full space-y-4 overflow-x-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {t('skillPresets.title', { defaultValue: 'Skill Presets' })}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('skillPresets.description', {
              defaultValue: 'Select Skill Market skills and preset them for the tenant.',
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm"
            value={tenantId || ''}
            onChange={(event) => handleTenantChange(Number(event.target.value))}
          >
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </select>
          <Button variant="ghost" size="icon" onClick={() => void reload()} disabled={isLoading}>
            <RefreshCw className={isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid min-h-[520px] min-w-0 max-w-full gap-4 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
        <div className="min-w-0 overflow-hidden rounded-md border border-border">
          <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-semibold uppercase text-muted-foreground">
            {t('skillPresets.presets', { defaultValue: 'Presets' })}
          </div>
          <div className="max-h-[620px] overflow-auto">
            {presets.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                <PackagePlus className="h-4 w-4" />
                {t('skillPresets.noPresets', { defaultValue: 'No Skill presets' })}
              </div>
            ) : (
              presets.map((preset) => (
                <div
                  key={preset.id}
                  className="border-b border-border bg-background px-3 py-3 last:border-b-0"
                >
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{preset.displayName}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => void handleDeletePreset(preset)}
                      disabled={isSaving}
                      aria-label={t('skillPresets.buttons.delete', { defaultValue: 'Delete' })}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{preset.name}</div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span className="rounded border border-border px-2 py-0.5">Skill Market</span>
                    <span className="rounded border border-border px-2 py-0.5">v{preset.version}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="min-w-0 overflow-hidden rounded-md border border-border bg-background p-4">
          <div className="grid min-w-0 gap-3">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-medium text-foreground">
                    {t('skillPresets.marketSearch', { defaultValue: 'Tenant Skill Market' })}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {selectedTenant
                      ? t('skillPresets.marketTenantHint', {
                        defaultValue: 'Showing Skill Market skills for tenant #{{tenantId}}.',
                        tenantId: selectedTenant.id,
                      })
                      : t('skillPresets.marketTenantMissing', { defaultValue: 'Select a tenant to load Skill Market skills.' })}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setQuery('');
                    setActiveQuery('');
                    void searchMarket('', { page: 1, pageSize: marketPageInfo.pageSize });
                  }}
                  disabled={isSearching || !tenantId}
                >
                  <RefreshCw className={isSearching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                  {t('skillPresets.refreshMarket', { defaultValue: 'Refresh list' })}
                </Button>
              </div>

              <div className="flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        handleMarketSearch();
                      }
                    }}
                    placeholder={t('skillPresets.searchPlaceholder', { defaultValue: 'Filter tenant Skill Market skills' })}
                    className="pl-9"
                  />
                </div>
                <Button type="button" variant="outline" onClick={handleMarketSearch} disabled={isSearching || !tenantId}>
                  {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  {t('skillPresets.search', { defaultValue: 'Search' })}
                </Button>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {t('skillPresets.selectedCount', {
                    defaultValue: '{{count}} Skill selected',
                    count: selectedSkillCount,
                  })}
                </span>
                <span className="flex gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={selectVisibleMarketSkills} disabled={isSearching || selectableMarketCount === 0}>
                    {t('skillPresets.selectVisible', { defaultValue: 'Select visible' })}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={clearSelectedMarketSkills} disabled={selectedSkillCount === 0}>
                    {t('skillPresets.clearSelection', { defaultValue: 'Clear' })}
                  </Button>
                </span>
              </div>

              {marketSkills.length > 0 ? (
                <div className="max-h-[420px] min-w-0 max-w-full overflow-y-auto overflow-x-hidden rounded-md border border-border">
                  {marketSkills.map((skill) => {
                    const skillRef = getSkillRef(skill);
                    const selected = selectedMarketRefs.has(skillRef);
                    const preset = findPresetForSkill(skill, presetBySkillRef);
                    const alreadyPreset = Boolean(preset);
                    return (
                      <div
                        key={skillRef}
                        role={alreadyPreset ? undefined : 'button'}
                        tabIndex={alreadyPreset ? undefined : 0}
                        onClick={() => {
                          if (!alreadyPreset) toggleMarketSkill(skill);
                        }}
                        onKeyDown={(event) => {
                          if (!alreadyPreset && (event.key === 'Enter' || event.key === ' ')) {
                            event.preventDefault();
                            toggleMarketSkill(skill);
                          }
                        }}
                        className={`min-w-0 max-w-full overflow-hidden border-b border-border px-3 py-2 text-left text-sm last:border-b-0 ${
                          selected ? 'bg-primary/10' : alreadyPreset ? 'bg-muted/20' : 'hover:bg-muted/40'
                        }`}
                      >
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                            <input
                              type="checkbox"
                              checked={selected || alreadyPreset}
                              disabled={alreadyPreset}
                              readOnly
                              className="h-4 w-4 shrink-0 rounded border-input"
                            />
                            <span className="min-w-0 truncate font-medium text-foreground">{getSkillDisplayName(skill)}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {alreadyPreset ? (
                              <>
                                <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                                  {t('skillPresets.alreadyPreset', { defaultValue: 'Preset exists' })}
                                </span>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void handleDeleteMarketPreset(skill);
                                  }}
                                  disabled={isSaving}
                                  aria-label={t('skillPresets.buttons.delete', { defaultValue: 'Delete' })}
                                >
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground">v{skill.version ?? 0}</span>
                            )}
                          </span>
                        </div>
                        <div
                          className="mt-1 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground"
                          title={skill.description || skill.skillId || skill.id}
                        >
                          {skill.description || skill.skillId || skill.id}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                  {isSearching
                    ? t('skillPresets.loadingMarket', { defaultValue: 'Loading Skill Market skills...' })
                    : t('skillPresets.noMarketSkills', { defaultValue: 'No Skill Market skills found for this tenant.' })}
                </div>
              )}

              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="whitespace-nowrap">
                    {t('skillPresets.pagination.pageSizePrefix', { defaultValue: 'Show' })}
                  </span>
                  <select
                    value={marketPageInfo.pageSize}
                    onChange={(event) => handleMarketPageSizeChange(Number(event.target.value))}
                    disabled={isSearching || !tenantId}
                    className="h-8 min-w-[4.5rem] rounded-md border border-border bg-background px-2 pr-7 text-center text-xs tabular-nums text-foreground"
                    aria-label={t('skillPresets.pagination.pageSizeLabel', { defaultValue: 'Skills per page' })}
                  >
                    {MARKET_PAGE_SIZE_OPTIONS.map((pageSize) => (
                      <option key={pageSize} value={pageSize}>
                        {pageSize}
                      </option>
                    ))}
                  </select>
                  <span className="whitespace-nowrap">
                    {t('skillPresets.pagination.pageSizeSuffix', { defaultValue: 'per page' })}
                  </span>
                  {marketPageInfo.total !== undefined ? (
                    <span className="ml-1 whitespace-nowrap text-xs text-muted-foreground">
                      {t('skillPresets.pagination.total', {
                        defaultValue: '{{count}} total',
                        count: marketPageInfo.total,
                      })}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isSearching || marketPageInfo.page <= 1 || !tenantId}
                    onClick={() => handleMarketPageChange(Math.max(1, marketPageInfo.page - 1))}
                    aria-label={t('skillPresets.pagination.previous', { defaultValue: 'Previous page' })}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="min-w-16 text-center text-xs text-muted-foreground">
                    {marketPageInfo.totalPages
                      ? t('skillPresets.pagination.pageWithTotal', {
                        defaultValue: '{{page}} / {{totalPages}}',
                        page: marketPageInfo.page,
                        totalPages: marketPageInfo.totalPages,
                      })
                      : t('skillPresets.pagination.page', {
                        defaultValue: 'Page {{page}}',
                        page: marketPageInfo.page,
                      })}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isSearching || !marketPageInfo.hasNextPage || !tenantId}
                    onClick={() => handleMarketPageChange(marketPageInfo.page + 1)}
                    aria-label={t('skillPresets.pagination.next', { defaultValue: 'Next page' })}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">
                {t('skillPresets.fields.sourceRef', { defaultValue: 'Selected Skill Market skills' })}
              </span>
              <div className="min-h-10 min-w-0 max-w-full overflow-hidden rounded-md border border-input bg-muted/20 px-3 py-2 text-sm text-foreground">
                {values.selectedSkills.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {values.selectedSkills.map((skill) => (
                      <span
                        key={getSkillRef(skill)}
                        className="max-w-full truncate rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                        title={getSkillDisplayName(skill)}
                      >
                        {getSkillDisplayName(skill)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground">
                    {t('skillPresets.selectMarketSkillFirst', { defaultValue: 'Select one or more Skills from the tenant Skill Market list above.' })}
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button onClick={handlePreset} disabled={isSaving || !tenantId || selectedSkillCount === 0}>
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />}
                {t('skillPresets.buttons.preset', { defaultValue: 'Preset' })}
              </Button>
            </div>
          </div>

          {saveResult ? (
            <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
              {t('skillPresets.saveSummary', {
                defaultValue: 'Preset {{created}} Skill.',
                created: saveResult.created,
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
