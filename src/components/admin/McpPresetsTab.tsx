import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, FlaskConical, Loader2, RefreshCw, Server, ShieldCheck, Upload } from 'lucide-react';

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
  status: 'draft',
};

function headersToText(headers?: Record<string, string>) {
  if (!headers || Object.keys(headers).length === 0) return '';
  return JSON.stringify(headers, null, 2);
}

export default function McpPresetsTab({ tenants, currentTenantId }: McpPresetsTabProps) {
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
  const displayedValidationStatus = selectedTestResult?.status || selectedPreset?.lastTestStatus || 'Not tested';
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
          <h3 className="text-sm font-semibold text-foreground">MCP Server Presets</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Admin-managed internal MCP servers. Workspace users install these presets with one click and never enter URL, token, or header values.
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
          <Button variant="outline" onClick={startNew}>New preset</Button>
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
            Presets
          </div>
          <div className="max-h-[620px] overflow-auto">
            {presets.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                <Server className="h-4 w-4" />
                No MCP presets
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
                    <span className="rounded border border-border px-2 py-0.5">HTTP</span>
                    <span className="rounded border border-border px-2 py-0.5">{preset.toolCount} tools</span>
                    {preset.dockerCompatible ? <span className="rounded border border-emerald-200 px-2 py-0.5 text-emerald-700">Docker</span> : null}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="rounded-md border border-border bg-background p-4">
          <div className="flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Published presets become available on the workspace MCP Tools page. Install remains one-click and requires no user-side configuration.</span>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Display name</span>
              <Input value={values.displayName} onChange={(event) => handleDisplayNameChange(event.target.value)} placeholder="Knowledge Retrieval MCP" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Preset name</span>
              <Input value={values.name} onChange={(event) => updateValue('name', normalizeMcpPresetName(event.target.value))} placeholder="knowledge_retrieval" />
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="text-xs text-muted-foreground">Description</span>
              <Input value={values.description} onChange={(event) => updateValue('description', event.target.value)} placeholder="Search internal knowledge bases and project docs." />
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="text-xs text-muted-foreground">HTTP URL</span>
              <Input value={values.url} onChange={(event) => updateValue('url', event.target.value)} placeholder="https://mcp.internal/knowledge" />
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="text-xs text-muted-foreground">Static headers JSON or key/value lines</span>
              <textarea
                value={values.headersText}
                onChange={(event) => updateValue('headersText', event.target.value)}
                placeholder={'{"Authorization":"Bearer internal-secret"}'}
                className="min-h-[110px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="text-xs text-muted-foreground">Headers helper command</span>
              <Input
                value={values.headersHelper}
                onChange={(event) => updateValue('headersHelper', event.target.value)}
                placeholder={'python3 auth.py'}
                className="font-mono"
              />
              <span className="block text-xs text-muted-foreground">
                Optional Claude Code headersHelper. Use an uploaded private script by filename, for example python3 auth.py.
              </span>
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="text-xs text-muted-foreground">Headers helper environment</span>
              <textarea
                value={values.helperEnvText}
                onChange={(event) => updateValue('helperEnvText', event.target.value)}
                placeholder={'ROOT_SECRET=internal-root-key'}
                className="min-h-[88px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <span className="block text-xs text-muted-foreground">
                Private variables injected only when headersHelper runs. They are not written to workspace files.
              </span>
            </label>
            <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3 sm:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-medium text-foreground">Private helper script</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Stored outside the workspace. Workspace users cannot browse this file from Files.
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
                    Upload script
                  </span>
                </label>
              </div>
              <div className="text-xs text-muted-foreground">
                {selectedPreset?.helperScript ? (
                  <span>
                    Current script: <span className="font-mono text-foreground">{selectedPreset.helperScript.fileName}</span>
                    {' '}({Math.max(1, Math.ceil(selectedPreset.helperScript.sizeBytes / 1024))} KB)
                  </span>
                ) : selectedPreset ? (
                  <span>No helper script uploaded.</span>
                ) : (
                  <span>Save the preset before uploading a helper script.</span>
                )}
              </div>
            </div>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Status</span>
              <select
                value={values.status}
                onChange={(event) => updateValue('status', event.target.value as AdminMcpPresetStatus)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm"
              >
                <option value="draft">Draft</option>
                <option value="disabled">Disabled</option>
              </select>
              <span className="block text-xs text-muted-foreground">
                Publishing is controlled by the Publish button after a successful saved test.
              </span>
            </label>
            <div className="flex items-end gap-2">
              <Button onClick={handleSave} disabled={isSaving || isTestingSelectedPreset || !tenantId}>
                Save draft
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
                  {isTestingSelectedPreset ? 'Testing' : 'Test'}
                </Button>
              ) : null}
            </div>
          </div>

          {selectedPreset ? (
            <div className="mt-5 rounded-md border border-border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm">
                  <div className="font-medium text-foreground">Latest validation</div>
                  <div className="mt-1 text-muted-foreground">
                    {isTestingSelectedPreset
                      ? 'Testing connection and loading tools...'
                      : `${displayedValidationStatus} · ${displayedValidationToolCount} tools`}
                  </div>
                  {!isTestingSelectedPreset && displayedValidationTime ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      Last tested {formatValidationTime(displayedValidationTime)}
                      {selectedTestResult?.transient ? ' from current form values' : null}
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
                    Publish
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void disablePreset(selectedPreset.id)}
                    disabled={isSaving || isTestingSelectedPreset}
                  >
                    Disable
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
  if (isTesting) {
    return (
      <div
        className="mt-3 flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary"
        role="status"
      >
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
        <div>
          <div className="font-medium">Testing MCP server connection</div>
          <div className="mt-0.5 text-primary/80">Checking initialize and tools/list from the configured endpoint.</div>
        </div>
      </div>
    );
  }

  const status = latestResult?.status || preset.lastTestStatus;
  if (!status) {
    return (
      <div className="mt-3 rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
        Run Test to verify the endpoint and discover its tools.
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
        <div className="font-medium">{isHealthy ? 'Connection test passed' : 'Connection test failed'}</div>
        <div className="mt-0.5">
          {isHealthy
            ? `${toolCount} tools discovered${timeText ? ` · ${timeText}` : ''}`
            : error || 'The MCP server did not respond successfully.'}
        </div>
      </div>
    </div>
  );
}

function PresetStatus({ status }: { status: AdminMcpPresetStatus }) {
  const className = status === 'published'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : status === 'disabled'
      ? 'border-border bg-muted text-muted-foreground'
      : 'border-amber-200 bg-amber-50 text-amber-700';
  return <span className={`shrink-0 rounded-md border px-2 py-0.5 text-xs font-semibold ${className}`}>{status}</span>;
}
