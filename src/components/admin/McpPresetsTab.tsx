import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, FlaskConical, Loader2, RefreshCw, Server, ShieldCheck, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../shared/view/ui';

import {
  normalizeMcpPresetName,
  type AdminMcpPresetStatus,
  type McpPresetFormValues,
} from './adminMcpPresetUtils';
import {
  useAdminMcpPresets,
  type AdminMcpPreset,
  type AdminMcpPresetTestResult,
} from './hooks/useAdminMcpPresets';

type AdminTenant = {
  id: number;
  code: string;
  name: string;
  status: string;
};

type McpPresetsTabProps = {
  tenants: AdminTenant[];
  currentTenantId?: number;
};

const EMPTY_VALUES: McpPresetFormValues = {
  tenantId: 0,
  name: '',
  displayName: '',
  description: '',
  url: '',
  headersText: '',
  headersHelper: '',
  helperEnvText: '',
  preinstall: false,
  status: 'draft',
};

function headersToText(headers?: Record<string, string>) {
  if (!headers || Object.keys(headers).length === 0) return '';
  return JSON.stringify(headers, null, 2);
}

export default function McpPresetsTab({ tenants, currentTenantId }: McpPresetsTabProps) {
  const { t } = useTranslation('admin');
  const defaultTenantId = currentTenantId || tenants[0]?.id || 0;
  const [tenantId, setTenantId] = useState(defaultTenantId);
  const [selectedPresetId, setSelectedPresetId] = useState<number | null>(null);
  const [values, setValues] = useState<McpPresetFormValues>({ ...EMPTY_VALUES, tenantId: defaultTenantId });
  const {
    presets,
    error,
    isLoading,
    isSaving,
    testingPresetIds,
    latestTestResult,
    reload,
    savePreset,
    testPreset,
    publishPreset,
    disablePreset,
    uploadHelperScript,
  } = useAdminMcpPresets(tenantId || undefined);

  useEffect(() => {
    if (!tenantId && defaultTenantId) {
      setTenantId(defaultTenantId);
      setValues((current) => ({ ...current, tenantId: defaultTenantId }));
    }
  }, [defaultTenantId, tenantId]);

  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) || null,
    [presets, selectedPresetId],
  );
  const isTestingSelectedPreset = selectedPreset ? testingPresetIds.has(selectedPreset.id) : false;
  const selectedTestResult = selectedPreset && latestTestResult?.presetId === selectedPreset.id
    ? latestTestResult
    : null;
  const displayedValidationStatus = selectedTestResult?.status || selectedPreset?.lastTestStatus || 'notTested';
  const displayedValidationToolCount = selectedTestResult?.toolCount ?? selectedPreset?.toolCount ?? 0;
  const displayedValidationTime = selectedTestResult?.testedAt || selectedPreset?.lastTestedAt || null;

  const selectPreset = (preset: AdminMcpPreset) => {
    setSelectedPresetId(preset.id);
    setValues({
      tenantId,
      name: preset.name,
      displayName: preset.displayName,
      description: preset.description || '',
      url: preset.config?.url || '',
      headersText: headersToText(preset.config?.headers),
      headersHelper: preset.config?.headersHelper || '',
      helperEnvText: headersToText(preset.config?.helperEnv),
      preinstall: preset.preinstallScope === 'all_workspaces',
      status: preset.status === 'disabled' ? 'disabled' : 'draft',
    });
  };

  const startNew = () => {
    setSelectedPresetId(null);
    setValues({ ...EMPTY_VALUES, tenantId });
  };

  const updateValue = <K extends keyof McpPresetFormValues>(key: K, value: McpPresetFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const handleDisplayNameChange = (displayName: string) => {
    setValues((current) => ({
      ...current,
      displayName,
      name: selectedPresetId || current.name ? current.name : normalizeMcpPresetName(displayName),
    }));
  };

  const handleTenantChange = (nextTenantId: number) => {
    setTenantId(nextTenantId);
    setSelectedPresetId(null);
    setValues({ ...EMPTY_VALUES, tenantId: nextTenantId });
  };

  const handleSave = async () => {
    const saved = await savePreset({ ...values, tenantId }, selectedPresetId);
    if (saved) {
      selectPreset(saved);
    }
  };

  const handleHelperScriptUpload = async (file?: File | null) => {
    if (!file || !selectedPreset) return;
    const saved = await uploadHelperScript(selectedPreset.id, file);
    if (saved) {
      selectPreset(saved);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('mcp.title')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('mcp.description')}
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
          <Button variant="outline" onClick={startNew}>{t('mcp.newPreset')}</Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid min-h-[520px] gap-4 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
        <div className="overflow-hidden rounded-md border border-border">
          <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('mcp.presets')}
          </div>
          <div className="max-h-[620px] overflow-auto">
            {presets.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                <Server className="h-4 w-4" />
                {t('mcp.noPresets')}
              </div>
            ) : (
              presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => selectPreset(preset)}
                  className={`w-full border-b border-border px-3 py-3 text-left last:border-b-0 ${
                    selectedPresetId === preset.id ? 'bg-primary/10' : 'bg-background hover:bg-accent/40'
                  }`}
                >
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <span className="truncate text-sm font-medium text-foreground">{preset.displayName}</span>
                    <PresetStatus status={preset.status} />
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{preset.name}</div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span className="rounded border border-border px-2 py-0.5">{t('mcp.transportHttp')}</span>
                    <span className="rounded border border-border px-2 py-0.5">{t('mcp.toolsCount', { count: preset.toolCount })}</span>
                    {preset.preinstallScope === 'all_workspaces' ? (
                      <span className="rounded border border-sky-200 px-2 py-0.5 text-sky-700">
                        {t('mcp.preinstallBadge', { defaultValue: 'Preinstall' })}
                      </span>
                    ) : null}
                    {preset.dockerCompatible ? <span className="rounded border border-emerald-200 px-2 py-0.5 text-emerald-700">{t('mcp.docker')}</span> : null}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="rounded-md border border-border bg-background p-4">
          <div className="flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t('mcp.publishNotice')}</span>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">{t('mcp.fields.displayName')}</span>
              <Input value={values.displayName} onChange={(event) => handleDisplayNameChange(event.target.value)} placeholder={t('mcp.fields.displayNamePlaceholder')} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">{t('mcp.fields.presetName')}</span>
              <Input value={values.name} onChange={(event) => updateValue('name', normalizeMcpPresetName(event.target.value))} placeholder={t('mcp.fields.presetNamePlaceholder')} />
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="text-xs text-muted-foreground">{t('mcp.fields.description')}</span>
              <Input value={values.description} onChange={(event) => updateValue('description', event.target.value)} placeholder={t('mcp.fields.descriptionPlaceholder')} />
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="text-xs text-muted-foreground">{t('mcp.fields.httpUrl')}</span>
              <Input value={values.url} onChange={(event) => updateValue('url', event.target.value)} placeholder={t('mcp.fields.httpUrlPlaceholder')} />
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="text-xs text-muted-foreground">{t('mcp.fields.staticHeaders')}</span>
              <textarea
                value={values.headersText}
                onChange={(event) => updateValue('headersText', event.target.value)}
                placeholder={'{"Authorization":"Bearer internal-secret"}'}
                className="min-h-[110px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="text-xs text-muted-foreground">{t('mcp.fields.headersHelper')}</span>
              <Input
                value={values.headersHelper}
                onChange={(event) => updateValue('headersHelper', event.target.value)}
                placeholder={'python3 auth.py'}
                className="font-mono"
              />
              <span className="block text-xs text-muted-foreground">
                {t('mcp.fields.headersHelperHelp')}
              </span>
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="text-xs text-muted-foreground">{t('mcp.fields.headersHelperEnv')}</span>
              <textarea
                value={values.helperEnvText}
                onChange={(event) => updateValue('helperEnvText', event.target.value)}
                placeholder={'ROOT_SECRET=internal-root-key'}
                className="min-h-[88px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <span className="block text-xs text-muted-foreground">
                {t('mcp.fields.headersHelperEnvHelp')}
              </span>
            </label>
            <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3 sm:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-medium text-foreground">{t('mcp.helperScript.title')}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t('mcp.helperScript.description')}
                  </div>
                </div>
                <label>
                  <input
                    type="file"
                    accept=".py,.sh,.js,.mjs,.cjs,.txt"
                    className="sr-only"
                    disabled={!selectedPreset || isSaving || isTestingSelectedPreset}
                    onChange={(event) => {
                      const file = event.target.files?.[0] || null;
                      event.target.value = '';
                      void handleHelperScriptUpload(file);
                    }}
                  />
                  <span
                    className={`inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm ${
                      !selectedPreset || isSaving || isTestingSelectedPreset ? 'pointer-events-none opacity-50' : 'hover:bg-accent'
                    }`}
                  >
                    <Upload className="h-4 w-4" />
                    {t('mcp.helperScript.upload')}
                  </span>
                </label>
              </div>
              <div className="text-xs text-muted-foreground">
                {selectedPreset?.helperScript ? (
                  <span>{t('mcp.helperScript.current', {
                    fileName: selectedPreset.helperScript.fileName,
                    sizeKb: Math.max(1, Math.ceil(selectedPreset.helperScript.sizeBytes / 1024)),
                  })}</span>
                ) : selectedPreset ? (
                  <span>{t('mcp.helperScript.none')}</span>
                ) : (
                  <span>{t('mcp.helperScript.saveFirst')}</span>
                )}
              </div>
            </div>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">{t('mcp.fields.status')}</span>
              <select
                value={values.status}
                onChange={(event) => updateValue('status', event.target.value as AdminMcpPresetStatus)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm"
              >
                <option value="draft">{t('statuses.draft')}</option>
                <option value="disabled">{t('statuses.disabled')}</option>
              </select>
              <span className="block text-xs text-muted-foreground">
                {t('mcp.fields.statusHelp')}
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-md border border-border bg-muted/20 p-3 sm:col-span-2">
              <input
                type="checkbox"
                checked={values.preinstall}
                onChange={(event) => updateValue('preinstall', event.target.checked)}
                className="mt-1 h-4 w-4 rounded border-input"
              />
              <span>
                <span className="block text-sm font-medium text-foreground">
                  {t('mcp.fields.preinstall', { defaultValue: 'Preinstall to workspaces' })}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {t('mcp.fields.preinstallHelp', {
                    defaultValue: 'When published, this MCP preset is installed automatically into every newly created workspace.',
                  })}
                </span>
              </span>
            </label>
            <div className="flex items-end gap-2">
              <Button onClick={handleSave} disabled={isSaving || isTestingSelectedPreset || !tenantId}>
                {t('mcp.buttons.saveDraft')}
              </Button>
              {selectedPreset ? (
                <Button
                  variant="outline"
                  onClick={() => void testPreset(selectedPreset.id, { ...values, tenantId })}
                  disabled={isSaving || isTestingSelectedPreset}
                >
                  {isTestingSelectedPreset ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <FlaskConical className="h-4 w-4" />
                  )}
                  {isTestingSelectedPreset ? t('mcp.buttons.testing') : t('mcp.buttons.test')}
                </Button>
              ) : null}
            </div>
          </div>

          {selectedPreset ? (
            <div className="mt-5 rounded-md border border-border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm">
                  <div className="font-medium text-foreground">{t('mcp.validation.title')}</div>
                  <div className="mt-1 text-muted-foreground">
                    {isTestingSelectedPreset
                      ? t('mcp.validation.testing')
                      : t('mcp.validation.statusWithTools', {
                          status: t(`statuses.${displayedValidationStatus}`, { defaultValue: displayedValidationStatus }),
                          count: displayedValidationToolCount,
                        })}
                  </div>
                  {!isTestingSelectedPreset && displayedValidationTime ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {t('mcp.validation.lastTested', { time: formatValidationTime(displayedValidationTime) })}
                      {selectedTestResult?.transient ? ` ${t('mcp.validation.fromCurrentFormValues')}` : null}
                    </div>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void publishPreset(selectedPreset.id)}
                    disabled={isSaving || isTestingSelectedPreset || selectedPreset.lastTestStatus !== 'healthy' || selectedPreset.toolCount <= 0}
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    {t('mcp.buttons.publish')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void disablePreset(selectedPreset.id)}
                    disabled={isSaving || isTestingSelectedPreset}
                  >
                    {t('mcp.buttons.disable')}
                  </Button>
                </div>
              </div>
              <ValidationFeedback
                preset={selectedPreset}
                latestResult={selectedTestResult}
                isTesting={isTestingSelectedPreset}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function formatValidationTime(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function ValidationFeedback({
  preset,
  latestResult,
  isTesting,
}: {
  preset: AdminMcpPreset;
  latestResult: AdminMcpPresetTestResult | null;
  isTesting: boolean;
}) {
  const { t } = useTranslation('admin');

  if (isTesting) {
    return (
      <div
        className="mt-3 flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary"
        role="status"
      >
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
        <div>
          <div className="font-medium">{t('mcp.validation.testingTitle')}</div>
          <div className="mt-0.5 text-primary/80">{t('mcp.validation.testingDescription')}</div>
        </div>
      </div>
    );
  }

  const status = latestResult?.status || preset.lastTestStatus;
  if (!status) {
    return (
      <div className="mt-3 rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
        {t('mcp.validation.runTest')}
      </div>
    );
  }

  const isHealthy = status === 'healthy';
  const toolCount = latestResult?.toolCount ?? preset.toolCount;
  const error = latestResult?.error || preset.lastTestError;
  const testedAt = latestResult?.testedAt || preset.lastTestedAt;
  const timeText = formatValidationTime(testedAt);

  return (
    <div
      className={`mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
        isHealthy
          ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100'
          : 'border-destructive/40 bg-destructive/5 text-destructive'
      }`}
      role={isHealthy ? 'status' : 'alert'}
    >
      {isHealthy ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
      ) : (
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      )}
      <div>
        <div className="font-medium">{isHealthy ? t('mcp.validation.passed') : t('mcp.validation.failed')}</div>
        <div className="mt-0.5">
          {isHealthy
            ? t('mcp.validation.toolsDiscovered', {
                count: toolCount,
                timeSuffix: timeText ? ` · ${timeText}` : '',
              })
            : error || t('mcp.validation.serverFailed')}
        </div>
      </div>
    </div>
  );
}

function PresetStatus({ status }: { status: AdminMcpPresetStatus }) {
  const { t } = useTranslation('admin');
  const className = status === 'published'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : status === 'disabled'
      ? 'border-border bg-muted text-muted-foreground'
      : 'border-amber-200 bg-amber-50 text-amber-700';
  return (
    <span className={`shrink-0 rounded-md border px-2 py-0.5 text-xs font-semibold ${className}`}>
      {t(`statuses.${status}`, { defaultValue: status })}
    </span>
  );
}
