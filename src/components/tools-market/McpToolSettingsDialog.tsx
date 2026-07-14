import { useEffect, useMemo, useState } from 'react';
import { Loader2, X } from 'lucide-react';

import type { Project } from '../../types/app';
import { api } from '../../utils/api';

import type { WorkspaceMcpPreset, WorkspaceMcpTool } from './hooks/useWorkspaceMcpTools';
import {
  MCP_TOOL_OVERRIDES_FILE,
  createEmptyOverridesConfig,
  getToolOverrideParams,
  getToolParameterFields,
  normalizeOverridesConfig,
  withToolOverrideParams,
  type McpToolOverrideParam,
  type McpToolOverridesConfig,
  type McpToolParameterField,
} from './mcpToolOverrides';

type McpToolSettingsDialogProps = {
  preset: WorkspaceMcpPreset;
  selectedProject: Project;
  canManage: boolean;
  onClose: () => void;
};

type ParameterFormState = Record<string, {
  custom: boolean;
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

function getInitialFormState(
  fields: McpToolParameterField[],
  overrides: Record<string, McpToolOverrideParam>,
): ParameterFormState {
  return Object.fromEntries(fields.map((field) => {
    const override = overrides[field.key];
    return [
      field.key,
      {
        custom: override?.custom === true,
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
}: McpToolSettingsDialogProps) {
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
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

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
        ...(current[key] ?? { custom: false, rawValue: '' }),
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
        const state = formState[field.key] ?? { custom: false, rawValue: readDefaultValue(field) };
        if (!state.custom) {
          return [];
        }

        return [[
          field.key,
          {
            custom: true,
            value: parseFieldValue(field, state.rawValue),
          },
        ]];
      }));
      const nextConfig = withToolOverrideParams(config, preset, selectedTool.name, params);
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
      setConfig(nextConfig);
      setSuccess('Saved MCP tool overrides.');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Failed to save MCP tool overrides.';
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
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              左侧选择 MCP 暴露的 Tool；右侧显示所选 Tool 的参数、参数描述和自定义值。
            </p>
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
            <div className="mb-3 text-sm font-semibold text-foreground">Tools</div>
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
                  const customCount = Object.values(overrides).filter((entry) => entry?.custom === true).length;
                  return (
                    <button
                      key={tool.name}
                      type="button"
                      onClick={() => setSelectedToolName(tool.name)}
                      className={`rounded-md border p-3 text-left transition ${
                        isSelected
                          ? 'border-primary bg-primary/10 ring-1 ring-primary/20'
                          : 'border-border bg-background hover:border-primary/40 hover:bg-accent/30'
                      }`}
                    >
                      <div className="break-words font-mono text-xs font-semibold text-foreground">{getToolLabel(tool)}</div>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">
                        {tool.description || 'No description.'}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
                          {toolFields.length} 参数
                        </span>
                        {customCount > 0 ? (
                          <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                            {customCount} 自定义
                          </span>
                        ) : null}
                      </div>
                    </button>
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
                    <div className="px-3 py-2">自定义值</div>
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
                      const state = formState[field.key] ?? { custom: false, rawValue: readDefaultValue(field) };
                      return (
                        <div key={field.key} className="grid min-h-[76px] grid-cols-[160px_minmax(260px,1fr)_260px] border-t border-border">
                          <div className="border-r border-border px-3 py-3">
                            <div className="break-words font-mono text-xs font-semibold text-foreground">
                              {field.key}
                              {field.required ? <span className="ml-1 text-destructive">*</span> : null}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">{field.kind}</div>
                          </div>
                          <div className="border-r border-border px-3 py-3">
                            <div className="text-sm leading-6 text-muted-foreground">
                              {field.description || 'No description.'}
                            </div>
                          </div>
                          <div className="px-3 py-3">
                            <label className="mb-2 flex items-center justify-end gap-2 text-xs font-medium text-muted-foreground">
                              <input
                                type="checkbox"
                                checked={state.custom}
                                disabled={!canManage}
                                onChange={(event) => updateField(field.key, { custom: event.target.checked })}
                              />
                              自定义
                            </label>
                            <ParameterInput
                              field={field}
                              disabled={!canManage || !state.custom}
                              value={state.rawValue}
                              onChange={(rawValue) => updateField(field.key, { rawValue })}
                            />
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
          <div className="text-xs text-muted-foreground">
            勾选“自定义”后才能输入参数值；未勾选时使用该 Tool 的默认参数。保存后写入 {MCP_TOOL_OVERRIDES_FILE}。
          </div>
          <div className="flex items-center gap-2">
            {error ? <span className="text-xs text-destructive">{error}</span> : null}
            {success ? <span className="text-xs text-emerald-600 dark:text-emerald-300">{success}</span> : null}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 items-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition hover:bg-accent"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!canManage || isSaving || !selectedTool}
              onClick={handleSave}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
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
  const commonClassName = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground';

  if (field.kind === 'array' || field.kind === 'object') {
    return (
      <textarea
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${commonClassName} min-h-[70px] font-mono`}
      />
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
    <input
      disabled={disabled}
      type="text"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={commonClassName}
    />
  );
}
