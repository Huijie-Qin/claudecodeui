import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Maximize2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Dialog, DialogContent, DialogTitle } from '../../shared/view/ui';
import type { Project } from '../../types/app';
import { api } from '../../utils/api';

import type { WorkspaceMcpPreset, WorkspaceMcpTool } from './hooks/useWorkspaceMcpTools';
import {
  MCP_TOOL_OVERRIDES_FILE,
  createEmptyOverridesConfig,
  getMcpToolOverrideMode,
  getToolOverrideParams,
  getToolParameterFields,
  normalizeOverridesConfig,
  withToolOverrideParams,
  type McpToolOverrideParam,
  type McpToolOverrideMode,
  type McpToolOverridesConfig,
  type McpToolParameterField,
} from './mcpToolOverrides';

type McpToolSettingsDialogProps = {
  preset: WorkspaceMcpPreset;
  selectedProject: Project;
  canManage: boolean;
  onClose: () => void;
  onSaveToolPreference: (allowedToolNames: string[]) => Promise<unknown>;
};

type ParameterFormState = Record<string, {
  mode: McpToolOverrideMode | 'none';
  rawValue: string;
}>;

function readDefaultValue(field: McpToolParameterField): string {
  if (field.defaultValue === undefined || field.defaultValue === null) {
    if (field.kind === 'boolean') return 'false';
    return '';
  }
  if (field.kind === 'array' || field.kind === 'object') {
    return JSON.stringify(field.defaultValue, null, 2);
  }
  return String(field.defaultValue);
}

function stringifyOverrideValue(field: McpToolParameterField, value: unknown): string {
  if (value === undefined || value === null) {
    return readDefaultValue(field);
  }
  if (field.kind === 'array' || field.kind === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function parseFieldValue(field: McpToolParameterField, rawValue: string): unknown {
  if (field.kind === 'number') {
    const numberValue = Number(rawValue);
    if (!Number.isFinite(numberValue)) {
      throw new Error(`${field.key} must be a number`);
    }
    return numberValue;
  }
  if (field.kind === 'boolean') {
    return rawValue === 'true';
  }
  if (field.kind === 'array' || field.kind === 'object') {
    if (!rawValue.trim()) {
      return field.kind === 'array' ? [] : {};
    }
    return JSON.parse(rawValue);
  }
  return rawValue;
}

function formatExampleValue(field: McpToolParameterField): string | undefined {
  if (field.exampleValue === undefined) return undefined;
  if (field.kind === 'array' || field.kind === 'object') {
    return JSON.stringify(field.exampleValue, null, 2);
  }
  return String(field.exampleValue);
}

function getInitialFormState(
  fields: McpToolParameterField[],
  overrides: Record<string, McpToolOverrideParam>,
): ParameterFormState {
  return Object.fromEntries(fields.map((field) => {
    const override = overrides[field.key];
    return [
      field.key,
      {
        mode: getMcpToolOverrideMode(override),
        rawValue: stringifyOverrideValue(field, override?.value),
      },
    ];
  }));
}

async function readOverridesFile(project: Project): Promise<McpToolOverridesConfig> {
  try {
    const response = await api.readFile(project.name, MCP_TOOL_OVERRIDES_FILE, project.workspaceId);
    if (!response.ok) return createEmptyOverridesConfig();

    const data = await response.json() as { content?: string };
    if (!data.content?.trim()) return createEmptyOverridesConfig();

    return normalizeOverridesConfig(JSON.parse(data.content));
  } catch {
    return createEmptyOverridesConfig();
  }
}

async function ensureOverridesDirectory(project: Project): Promise<void> {
  const response = await api.createFile(project.name, {
    path: '',
    type: 'directory',
    name: '.claude',
    workspaceId: project.workspaceId,
  });
  if (response.ok || response.status === 409) return;
  throw new Error(`Failed to ensure .claude directory: ${response.status}`);
}

function getToolLabel(tool: WorkspaceMcpTool): string {
  return tool.name.trim() || 'Unnamed tool';
}

export default function McpToolSettingsDialog({
  preset,
  selectedProject,
  canManage,
  onClose,
  onSaveToolPreference,
}: McpToolSettingsDialogProps) {
  const { t } = useTranslation();
  const tools = useMemo(
    () => (preset.tools ?? []).filter((tool) => tool.name.trim().length > 0),
    [preset.tools],
  );
  const [selectedToolName, setSelectedToolName] = useState(() => tools[0]?.name ?? '');
  const selectedTool = useMemo(
    () => tools.find((tool) => tool.name === selectedToolName) ?? tools[0] ?? null,
    [selectedToolName, tools],
  );
  const fields = useMemo(() => getToolParameterFields(selectedTool), [selectedTool]);
  const [config, setConfig] = useState<McpToolOverridesConfig>(() => createEmptyOverridesConfig());
  const [formState, setFormState] = useState<ParameterFormState>({});
  const [allowedToolNames, setAllowedToolNames] = useState<Set<string>>(() => new Set(
    preset.toolSelectionConfigured
      ? (preset.allowedToolNames ?? [])
      : tools.map((tool) => tool.name),
  ));
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const allToolsAllowed = tools.length > 0 && tools.every((tool) => allowedToolNames.has(tool.name));
  const someToolsAllowed = tools.some((tool) => allowedToolNames.has(tool.name));

  useEffect(() => {
    setAllowedToolNames(new Set(
      preset.toolSelectionConfigured
        ? (preset.allowedToolNames ?? [])
        : tools.map((tool) => tool.name),
    ));
  }, [preset.id, preset.toolSelectionConfigured, preset.allowedToolNames, tools]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someToolsAllowed && !allToolsAllowed;
    }
  }, [allToolsAllowed, someToolsAllowed]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void readOverridesFile(selectedProject)
      .then((nextConfig) => {
        if (cancelled) return;
        setConfig(nextConfig);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProject]);

  useEffect(() => {
    if (!selectedTool) {
      setFormState({});
      return;
    }
    setFormState(getInitialFormState(
      fields,
      getToolOverrideParams(config, preset, selectedTool.name),
    ));
  }, [config, fields, preset, selectedTool]);

  const updateField = (key: string, patch: Partial<ParameterFormState[string]>) => {
    setFormState((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? { mode: 'none', rawValue: '' }),
        ...patch,
      },
    }));
  };

  const handleSave = async () => {
    if (!selectedTool) return;
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const params = Object.fromEntries(fields.flatMap((field) => {
        const state = formState[field.key] ?? { mode: 'none', rawValue: readDefaultValue(field) };
        if (state.mode === 'none') {
          return [];
        }

        return [[
          field.key,
          {
            mode: state.mode,
            value: parseFieldValue(field, state.rawValue),
          },
        ]];
      }));
      let nextConfig = config;
      if (canManage) {
        nextConfig = withToolOverrideParams(config, preset, selectedTool.name, params);
        await ensureOverridesDirectory(selectedProject);
        const response = await api.saveFile(
          selectedProject.name,
          MCP_TOOL_OVERRIDES_FILE,
          JSON.stringify(nextConfig, null, 2),
          selectedProject.workspaceId,
        );
        if (!response.ok) {
          throw new Error(`Failed to save ${MCP_TOOL_OVERRIDES_FILE}: ${response.status}`);
        }
      }
      await onSaveToolPreference(
        tools.filter((tool) => allowedToolNames.has(tool.name)).map((tool) => tool.name),
      );
      setConfig(nextConfig);
      setSuccess(t('mcpTools.settings.saveSuccess'));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t('mcpTools.settings.saveFailed');
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-tool-settings-title"
        className="flex h-[min(760px,calc(100vh-48px))] w-full max-w-6xl flex-col overflow-hidden rounded-md border border-border bg-background shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="mcp-tool-settings-title" className="truncate text-lg font-semibold text-foreground">
              {preset.displayName} 设置
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('mcpTools.settings.description')}</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[360px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-auto border-r border-border bg-muted/30 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-foreground">Tools</div>
              {tools.length > 0 ? (
                <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allToolsAllowed}
                    onChange={(event) => setAllowedToolNames(
                      event.target.checked
                        ? new Set(tools.map((tool) => tool.name))
                        : new Set(),
                    )}
                    className="h-4 w-4 rounded border-input accent-primary"
                  />
                  {t('mcpTools.settings.selectAll')}
                </label>
              ) : null}
            </div>
            {tools.length === 0 ? (
              <div className="rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
                No tools discovered for this MCP.
              </div>
            ) : (
              <div className="grid gap-2">
                {tools.map((tool) => {
                  const isSelected = selectedTool?.name === tool.name;
                  const toolFields = getToolParameterFields(tool);
                  const overrides = getToolOverrideParams(config, preset, tool.name);
                  const configuredCount = Object.values(overrides)
                    .filter((entry) => getMcpToolOverrideMode(entry) !== 'none')
                    .length;
                  return (
                    <div
                      key={tool.name}
                      className={`relative rounded-md border transition ${
                        isSelected
                          ? 'border-primary bg-primary/10 ring-1 ring-primary/20'
                          : 'border-border bg-background hover:border-primary/40 hover:bg-accent/30'
                      }`}
                    >
                      <label className="absolute right-3 top-3 z-10 flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={allowedToolNames.has(tool.name)}
                          onChange={(event) => setAllowedToolNames((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(tool.name);
                            else next.delete(tool.name);
                            return next;
                          })}
                          className="h-4 w-4 rounded border-input accent-primary"
                        />
                        {t('mcpTools.settings.enabled')}
                      </label>
                      <button
                        type="button"
                        onClick={() => setSelectedToolName(tool.name)}
                        className="w-full p-3 pr-24 text-left"
                      >
                        <div className="break-words font-mono text-xs font-semibold text-foreground">{getToolLabel(tool)}</div>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">
                          {tool.description || 'No description.'}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
                            {toolFields.length} 参数
                          </span>
                          {configuredCount > 0 ? (
                            <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                              {t('mcpTools.settings.configuredCount', { count: configuredCount })}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </aside>

          <main className="min-h-0 overflow-auto p-4">
            {selectedTool ? (
              <>
                <div className="mb-4 rounded-md border border-primary/25 bg-primary/10 px-4 py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="break-words font-mono text-xs font-semibold text-foreground">{selectedTool.name}</div>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">
                        {selectedTool.description || 'No description.'}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
                      当前 Tool
                    </span>
                  </div>
                </div>

                <div className="overflow-hidden rounded-md border border-border">
                  <div className="grid grid-cols-[160px_minmax(260px,1fr)_260px] bg-muted text-xs font-semibold uppercase text-muted-foreground">
                    <div className="border-r border-border px-3 py-2">参数</div>
                    <div className="border-r border-border px-3 py-2">参数描述</div>
                    <div className="px-3 py-2">{t('mcpTools.settings.valueStrategy')}</div>
                  </div>
                  {isLoading ? (
                    <div className="flex min-h-[260px] items-center justify-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading settings...
                    </div>
                  ) : fields.length === 0 ? (
                    <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                      This tool has no configurable input parameters.
                    </div>
                  ) : (
                    fields.map((field) => {
                      const state = formState[field.key] ?? { mode: 'none', rawValue: readDefaultValue(field) };
                      const exampleValue = formatExampleValue(field);
                      return (
                        <div key={field.key} className="grid min-h-[76px] grid-cols-[160px_minmax(260px,1fr)_260px] border-t border-border">
                          <div className="border-r border-border px-3 py-3">
                            <div className="break-words font-mono text-xs font-semibold text-foreground">
                              {field.key}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">{field.kind}</div>
                          </div>
                          <div className="border-r border-border px-3 py-3">
                            <div className="text-sm leading-6 text-muted-foreground">
                              {field.description || 'No description.'}
                            </div>
                          </div>
                          <div className="px-3 py-3">
                            <label className="mb-2 block text-xs font-medium text-muted-foreground">
                              <span className="sr-only">{t('mcpTools.settings.valueStrategy')}</span>
                              <select
                                aria-label={`${field.key} ${t('mcpTools.settings.valueStrategy')}`}
                                value={state.mode}
                                disabled={!canManage}
                                onChange={(event) => {
                                  const mode = event.target.value as ParameterFormState[string]['mode'];
                                  updateField(field.key, {
                                    mode,
                                    ...(mode !== 'none' && state.rawValue.length === 0 && exampleValue
                                      ? { rawValue: exampleValue }
                                      : {}),
                                  });
                                }}
                                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
                              >
                                <option value="none">{t('mcpTools.settings.strategy.none')}</option>
                                <option value="default">{t('mcpTools.settings.strategy.default')}</option>
                                <option value="force">{t('mcpTools.settings.strategy.force')}</option>
                              </select>
                            </label>
                            <ParameterInput
                              field={field}
                              disabled={!canManage || state.mode === 'none'}
                              value={state.rawValue}
                              onChange={(rawValue) => updateField(field.key, { rawValue })}
                            />
                            {state.mode !== 'none' ? (
                              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                                {t(`mcpTools.settings.strategyHelp.${state.mode}`)}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            ) : null}
          </main>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          <div className="min-w-0 flex-1 text-xs text-muted-foreground">
            {t('mcpTools.settings.footer', { file: MCP_TOOL_OVERRIDES_FILE })}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {error ? <span className="text-xs text-destructive">{error}</span> : null}
            {success ? <span className="text-xs text-emerald-600 dark:text-emerald-300">{success}</span> : null}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition hover:bg-accent"
            >
              取消
            </button>
            <button
              type="button"
              disabled={isSaving || !selectedTool}
              onClick={handleSave}
              className="inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ParameterInput({
  field,
  disabled,
  value,
  onChange,
}: {
  field: McpToolParameterField;
  disabled: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const compactEditorRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const expandedEditorRef = useRef<HTMLTextAreaElement>(null);
  const wasDisabledRef = useRef(disabled);
  const commonClassName = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground';
  const isStructuredField = field.kind === 'array' || field.kind === 'object';
  const exampleText = formatExampleValue(field);

  useEffect(() => {
    const wasDisabled = wasDisabledRef.current;
    wasDisabledRef.current = disabled;
    if (!wasDisabled || disabled) return undefined;

    const focusFrame = requestAnimationFrame(() => {
      compactEditorRef.current?.focus();
      compactEditorRef.current?.select();
    });
    return () => cancelAnimationFrame(focusFrame);
  }, [disabled]);

  const setCompactEditorRef = (element: HTMLInputElement | HTMLTextAreaElement | null) => {
    compactEditorRef.current = element;
  };

  useEffect(() => {
    if (!isExpanded) return undefined;

    let focusFrame = 0;
    const dialogFrame = requestAnimationFrame(() => {
      focusFrame = requestAnimationFrame(() => expandedEditorRef.current?.focus());
    });
    return () => {
      cancelAnimationFrame(dialogFrame);
      cancelAnimationFrame(focusFrame);
    };
  }, [isExpanded]);

  if (isStructuredField || field.kind === 'string') {
    return (
      <Dialog open={isExpanded} onOpenChange={setIsExpanded}>
        <div className="relative">
          {isStructuredField ? (
            <textarea
              ref={setCompactEditorRef}
              disabled={disabled}
              value={value}
              placeholder={exampleText}
              onChange={(event) => onChange(event.target.value)}
              className={`${commonClassName} min-h-[70px] resize-y pr-10 font-mono`}
            />
          ) : (
            <textarea
              ref={setCompactEditorRef}
              disabled={disabled}
              rows={1}
              value={value}
              placeholder={exampleText}
              onChange={(event) => onChange(event.target.value)}
              className={`${commonClassName} min-h-[38px] resize-y pr-10`}
            />
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => setIsExpanded(true)}
            aria-label={`放大编辑 ${field.key}`}
            title="放大编辑"
            className="absolute right-4 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground shadow-sm transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>

        <DialogContent className="flex h-[80vh] max-h-[720px] w-[92vw] max-w-4xl flex-col overflow-hidden rounded-lg p-0">
          <DialogTitle>放大编辑 {field.key}</DialogTitle>
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <div className="truncate font-mono text-sm font-semibold text-foreground">{field.key}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{field.kind}</div>
            </div>
            <button
              type="button"
              onClick={() => setIsExpanded(false)}
              aria-label="关闭放大编辑"
              title="关闭"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 p-4">
            <div className="relative h-full">
              <textarea
                ref={expandedEditorRef}
                disabled={disabled}
                value={value}
                placeholder={exampleText}
                onChange={(event) => onChange(event.target.value)}
                className={`${commonClassName} h-full resize-none font-mono leading-6`}
              />
            </div>
          </div>
          <div className="flex justify-end border-t border-border px-4 py-3">
            <button
              type="button"
              onClick={() => setIsExpanded(false)}
              className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
            >
              完成
            </button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (field.kind === 'boolean') {
    return (
      <select
        disabled={disabled}
        value={value || 'false'}
        onChange={(event) => onChange(event.target.value)}
        className={commonClassName}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (field.kind === 'enum') {
    return (
      <select
        disabled={disabled}
        value={value || field.enumValues?.[0] || ''}
        onChange={(event) => onChange(event.target.value)}
        className={commonClassName}
      >
        {(field.enumValues ?? []).map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    );
  }

  return (
    <div className="relative">
      <input
        ref={setCompactEditorRef}
        disabled={disabled}
        type="text"
        value={value}
        placeholder={exampleText}
        onChange={(event) => onChange(event.target.value)}
        className={commonClassName}
      />
    </div>
  );
}
