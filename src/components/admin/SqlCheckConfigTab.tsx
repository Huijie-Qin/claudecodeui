import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../shared/view/ui';
import { api } from '../../utils/api';
import { normalizeSqlCheckRules, type SqlCheckRule } from '../sql-check/sqlCheckRules';

type AdminTenant = {
  id: number;
  code: string;
  name: string;
  status: string;
};

type SqlCheckConfigPayload = {
  tenantId?: number;
  ruleIds?: string[];
  error?: string;
};

type SqlCheckConfigTabProps = {
  tenants: AdminTenant[];
  currentTenantId?: number;
};

function getPayloadError(payload: unknown, fallback: string) {
  if (typeof payload !== 'object' || payload === null || !('error' in payload)) return fallback;
  const error = (payload as { error?: unknown }).error;
  return typeof error === 'string' && error ? error : fallback;
}

function toggleRuleId(ruleIds: string[], ruleId: string, checked: boolean) {
  if (checked) {
    return ruleIds.includes(ruleId) ? ruleIds : [...ruleIds, ruleId];
  }
  return ruleIds.filter((item) => item !== ruleId);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

export default function SqlCheckConfigTab({ tenants, currentTenantId }: SqlCheckConfigTabProps) {
  const { t } = useTranslation('admin');
  const tRef = useRef(t);
  const defaultTenantId = currentTenantId || tenants[0]?.id || 0;
  const [tenantId, setTenantId] = useState(defaultTenantId);
  const [rules, setRules] = useState<SqlCheckRule[]>([]);
  const [selectedRuleIds, setSelectedRuleIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isLoadingRules, setIsLoadingRules] = useState(false);
  const [isLoadingConfig, setIsLoadingConfig] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const translate = useCallback((key: string) => tRef.current(key), []);

  useEffect(() => {
    if (!tenantId && defaultTenantId) {
      setTenantId(defaultTenantId);
    }
  }, [defaultTenantId, tenantId]);

  const loadRules = useCallback(async ({ signal }: { signal?: AbortSignal } = {}) => {
    setIsLoadingRules(true);
    setError(null);
    try {
      const response = await api.sqlCheck.rules(signal ? { signal } : undefined);
      const payload = await response.json().catch(() => ({} as unknown));
      if (signal?.aborted) return;
      if (!response.ok) {
        setError(getPayloadError(payload, translate('sqlCheck.errors.loadRules')));
        return;
      }
      setRules(normalizeSqlCheckRules(payload));
    } catch (caughtError) {
      if (signal?.aborted || isAbortError(caughtError)) return;
      console.error('[SqlCheckConfigTab] Failed to load rules:', caughtError);
      setError(translate('sqlCheck.errors.loadRules'));
    } finally {
      if (!signal?.aborted) {
        setIsLoadingRules(false);
      }
    }
  }, [translate]);

  const loadTenantConfig = useCallback(async ({ signal }: { signal?: AbortSignal } = {}) => {
    if (!tenantId) {
      setIsLoadingConfig(false);
      return;
    }
    setIsLoadingConfig(true);
    setError(null);
    try {
      const response = await api.admin.sqlCheckTenantConfig(tenantId, signal ? { signal } : undefined);
      const payload = await response.json().catch(() => ({} as SqlCheckConfigPayload)) as SqlCheckConfigPayload;
      if (signal?.aborted) return;
      if (!response.ok) {
        setError(getPayloadError(payload, translate('sqlCheck.errors.loadConfig')));
        return;
      }
      setSelectedRuleIds(payload.ruleIds || []);
    } catch (caughtError) {
      if (signal?.aborted || isAbortError(caughtError)) return;
      console.error('[SqlCheckConfigTab] Failed to load config:', caughtError);
      setError(translate('sqlCheck.errors.loadConfig'));
    } finally {
      if (!signal?.aborted) {
        setIsLoadingConfig(false);
      }
    }
  }, [tenantId, translate]);

  useEffect(() => {
    const controller = new AbortController();
    void loadRules({ signal: controller.signal });
    return () => controller.abort();
  }, [loadRules]);

  useEffect(() => {
    const controller = new AbortController();
    void loadTenantConfig({ signal: controller.signal });
    return () => controller.abort();
  }, [loadTenantConfig]);

  const filteredRules = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return rules;
    return rules.filter((rule) => rule.name.toLowerCase().includes(normalizedQuery));
  }, [query, rules]);

  const selectedRules = useMemo(() => {
    const byId = new Map(rules.map((rule) => [rule.rule_id, rule]));
    return selectedRuleIds.map((ruleId) => byId.get(ruleId) || {
      rule_id: ruleId,
      name: ruleId,
      desc: '',
    });
  }, [rules, selectedRuleIds]);

  const handleTenantChange = (nextTenantId: number) => {
    setTenantId(nextTenantId);
    setSelectedRuleIds([]);
    setSuccess(null);
    setQuery('');
  };

  const handleSave = async () => {
    if (!tenantId) return;
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await api.admin.updateSqlCheckTenantConfig(tenantId, selectedRuleIds);
      const payload = await response.json().catch(() => ({} as SqlCheckConfigPayload)) as SqlCheckConfigPayload;
      if (!response.ok) {
        setError(getPayloadError(payload, t('sqlCheck.errors.saveConfig')));
        return;
      }
      setSelectedRuleIds(payload.ruleIds || selectedRuleIds);
      setSuccess(t('sqlCheck.saved'));
    } catch (caughtError) {
      console.error('[SqlCheckConfigTab] Failed to save config:', caughtError);
      setError(t('sqlCheck.errors.saveConfig'));
    } finally {
      setIsSaving(false);
    }
  };

  const isLoading = isLoadingRules || isLoadingConfig;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('sqlCheck.title')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('sqlCheck.description')}</p>
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
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              void loadRules();
              void loadTenantConfig();
            }}
            disabled={isLoading}
          >
            <RefreshCw className={isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </Button>
          <Button onClick={handleSave} disabled={!tenantId || isSaving || isLoading}>
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {t('sqlCheck.save')}
          </Button>
        </div>
      </div>

      {success ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
          <CheckCircle2 className="h-4 w-4" />
          {success}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid min-h-[520px] gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border">
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-3">
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
            <div className="text-sm text-muted-foreground">
              {t('sqlCheck.selectedCount', { count: selectedRuleIds.length })}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-3">
            {isLoading ? (
              <div className="flex min-h-[260px] items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('sqlCheck.loading')}
              </div>
            ) : filteredRules.length === 0 ? (
              <div className="flex min-h-[260px] items-center justify-center text-sm text-muted-foreground">
                {rules.length === 0 ? t('sqlCheck.empty') : t('sqlCheck.noMatches')}
              </div>
            ) : (
              <div className="grid gap-2">
                {filteredRules.map((rule) => (
                  <label
                    key={rule.rule_id}
                    className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-background p-3 transition hover:bg-accent/40"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-input accent-primary"
                      checked={selectedRuleIds.includes(rule.rule_id)}
                      onChange={(event) => setSelectedRuleIds((current) => (
                        toggleRuleId(current, rule.rule_id, event.target.checked)
                      ))}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">{rule.name}</span>
                      <span className="mt-1 block text-sm leading-6 text-muted-foreground">{rule.desc}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </section>

        <aside className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-muted/20">
          <div className="border-b border-border px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <ShieldCheck className="h-4 w-4 text-primary" />
              {t('sqlCheck.configuredRules')}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {selectedRules.length === 0 ? (
              <div className="text-sm text-muted-foreground">{t('sqlCheck.noneSelected')}</div>
            ) : (
              <div className="grid gap-2">
                {selectedRules.map((rule) => (
                  <div key={rule.rule_id} className="rounded-md border border-border bg-background px-3 py-2">
                    <div className="text-sm font-medium text-foreground">{rule.name}</div>
                    <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{rule.rule_id}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
