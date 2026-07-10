import {
  CheckCircle2,
  Loader2,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Project } from '../../types/app';

import {
  useWorkspaceMcpTools,
  type WorkspaceMcpPreset,
} from './hooks/useWorkspaceMcpTools';
import {
  getPresetCardBadges,
  getPresetToolDetails,
} from './mcpToolsDisplay';
import McpToolSettingsDialog from './McpToolSettingsDialog';

type McpToolsPanelProps = {
  selectedProject: Project;
  isReadOnly: boolean;
};

type FilterKey = 'all' | 'available' | 'installed';

export default function McpToolsPanel({ selectedProject, isReadOnly }: McpToolsPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [selectedPresetId, setSelectedPresetId] = useState<number | null>(null);
  const [detailPresetId, setDetailPresetId] = useState<number | null>(null);
  const [settingsPresetId, setSettingsPresetId] = useState<number | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const {
    data,
    error,
    isLoading,
    installingPresetIds,
    removingPresetIds,
    reload,
    installPreset,
    removePreset,
  } = useWorkspaceMcpTools(selectedProject.workspaceId);
  const canManage = !isReadOnly && data?.canManage !== false;

  const presets = useMemo(
    () => data?.presets ?? [],
    [data?.presets],
  );
  const summary = useMemo(() => ({
    available: presets.filter((preset) => !preset.installed).length,
    installed: presets.filter((preset) => preset.installed).length,
  }), [presets]);
  const filteredPresets = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return presets.filter((preset) => {
      const matchesFilter = filter === 'all'
        || (filter === 'available' && !preset.installed)
        || (filter === 'installed' && preset.installed);
      const matchesQuery = !normalizedQuery
        || preset.displayName.toLowerCase().includes(normalizedQuery)
        || preset.name.toLowerCase().includes(normalizedQuery)
        || preset.description.toLowerCase().includes(normalizedQuery);
      return matchesFilter && matchesQuery;
    });
  }, [filter, presets, query]);

  const selectedPreset = useMemo(() => {
    if (selectedPresetId == null) return filteredPresets[0] ?? null;
    return presets.find((preset) => preset.id === selectedPresetId) ?? filteredPresets[0] ?? null;
  }, [filteredPresets, presets, selectedPresetId]);
  const detailPreset = useMemo(() => {
    if (detailPresetId == null) return null;
    return presets.find((preset) => preset.id === detailPresetId) ?? null;
  }, [detailPresetId, presets]);
  const settingsPreset = useMemo(() => {
    if (settingsPresetId == null) return null;
    return presets.find((preset) => preset.id === settingsPresetId) ?? null;
  }, [presets, settingsPresetId]);

  const handleInstall = async (preset: WorkspaceMcpPreset) => {
    if (!canManage || preset.installed) return;
    setSuccessMessage(null);
    await installPreset(preset.id);
    setSelectedPresetId(preset.id);
    setSuccessMessage(t('mcpTools.installSuccess', { name: preset.displayName }));
  };

  const handleRemove = async (preset: WorkspaceMcpPreset) => {
    if (!canManage || !preset.installed) return;
    setSuccessMessage(null);
    await removePreset(preset.id);
    setSuccessMessage(t('mcpTools.removeSuccess', { name: preset.displayName }));
  };

  const handleOpenDetail = (preset: WorkspaceMcpPreset) => {
    setSelectedPresetId(preset.id);
    setDetailPresetId(preset.id);
  };

  const handleOpenSettings = (preset: WorkspaceMcpPreset) => {
    if (!preset.installed) return;
    setSelectedPresetId(preset.id);
    setSettingsPresetId(preset.id);
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-foreground">{t('mcpTools.title')}</h1>
            <p className="mt-1 truncate text-sm text-muted-foreground">{selectedProject.displayName}</p>
          </div>
          <button
            type="button"
            onClick={reload}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground shadow-sm transition hover:bg-accent"
          >
            <RefreshCw className="h-4 w-4" />
            {t('buttons.refresh')}
          </button>
        </div>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          {t('mcpTools.description')}
        </p>
        {successMessage ? (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
            <CheckCircle2 className="h-4 w-4" />
            {successMessage}
          </div>
        ) : null}
        {error ? (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-px border-b border-border bg-border">
        <SummaryTile label={t('mcpTools.summary.available')} value={summary.available} />
        <SummaryTile label={t('mcpTools.summary.installed')} value={summary.installed} />
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col border-r border-border">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <label className="relative min-w-[240px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                placeholder={t('mcpTools.searchPlaceholder')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
              />
            </label>
            {(['all', 'available', 'installed'] as FilterKey[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setFilter(item)}
                className={`h-9 rounded-md border px-3 text-sm font-medium transition ${
                  filter === item
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background text-muted-foreground hover:bg-accent'
                }`}
              >
                {t(`mcpTools.filters.${item}`)}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {isLoading ? (
              <CenteredState icon={<Loader2 className="h-5 w-5 animate-spin" />} text={t('mcpTools.loading')} />
            ) : filteredPresets.length === 0 ? (
              <CenteredState icon={<Server className="h-5 w-5" />} text={t('mcpTools.empty')} />
            ) : (
              <div className="grid gap-3">
                {filteredPresets.map((preset) => (
                  <PresetCard
                    key={preset.id}
                    canManage={canManage}
                    isInstalling={installingPresetIds.has(preset.id)}
                    isRemoving={removingPresetIds.has(preset.id)}
                    isSelected={selectedPreset?.id === preset.id}
                    onInstall={handleInstall}
                    onOpenDetail={handleOpenDetail}
                    onOpenSettings={handleOpenSettings}
                    onRemove={handleRemove}
                    onSelect={setSelectedPresetId}
                    preset={preset}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <aside className="hidden w-[380px] min-w-[320px] flex-col bg-muted/30 lg:flex">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground">{t('mcpTools.detailTitle')}</h2>
          </div>
          <PresetDetail canManage={canManage} preset={selectedPreset} />
        </aside>
      </div>
      {detailPreset ? (
        <PresetDetailDialog
          canManage={canManage}
          onClose={() => setDetailPresetId(null)}
          preset={detailPreset}
        />
      ) : null}
      {settingsPreset ? (
        <McpToolSettingsDialog
          canManage={canManage}
          onClose={() => setSettingsPresetId(null)}
          preset={settingsPreset}
          selectedProject={selectedProject}
        />
      ) : null}
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

function PresetCard({
  canManage,
  isInstalling,
  isRemoving,
  isSelected,
  onInstall,
  onOpenDetail,
  onOpenSettings,
  onRemove,
  onSelect,
  preset,
}: {
  canManage: boolean;
  isInstalling: boolean;
  isRemoving: boolean;
  isSelected: boolean;
  onInstall: (preset: WorkspaceMcpPreset) => void;
  onOpenDetail: (preset: WorkspaceMcpPreset) => void;
  onOpenSettings: (preset: WorkspaceMcpPreset) => void;
  onRemove: (preset: WorkspaceMcpPreset) => void;
  onSelect: (presetId: number) => void;
  preset: WorkspaceMcpPreset;
}) {
  const { t } = useTranslation();
  const badges = getPresetCardBadges(preset, (count) => t('mcpTools.toolCount', { count }));

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t('mcpTools.cardAriaLabel', { name: preset.displayName })}
      onClick={() => onSelect(preset.id)}
      onDoubleClick={() => onOpenDetail(preset)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(preset.id);
        }
      }}
      className={`rounded-md border bg-background p-4 text-left transition ${
        isSelected ? 'border-primary shadow-sm ring-1 ring-primary/20' : 'border-border hover:border-primary/40 hover:bg-accent/30'
      }`}
    >
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">{preset.displayName}</div>
          <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">{preset.description}</p>
        </div>
        <StatusBadge preset={preset} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {badges.map((badge) => (
          <Badge key={badge.key}>{badge.label}</Badge>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{t('mcpTools.appliesOnNextTurn')}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!canManage || !preset.installed}
            onClick={(event) => {
              event.stopPropagation();
              onOpenSettings(preset);
            }}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground shadow-sm transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Settings className="h-4 w-4" />
            设置
          </button>
          {preset.installed ? (
            <button
              type="button"
              disabled={!canManage || isRemoving}
              onClick={(event) => {
                event.stopPropagation();
                onRemove(preset);
              }}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground shadow-sm transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRemoving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t('buttons.delete')}
            </button>
          ) : (
            <button
              type="button"
              disabled={!canManage || isInstalling}
              onClick={(event) => {
                event.stopPropagation();
                onInstall(preset);
              }}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isInstalling ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {isInstalling ? t('mcpTools.installing') : canManage ? t('mcpTools.install') : t('mcpTools.requiresEditAccess')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PresetDetail({ canManage, preset }: { canManage: boolean; preset: WorkspaceMcpPreset | null }) {
  const { t } = useTranslation();
  if (!preset) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {t('mcpTools.noSelection')}
      </div>
    );
  }

  const rows = [
    [t('mcpTools.detail.serverName'), preset.name],
    [t('mcpTools.detail.source'), t('mcpTools.detail.adminPublished')],
    ...(preset.installed ? [
      [t('mcpTools.detail.connection'), t(`mcpTools.connection.${preset.connectionStatus}`)],
      ...(preset.lastProbedAt ? [[t('mcpTools.detail.checkedAt'), preset.lastProbedAt]] : []),
      ...(preset.probePhase ? [[t('mcpTools.detail.probePhase'), preset.probePhase]] : []),
      ...(preset.probeError ? [[t('mcpTools.detail.probeError'), preset.probeError]] : []),
    ] : []),
    [t('mcpTools.detail.runtimePolicy'), t('mcpTools.appliesOnNextTurn')],
  ];
  const tools = getPresetToolDetails(preset);

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="rounded-md border border-border bg-background p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-foreground">{preset.displayName}</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{preset.description}</p>
          </div>
        </div>
        <dl className="mt-4 grid gap-3 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[130px_minmax(0,1fr)] gap-3">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words font-medium text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        <ToolList tools={tools} />
        {!canManage ? (
          <div className="mt-4 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            {t('mcpTools.requiresEditAccess')}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PresetDetailDialog({
  canManage,
  onClose,
  preset,
}: {
  canManage: boolean;
  onClose: () => void;
  preset: WorkspaceMcpPreset;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-tools-detail-dialog-title"
        className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-md border border-border bg-background shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="mcp-tools-detail-dialog-title" className="truncate text-base font-semibold text-foreground">
              {preset.displayName}
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{preset.description}</p>
          </div>
          <button
            type="button"
            aria-label={t('buttons.close')}
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <PresetDetail canManage={canManage} preset={preset} />
      </div>
    </div>
  );
}

function ToolList({ tools }: { tools: ReturnType<typeof getPresetToolDetails> }) {
  const { t } = useTranslation();

  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className="text-sm font-semibold text-foreground">{t('mcpTools.detail.toolsTitle')}</div>
      {tools.length === 0 ? (
        <div className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('mcpTools.detail.toolsEmpty')}
        </div>
      ) : (
        <div className="mt-3 grid gap-2">
          {tools.map((tool) => (
            <div key={tool.name} className="rounded-md border border-border bg-muted/30 px-3 py-2">
              <div className="break-words font-mono text-xs font-semibold text-foreground">{tool.name}</div>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {tool.description || t('mcpTools.detail.noToolDescription')}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ preset }: { preset: WorkspaceMcpPreset }) {
  const { t } = useTranslation();
  const connectionStatus = preset.connectionStatus ?? (preset.installed ? 'unverified' : 'available');
  const tone = preset.installed ? connectionStatus : 'available';
  const className = tone === 'connected'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200'
    : tone === 'probe_failed'
      ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'
      : tone === 'unverified'
        ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200'
        : 'border-border bg-muted text-muted-foreground';
  const label = preset.installed
    ? t(`mcpTools.connection.${connectionStatus}`)
    : t('mcpTools.available');

  return (
    <span className={`shrink-0 rounded-md border px-2.5 py-1 text-xs font-semibold ${className}`}
    >
      {label}
    </span>
  );
}

function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' }) {
  return (
    <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${
      tone === 'success'
        ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200'
        : 'border-border text-muted-foreground'
    }`}
    >
      {children}
    </span>
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
