import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, Loader2, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../shared/view/ui';
import type { Project } from '../../types/app';
import { api } from '../../utils/api';

type SqlCheckRule = {
  rule_id: string;
  name: string;
  desc: string;
};

type SqlCheckRulesPayload = {
  response?: SqlCheckRule[];
  error?: string;
};

type WorkspaceSqlCheckConfig = {
  workspaceId?: number;
  accessRole?: string;
  tenantId?: number;
  userId?: number;
  tenantRuleIds?: string[];
  customEnabled?: boolean;
  userRuleIds?: string[];
  effectiveRuleIds?: string[];
  source?: 'tenant' | 'user';
  error?: string;
};

type SqlCheckPanelProps = {
  selectedProject: Project;
};

function normalizeRules(payload: SqlCheckRulesPayload): SqlCheckRule[] {
  return (payload.response || [])
    .map((rule) => ({
      rule_id: String(rule.rule_id || '').trim(),
      name: String(rule.name || rule.rule_id || '').trim(),
      desc: String(rule.desc || '').trim(),
    }))
    .filter((rule) => rule.rule_id && rule.name);
}

function payloadError(payload: { error?: string } | null, fallback: string) {
  return payload?.error || fallback;
}

function toggleRuleId(ruleIds: string[], ruleId: string, checked: boolean) {
  if (checked) {
    return ruleIds.includes(ruleId) ? ruleIds : [...ruleIds, ruleId];
  }
  return ruleIds.filter((item) => item !== ruleId);
}

function normalizeRuleIds(value?: string[]) {
  return Array.isArray(value) ? value.map(String) : [];
}

export default function SqlCheckPanel({ selectedProject }: SqlCheckPanelProps) {
  const { t } = useTranslation();
  const workspaceId = selectedProject.workspaceId;
  const [rules, setRules] = useState<SqlCheckRule[]>([]);
  const [config, setConfig] = useState<WorkspaceSqlCheckConfig | null>(null);
  const [draftCustomEnabled, setDraftCustomEnabled] = useState(false);
  const [draftRuleIds, setDraftRuleIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isLoadingRules, setIsLoadingRules] = useState(false);
  const [isLoadingConfig, setIsLoadingConfig] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const applyConfig = useCallback((payload: WorkspaceSqlCheckConfig) => {
    const nextConfig = {
      ...payload,
      tenantRuleIds: normalizeRuleIds(payload.tenantRuleIds),
      userRuleIds: normalizeRuleIds(payload.userRuleIds),
      effectiveRuleIds: normalizeRuleIds(payload.effectiveRuleIds),
    };
    setConfig(nextConfig);
    setDraftCustomEnabled(nextConfig.customEnabled === true);
    setDraftRuleIds(nextConfig.customEnabled ? nextConfig.userRuleIds : nextConfig.tenantRuleIds);
  }, []);

  const loadRules = useCallback(async () => {
    setIsLoadingRules(true);
    setError(null);
    try {
      const response = await api.sqlCheck.rules();
      const payload = await response.json().catch(() => ({} as SqlCheckRulesPayload)) as SqlCheckRulesPayload;
      if (!response.ok) {
        setError(payloadError(payload, t('sqlCheck.errors.loadRules')));
        return;
      }
      setRules(normalizeRules(payload));
    } catch (caughtError) {
      console.error('[SqlCheckPanel] Failed to load rules:', caughtError);
      setError(t('sqlCheck.errors.loadRules'));
    } finally {
      setIsLoadingRules(false);
    }
  }, [t]);

  const loadConfig = useCallback(async () => {
    if (!workspaceId) {
      setConfig(null);
      setDraftCustomEnabled(false);
      setDraftRuleIds([]);
      setError(t('sqlCheck.errors.workspaceUnavailable'));
      return;
    }

    setIsLoadingConfig(true);
    setError(null);
    try {
      const response = await api.sqlCheck.workspaceConfig(workspaceId);
      const payload = await response.json().catch(() => ({} as WorkspaceSqlCheckConfig)) as WorkspaceSqlCheckConfig;
      if (!response.ok) {
        setError(payloadError(payload, t('sqlCheck.errors.loadConfig')));
        return;
      }
      applyConfig(payload);
    } catch (caughtError) {
      console.error('[SqlCheckPanel] Failed to load config:', caughtError);
      setError(t('sqlCheck.errors.loadConfig'));
    } finally {
      setIsLoadingConfig(false);
    }
  }, [applyConfig, t, workspaceId]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const rulesById = useMemo(() => new Map(rules.map((rule) => [rule.rule_id, rule])), [rules]);
  const displayedRuleIds = draftCustomEnabled ? draftRuleIds : normalizeRuleIds(config?.tenantRuleIds);
  const filteredRules = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return rules;
    return rules.filter((rule) => rule.name.toLowerCase().includes(normalizedQuery));
  }, [query, rules]);
  const tenantRules = normalizeRuleIds(config?.tenantRuleIds);
  const effectiveRules = displayedRuleIds;
  const isLoading = isLoadingRules || isLoadingConfig;

  const getRuleLabel = (ruleId: string) => {
    const rule = rulesById.get(ruleId);
    return {
      name: rule?.name || ruleId,
      desc: rule?.desc || '',
    };
  };

  const handleCustomToggle = (checked: boolean) => {
    setDraftCustomEnabled(checked);
    setDraftRuleIds(checked
      ? (config?.customEnabled ? normalizeRuleIds(config.userRuleIds) : tenantRules)
      : tenantRules);
    setSuccess(null);
  };

  const handleSave = async () => {
    if (!workspaceId) return;
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await api.sqlCheck.updateWorkspaceConfig(workspaceId, {
        customEnabled: draftCustomEnabled,
        ruleIds: draftCustomEnabled ? draftRuleIds : [],
      });
      const payload = await response.json().catch(() => ({} as WorkspaceSqlCheckConfig)) as WorkspaceSqlCheckConfig;
      if (!response.ok) {
        setError(payloadError(payload, t('sqlCheck.errors.saveConfig')));
        return;
      }
      applyConfig(payload);
      setSuccess(t('sqlCheck.saved'));
    } catch (caughtError) {
      console.error('[SqlCheckPanel] Failed to save config:', caughtError);
      setError(t('sqlCheck.errors.saveConfig'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-foreground">{t('sqlCheck.title')}</h1>
            <p className="mt-1 truncate text-sm text-muted-foreground">{selectedProject.displayName}</p>
          </div>
          <Button
            variant="outline"
            onClick={() => {
              void loadRules();
              void loadConfig();
            }}
            disabled={isLoading}
          >
            <RefreshCw className={isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            {t('buttons.refresh')}
          </Button>
        </div>
        {success ? (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
            <CheckCircle2 className="h-4 w-4" />
            {success}
          </div>
        ) : null}
        {error ? (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-px border-b border-border bg-border">
        <SummaryTile label={t('sqlCheck.summary.tenant')} value={tenantRules.length} />
        <SummaryTile label={t('sqlCheck.summary.effective')} value={effectiveRules.length} />
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col border-r border-border">
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
            <label className="relative min-w-[240px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                className="pl-9"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('sqlCheck.searchPlaceholder')}
              />
            </label>
            <label className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground shadow-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input accent-primary"
                checked={draftCustomEnabled}
                onChange={(event) => handleCustomToggle(event.target.checked)}
                disabled={isLoading || isSaving}
              />
              {t('sqlCheck.custom')}
            </label>
            <Button onClick={handleSave} disabled={!workspaceId || isLoading || isSaving}>
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {t('buttons.save')}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {isLoading ? (
              <CenteredState text={t('sqlCheck.loading')} icon={<Loader2 className="h-5 w-5 animate-spin" />} />
            ) : filteredRules.length === 0 ? (
              <CenteredState text={rules.length === 0 ? t('sqlCheck.empty') : t('sqlCheck.noMatches')} icon={<ShieldCheck className="h-5 w-5" />} />
            ) : (
              <div className="grid gap-3">
                {filteredRules.map((rule) => (
                  <label
                    key={rule.rule_id}
                    className={`flex items-start gap-3 rounded-md border bg-background p-4 transition ${
                      draftCustomEnabled
                        ? 'cursor-pointer border-border hover:bg-accent/30'
                        : 'cursor-default border-border text-muted-foreground'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-input accent-primary"
                      checked={displayedRuleIds.includes(rule.rule_id)}
                      disabled={!draftCustomEnabled || isLoading || isSaving}
                      onChange={(event) => setDraftRuleIds((current) => (
                        toggleRuleId(current, rule.rule_id, event.target.checked)
                      ))}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-foreground">{rule.name}</span>
                      <span className="mt-1 block text-sm leading-6 text-muted-foreground">{rule.desc}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        <aside className="hidden w-[360px] min-w-[300px] flex-col bg-muted/30 lg:flex">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground">{t('sqlCheck.effectiveConfig')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {draftCustomEnabled ? t('sqlCheck.source.user') : t('sqlCheck.source.tenant')}
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {effectiveRules.length === 0 ? (
              <div className="rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
                {t('sqlCheck.noneSelected')}
              </div>
            ) : (
              <div className="grid gap-2">
                {effectiveRules.map((ruleId) => {
                  const rule = getRuleLabel(ruleId);
                  return (
                    <div key={ruleId} className="rounded-md border border-border bg-background px-3 py-2">
                      <div className="text-sm font-medium text-foreground">{rule.name}</div>
                      {rule.desc ? <div className="mt-1 text-sm leading-6 text-muted-foreground">{rule.desc}</div> : null}
                      <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{ruleId}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

function SummaryTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-background px-6 py-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-foreground">{value}</div>
    </div>
  );
}

function CenteredState({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex h-full min-h-[260px] items-center justify-center p-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {icon}
        {text}
      </div>
    </div>
  );
}
