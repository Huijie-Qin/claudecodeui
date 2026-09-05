import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';

import { Button } from '../../shared/view/ui';
import type { WorkspaceMcpTool } from '../tools-market/hooks/useWorkspaceMcpTools';
import {
  getMcpToolOverrideMode,
  getToolParameterFields,
  type McpTemplateToolSettings,
  type McpToolOverrideMode,
  type McpToolParameterField,
} from '../tools-market/mcpToolOverrides';

type TemplateMcpPreset = {
  id: number;
  name: string;
  displayName: string;
  description?: string;
  tools?: WorkspaceMcpTool[];
};

type FieldDraft = { mode: McpToolOverrideMode | 'none'; rawValue: string };
type ToolDrafts = Record<string, Record<string, FieldDraft>>;

function defaultValue(field: McpToolParameterField) {
  if (field.defaultValue == null) return field.kind === 'boolean' ? 'false' : '';
  if (field.kind === 'array' || field.kind === 'object') {
    return JSON.stringify(field.defaultValue, null, 2);
  }
  return String(field.defaultValue);
}

function formatValue(field: McpToolParameterField, value: unknown) {
  if (value == null) return defaultValue(field);
  if (field.kind === 'array' || field.kind === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function parseValue(field: McpToolParameterField, rawValue: string): unknown {
  if (field.kind === 'number') {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) throw new Error(`参数 ${field.key} 必须是数字`);
    return value;
  }
  if (field.kind === 'boolean') return rawValue === 'true';
  if (field.kind === 'array' || field.kind === 'object') {
    if (!rawValue.trim()) return field.kind === 'array' ? [] : {};
    try {
      return JSON.parse(rawValue);
    } catch {
      throw new Error(`参数 ${field.key} 必须是有效的 JSON`);
    }
  }
  return rawValue;
}

function buildDrafts(tools: WorkspaceMcpTool[], value?: McpTemplateToolSettings): ToolDrafts {
  return Object.fromEntries(tools.map((tool) => [
    tool.name,
    Object.fromEntries(getToolParameterFields(tool).map((field) => {
      const entry = value?.tools?.[tool.name]?.params?.[field.key];
      return [field.key, {
        mode: getMcpToolOverrideMode(entry),
        rawValue: formatValue(field, entry?.value),
      }];
    })),
  ]));
}

function configuredParamCount(drafts: ToolDrafts, toolName: string) {
  return Object.values(drafts[toolName] || {}).filter((draft) => draft.mode !== 'none').length;
}

export default function AgentTemplateMcpSettingsDialog({
  preset,
  value,
  onClose,
  onSave,
}: {
  preset: TemplateMcpPreset;
  value?: McpTemplateToolSettings;
  onClose: () => void;
  onSave: (settings: McpTemplateToolSettings) => void;
}) {
  const tools = useMemo(
    () => (preset.tools || []).filter((tool) => tool.name.trim()),
    [preset.tools],
  );
  const [selectedToolName, setSelectedToolName] = useState(tools[0]?.name || '');
  const selectedTool = tools.find((tool) => tool.name === selectedToolName) || tools[0] || null;
  const fields = useMemo(() => getToolParameterFields(selectedTool), [selectedTool]);
  const [allowedToolNames, setAllowedToolNames] = useState(() => new Set(
    value?.allowedToolNames ?? tools.map((tool) => tool.name),
  ));
  const [drafts, setDrafts] = useState<ToolDrafts>(() => buildDrafts(tools, value));
  const [error, setError] = useState<string | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const allSelected = tools.length > 0 && tools.every((tool) => allowedToolNames.has(tool.name));
  const someSelected = tools.some((tool) => allowedToolNames.has(tool.name));

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected && !allSelected;
  }, [allSelected, someSelected]);

  const updateField = (fieldKey: string, patch: Partial<FieldDraft>) => {
    if (!selectedTool) return;
    setDrafts((current) => ({
      ...current,
      [selectedTool.name]: {
        ...(current[selectedTool.name] || {}),
        [fieldKey]: {
          ...(current[selectedTool.name]?.[fieldKey] || { mode: 'none', rawValue: '' }),
          ...patch,
        },
      },
    }));
  };

  const handleSave = () => {
    setError(null);
    try {
      const configuredTools = Object.create(null) as McpTemplateToolSettings['tools'];
      for (const tool of tools) {
        const params = Object.fromEntries(getToolParameterFields(tool).flatMap((field) => {
          const draft = drafts[tool.name]?.[field.key];
          if (!draft || draft.mode === 'none') return [];
          return [[field.key, { mode: draft.mode, value: parseValue(field, draft.rawValue) }]];
        }));
        if (Object.keys(params).length > 0) configuredTools[tool.name] = { params };
      }
      onSave({
        allowedToolNames: tools.filter((tool) => allowedToolNames.has(tool.name)).map((tool) => tool.name),
        tools: configuredTools,
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'MCP 工具配置保存失败');
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4" role="presentation" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="agent-template-mcp-settings-title" className="flex h-[min(760px,calc(100vh-48px))] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="agent-template-mcp-settings-title" className="truncate text-lg font-semibold text-foreground">{preset.displayName} 设置</h2>
            <p className="mt-1 text-sm text-muted-foreground">配置模板允许使用的 Tool，以及参数的默认值或强制值。配置会随模板复制到新项目。</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose} className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"><X className="h-4 w-4" /></button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[360px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-auto border-r border-border bg-muted/20 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-foreground">Tools</span>
              {tools.length > 0 ? <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"><input ref={selectAllRef} type="checkbox" checked={allSelected} onChange={(event) => setAllowedToolNames(event.target.checked ? new Set(tools.map((tool) => tool.name)) : new Set())} className="h-4 w-4 rounded border-input accent-primary" />全选</label> : null}
            </div>
            {tools.length === 0 ? <div className="rounded-md border border-dashed border-border p-5 text-center text-sm text-muted-foreground">该 MCP 暂无可配置 Tool</div> : (
              <div className="space-y-2">{tools.map((tool) => {
                const selected = tool.name === selectedTool?.name;
                const count = configuredParamCount(drafts, tool.name);
                return <div key={tool.name} className={`relative rounded-md border ${selected ? 'border-primary bg-primary/10 ring-1 ring-primary/20' : 'border-border hover:bg-muted/40'}`}>
                  <label className="absolute right-3 top-3 z-10 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={allowedToolNames.has(tool.name)} onChange={(event) => setAllowedToolNames((current) => { const next = new Set(current); if (event.target.checked) next.add(tool.name); else next.delete(tool.name); return next; })} className="h-4 w-4 rounded border-input accent-primary" />允许</label>
                  <button type="button" onClick={() => setSelectedToolName(tool.name)} className="w-full p-3 pr-24 text-left">
                    <span className="block break-words font-mono text-xs font-semibold text-foreground">{tool.name}</span>
                    <span className="mt-1 block text-sm leading-5 text-muted-foreground">{tool.description || '暂无描述'}</span>
                    <span className="mt-2 flex gap-2"><span className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">{getToolParameterFields(tool).length} 参数</span>{count > 0 ? <span className="rounded border border-amber-400/50 bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-200">已配置 {count}</span> : null}</span>
                  </button>
                </div>;
              })}</div>
            )}
          </aside>

          <main className="min-h-0 overflow-auto p-4">
            {selectedTool ? <>
              <div className="mb-4 rounded-md border border-primary/25 bg-primary/10 px-4 py-3">
                <span className="font-mono text-xs font-semibold text-foreground">{selectedTool.name}</span>
                <p className="mt-1 text-sm text-muted-foreground">{selectedTool.description || '暂无描述'}</p>
              </div>
              <div className="overflow-hidden rounded-md border border-border">
                <div className="grid grid-cols-[150px_minmax(220px,1fr)_270px] bg-muted text-xs font-semibold text-muted-foreground"><div className="border-r border-border px-3 py-2">参数</div><div className="border-r border-border px-3 py-2">参数描述</div><div className="px-3 py-2">取值策略</div></div>
                {fields.length === 0 ? <div className="px-4 py-10 text-center text-sm text-muted-foreground">该 Tool 没有可配置参数</div> : fields.map((field) => {
                  const draft = drafts[selectedTool.name]?.[field.key] || { mode: 'none', rawValue: defaultValue(field) };
                  return <div key={field.key} className="grid min-h-[86px] grid-cols-[150px_minmax(220px,1fr)_270px] border-t border-border">
                    <div className="border-r border-border px-3 py-3"><span className="block break-words font-mono text-xs font-semibold text-foreground">{field.key}</span><span className="mt-1 block text-xs text-muted-foreground">{field.kind}{field.required ? ' · 必填' : ''}</span></div>
                    <div className="border-r border-border px-3 py-3 text-sm leading-6 text-muted-foreground">{field.description || '暂无描述'}</div>
                    <div className="space-y-2 px-3 py-3">
                      <select value={draft.mode} onChange={(event) => updateField(field.key, { mode: event.target.value as FieldDraft['mode'] })} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"><option value="none">不设置</option><option value="default">默认值</option><option value="force">强制值</option></select>
                      <ParameterInput field={field} disabled={draft.mode === 'none'} value={draft.rawValue} onChange={(rawValue) => updateField(field.key, { rawValue })} />
                      {draft.mode === 'default' ? <p className="text-xs text-muted-foreground">Agent 未提供该参数时使用此值。</p> : null}
                      {draft.mode === 'force' ? <p className="text-xs text-muted-foreground">始终使用此值覆盖 Agent 输入。</p> : null}
                    </div>
                  </div>;
                })}
              </div>
            </> : null}
          </main>
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-border px-5 py-4">
          <p className="text-xs text-muted-foreground">模板仅保存工具权限与参数策略，不保存 MCP 密钥；创建项目后按该配置生效。</p>
          <div className="flex items-center gap-2">{error ? <span role="alert" className="mr-2 text-xs text-destructive">{error}</span> : null}<Button variant="outline" onClick={onClose}>取消</Button><Button disabled={tools.length === 0} onClick={handleSave}>保存配置</Button></div>
        </footer>
      </div>
    </div>
  );
}

function ParameterInput({ field, disabled, value, onChange }: { field: McpToolParameterField; disabled: boolean; value: string; onChange: (value: string) => void }) {
  const className = 'min-h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground';
  if (field.kind === 'boolean') return <select disabled={disabled} value={value || 'false'} onChange={(event) => onChange(event.target.value)} className={className}><option value="false">false</option><option value="true">true</option></select>;
  if (field.kind === 'enum') return <select disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} className={className}><option value="">请选择</option>{field.enumValues?.map((item) => <option key={item} value={item}>{item}</option>)}</select>;
  if (field.kind === 'array' || field.kind === 'object' || field.kind === 'string') return <textarea disabled={disabled} rows={field.kind === 'string' ? 1 : 3} value={value} onChange={(event) => onChange(event.target.value)} className={`${className} resize-y ${field.kind === 'string' ? '' : 'font-mono'}`} />;
  return <input disabled={disabled} type="number" value={value} onChange={(event) => onChange(event.target.value)} className={className} />;
}
