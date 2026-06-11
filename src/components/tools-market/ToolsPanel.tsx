import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Plug,
  RefreshCw,
  Search,
  ServerCrash,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Project } from '../../types/app';

import {
  useWorkspaceTools,
  type WorkspaceMcpImportPreview,
  type WorkspaceMcpServerInput,
} from './hooks/useWorkspaceTools';
import {
  filterWorkspaceTools,
  formatHeaderLines,
  getToolDisplayName,
  getToolStatusLabelKey,
  getToolTypeLabelKey,
  parseHeaderLines,
  sortWorkspaceTools,
  type WorkspaceMcpProbe,
  type WorkspaceTool,
} from './utils/toolFormatting';

type ToolsPanelProps = {
  selectedProject: Project;
  isReadOnly: boolean;
};

export default function ToolsPanel({ selectedProject, isReadOnly }: ToolsPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [isConnectOpen, setIsConnectOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const {
    data,
    error,
    isLoading,
    previewImport,
    probeMcp,
    reload,
    removeMcp,
    saveMcp,
  } = useWorkspaceTools(selectedProject.workspaceId);
  const tools = useMemo(
    () => filterWorkspaceTools(sortWorkspaceTools(data?.tools ?? []), query),
    [data?.tools, query],
  );
  const selectedTool = useMemo(
    () => tools.find((tool) => tool.id === selectedToolId) ?? null,
    [selectedToolId, tools],
  );
  const canManage = !isReadOnly && data?.canManage !== false;

  const handleDelete = async (tool: WorkspaceTool) => {
    if (!canManage || tool.type !== 'mcp') return;
    if (!window.confirm(t('toolsMarket.deleteConfirm', { name: tool.name }))) return;
    setActionError(null);
    try {
      await removeMcp(tool.name);
      setSelectedToolId(null);
    } catch (caughtError) {
      setActionError(caughtError instanceof Error ? caughtError.message : t('toolsMarket.errors.delete'));
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-foreground">{t('toolsMarket.title')}</h1>
            <p className="mt-1 truncate text-sm text-muted-foreground">{selectedProject.displayName}</p>
          </div>
          <button
            type="button"
            disabled={!canManage}
            onClick={() => setIsConnectOpen(true)}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground shadow-sm transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plug className="h-4 w-4" />
            {t('toolsMarket.connectMcpServer')}
          </button>
        </div>
        {actionError ? (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{actionError}</span>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-px border-b border-border bg-border md:grid-cols-3">
        <SummaryItem label={t('toolsMarket.summary.total')} value={String(data?.summary.total ?? 0)} />
        <SummaryItem label={t('toolsMarket.summary.httpMcp')} value={String(data?.summary.httpMcp ?? 0)} />
        <SummaryItem label={t('toolsMarket.summary.blocked')} value={String(data?.summary.blocked ?? 0)} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 flex-1 flex-col border-r border-border">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                placeholder={t('toolsMarket.searchPlaceholder')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
              />
            </div>
            <span className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground">
              {t('toolsMarket.filters.all')}
            </span>
            <span className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground">
              HTTP
            </span>
          </div>

          <ToolsList
            error={error}
            isLoading={isLoading}
            onReload={reload}
            onSelect={setSelectedToolId}
            query={query}
            selectedToolId={selectedToolId}
            tools={tools}
          />
        </div>

        <aside className="hidden w-[380px] min-w-[320px] flex-col bg-muted/30 lg:flex">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground">{t('toolsMarket.detailTitle')}</h2>
          </div>
          <ToolDetail canManage={canManage} onDelete={handleDelete} tool={selectedTool} />
        </aside>
      </div>

      {isConnectOpen ? (
        <ConnectMcpDialog
          onClose={() => setIsConnectOpen(false)}
          onPreviewImport={previewImport}
          onProbe={probeMcp}
          onSaved={() => {
            setIsConnectOpen(false);
            setActionError(null);
          }}
          onSave={saveMcp}
        />
      ) : null}
    </section>
  );
}

function ToolsList({
  error,
  isLoading,
  onReload,
  onSelect,
  query,
  selectedToolId,
  tools,
}: {
  error: string | null;
  isLoading: boolean;
  onReload: () => void;
  onSelect: (id: string) => void;
  query: string;
  selectedToolId: string | null;
  tools: WorkspaceTool[];
}) {
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('toolsMarket.loading')}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
        <div className="max-w-sm">
          <AlertCircle className="mx-auto h-5 w-5 text-destructive" />
          <h2 className="mt-3 text-sm font-semibold text-foreground">{t('toolsMarket.errorTitle')}</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{error}</p>
          <button
            type="button"
            onClick={onReload}
            className="mt-3 inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground shadow-sm transition hover:bg-accent"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('toolsMarket.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (tools.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md border border-border bg-muted">
            <Wrench className="h-5 w-5 text-muted-foreground" />
          </div>
          <h2 className="mt-3 text-sm font-semibold text-foreground">
            {query ? t('toolsMarket.emptySearchTitle') : t('toolsMarket.emptyTitle')}
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {query ? t('toolsMarket.emptySearchDescription') : t('toolsMarket.emptyDescription')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <div className="grid gap-2">
        {tools.map((tool) => (
          <button
            key={tool.id}
            type="button"
            onClick={() => onSelect(tool.id)}
            className={`rounded-md border p-3 text-left transition ${
              selectedToolId === tool.id
                ? 'border-primary bg-primary/5'
                : 'border-border bg-background hover:border-primary/40 hover:bg-accent/40'
            }`}
          >
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-foreground">{getToolDisplayName(tool)}</div>
                <div className="mt-1 truncate text-xs text-muted-foreground">{tool.description || tool.url || tool.name}</div>
              </div>
              <ToolStatusBadge tool={tool} />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="rounded-md border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {t(getToolTypeLabelKey(tool))}
              </span>
              {tool.transport ? (
                <span className="rounded-md border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {tool.transport.toUpperCase()}
                </span>
              ) : null}
              {tool.toolCount ? (
                <span className="rounded-md border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {t('toolsMarket.toolCount', { count: tool.toolCount })}
                </span>
              ) : null}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function ToolDetail({
  canManage,
  onDelete,
  tool,
}: {
  canManage: boolean;
  onDelete: (tool: WorkspaceTool) => void;
  tool: WorkspaceTool | null;
}) {
  const { t } = useTranslation();

  if (!tool) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <div className="max-w-[260px]">
          <AlertCircle className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('toolsMarket.detailEmpty')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-foreground">{getToolDisplayName(tool)}</h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{tool.description || tool.url || tool.name}</p>
        </div>
        <ToolStatusBadge tool={tool} />
      </div>

      <dl className="mt-5 grid gap-3 text-sm">
        <DetailRow label={t('toolsMarket.detail.type')} value={t(getToolTypeLabelKey(tool))} />
        <DetailRow label={t('toolsMarket.detail.status')} value={t(getToolStatusLabelKey(tool))} />
        {tool.permission ? <DetailRow label={t('toolsMarket.detail.permission')} value={tool.permission} /> : null}
        {tool.transport ? <DetailRow label={t('toolsMarket.detail.transport')} value={tool.transport} /> : null}
        {tool.url ? <DetailRow label={t('toolsMarket.detail.url')} value={tool.url} /> : null}
        {tool.headers && Object.keys(tool.headers).length > 0 ? (
          <DetailRow label={t('toolsMarket.detail.headers')} value={formatHeaderLines(tool.headers)} />
        ) : null}
        {tool.probe?.checkedAt ? <DetailRow label={t('toolsMarket.detail.checkedAt')} value={tool.probe.checkedAt} /> : null}
        {tool.probe?.phase ? <DetailRow label={t('toolsMarket.detail.phase')} value={tool.probe.phase} /> : null}
        {tool.probe?.error ? <DetailRow label={t('toolsMarket.detail.probeError')} value={tool.probe.error} danger /> : null}
        {tool.missingValues?.length ? (
          <DetailRow label={t('toolsMarket.detail.missingValues')} value={tool.missingValues.join(', ')} danger />
        ) : null}
      </dl>

      {tool.tools?.length ? (
        <div className="mt-5">
          <div className="text-xs font-medium uppercase text-muted-foreground">{t('toolsMarket.detail.exposedTools')}</div>
          <div className="mt-2 grid gap-2">
            {tool.tools.map((entry) => (
              <div key={entry.name} className="rounded-md border border-border bg-background px-3 py-2">
                <div className="text-sm font-medium text-foreground">{entry.name}</div>
                {entry.description ? (
                  <div className="mt-1 text-xs leading-5 text-muted-foreground">{entry.description}</div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {tool.type === 'mcp' && tool.manageable ? (
        <button
          type="button"
          disabled={!canManage}
          onClick={() => onDelete(tool)}
          className="mt-5 inline-flex h-8 items-center gap-2 rounded-md border border-destructive/30 bg-background px-3 text-xs font-medium text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t('toolsMarket.delete')}
        </button>
      ) : null}
    </div>
  );
}

function ConnectMcpDialog({
  onClose,
  onPreviewImport,
  onProbe,
  onSave,
  onSaved,
}: {
  onClose: () => void;
  onPreviewImport: (json: string) => Promise<WorkspaceMcpImportPreview>;
  onProbe: (payload: WorkspaceMcpServerInput) => Promise<WorkspaceMcpProbe>;
  onSave: (payload: WorkspaceMcpServerInput) => Promise<unknown>;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [importJson, setImportJson] = useState('');
  const [importPreview, setImportPreview] = useState<WorkspaceMcpImportPreview | null>(null);
  const [probe, setProbe] = useState<WorkspaceMcpProbe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const payload = useMemo<WorkspaceMcpServerInput>(() => ({
    name: name.trim(),
    type: 'http',
    url: url.trim(),
    headers: parseHeaderLines(headers),
  }), [headers, name, url]);

  const runProbe = async () => {
    setError(null);
    setIsProbing(true);
    try {
      const result = await onProbe(payload);
      setProbe(result);
    } catch (caughtError) {
      setProbe(null);
      setError(caughtError instanceof Error ? caughtError.message : t('toolsMarket.errors.probe'));
    } finally {
      setIsProbing(false);
    }
  };

  const save = async () => {
    setError(null);
    setIsSaving(true);
    try {
      await onSave(payload);
      onSaved();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : t('toolsMarket.errors.save'));
    } finally {
      setIsSaving(false);
    }
  };

  const previewImport = async () => {
    setError(null);
    setIsPreviewing(true);
    try {
      setImportPreview(await onPreviewImport(importJson));
    } catch (caughtError) {
      setImportPreview(null);
      setError(caughtError instanceof Error ? caughtError.message : t('toolsMarket.errors.importPreview'));
    } finally {
      setIsPreviewing(false);
    }
  };

  const useImportEntry = (entry: WorkspaceMcpImportPreview['entries'][number]) => {
    setName(entry.name);
    setUrl(entry.url ?? '');
    setHeaders(formatHeaderLines(entry.headers));
    setProbe(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-md border border-border bg-background shadow-lg">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-foreground">{t('toolsMarket.dialog.title')}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t('toolsMarket.dialog.description')}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-accent"
            >
              {t('toolsMarket.dialog.close')}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-5">
          {error ? (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
            <div className="grid gap-3">
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium text-foreground">{t('toolsMarket.dialog.name')}</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="context7"
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
                />
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium text-foreground">{t('toolsMarket.dialog.url')}</span>
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="http://127.0.0.1:3333/mcp"
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
                />
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium text-foreground">{t('toolsMarket.dialog.headers')}</span>
                <textarea
                  value={headers}
                  onChange={(event) => setHeaders(event.target.value)}
                  placeholder="Authorization=Bearer token"
                  rows={5}
                  className="resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
                />
              </label>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={isProbing || isSaving}
                  onClick={runProbe}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isProbing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  {t('toolsMarket.dialog.probe')}
                </button>
                <button
                  type="button"
                  disabled={isProbing || isSaving}
                  onClick={save}
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                  {t('toolsMarket.dialog.save')}
                </button>
              </div>
            </div>

            <div className="grid gap-3">
              <ProbeResult probe={probe} />
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium text-foreground">{t('toolsMarket.dialog.importJson')}</span>
                <textarea
                  value={importJson}
                  onChange={(event) => setImportJson(event.target.value)}
                  placeholder={'{"mcpServers":{"docs":{"type":"http","url":"https://example.com/mcp"}}}'}
                  rows={6}
                  className="resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
                />
              </label>
              <button
                type="button"
                disabled={isPreviewing}
                onClick={previewImport}
                className="inline-flex h-9 w-fit items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isPreviewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                {t('toolsMarket.dialog.previewImport')}
              </button>
              <ImportPreview preview={importPreview} onUseEntry={useImportEntry} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProbeResult({ probe }: { probe: WorkspaceMcpProbe | null }) {
  const { t } = useTranslation();
  if (!probe) {
    return (
      <div className="rounded-md border border-border bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
        {t('toolsMarket.dialog.probeEmpty')}
      </div>
    );
  }

  const healthy = probe.status === 'healthy';
  return (
    <div className={`rounded-md border px-3 py-3 text-sm ${
      healthy ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-destructive/30 bg-destructive/10 text-destructive'
    }`}
    >
      <div className="flex items-center gap-2 font-medium">
        {healthy ? <CheckCircle2 className="h-4 w-4" /> : <ServerCrash className="h-4 w-4" />}
        {healthy ? t('toolsMarket.dialog.probeHealthy') : t('toolsMarket.dialog.probeFailed')}
      </div>
      <div className="mt-2 text-xs">
        {t('toolsMarket.dialog.probePhase', { phase: probe.phase || '-' })}
        {probe.toolCount !== undefined ? ` · ${t('toolsMarket.toolCount', { count: probe.toolCount })}` : ''}
      </div>
      {probe.error ? <div className="mt-2 text-xs">{probe.error}</div> : null}
    </div>
  );
}

function ImportPreview({
  onUseEntry,
  preview,
}: {
  onUseEntry: (entry: WorkspaceMcpImportPreview['entries'][number]) => void;
  preview: WorkspaceMcpImportPreview | null;
}) {
  const { t } = useTranslation();
  if (!preview) return null;

  return (
    <div className="grid gap-2">
      <div className="text-xs font-medium uppercase text-muted-foreground">
        {t('toolsMarket.dialog.importSummary', {
          total: preview.summary.total,
          ready: preview.summary.ready,
          needsValue: preview.summary.needsValue,
          unsupported: preview.summary.unsupported,
          invalid: preview.summary.invalid,
        })}
      </div>
      {preview.entries.map((entry) => (
        <div key={entry.name} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">{entry.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {entry.status}
              {entry.conflict ? ` · ${t('toolsMarket.dialog.conflict')}` : ''}
              {entry.reason ? ` · ${entry.reason}` : ''}
            </div>
          </div>
          {(entry.status === 'ready' || entry.status === 'needs_value') ? (
            <button
              type="button"
              onClick={() => onUseEntry(entry)}
              className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition hover:bg-accent"
            >
              {t('toolsMarket.dialog.useEntry')}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ToolStatusBadge({ tool }: { tool: WorkspaceTool }) {
  const { t } = useTranslation();
  const tone =
    tool.status === 'healthy' || tool.status === 'available'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : tool.status === 'probe_failed' || tool.status === 'needs_value' || tool.status === 'unsupported'
        ? 'border-destructive/30 bg-destructive/10 text-destructive'
        : 'border-border bg-muted text-muted-foreground';

  return (
    <span className={`shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium ${tone}`}>
      {t(getToolStatusLabelKey(tool))}
    </span>
  );
}

function DetailRow({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase text-muted-foreground">{label}</dt>
      <dd className={`mt-1 whitespace-pre-wrap break-words ${danger ? 'text-destructive' : 'text-foreground'}`}>{value}</dd>
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background px-6 py-3">
      <div className="text-xs font-medium uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold text-foreground">{value}</div>
    </div>
  );
}
