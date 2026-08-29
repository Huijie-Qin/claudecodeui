import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Braces,
  ChevronDown,
  CircleAlert,
  Code2,
  Database,
  FileCode2,
  Info,
  MessageSquare,
  Plus,
  RefreshCcw,
  Save,
  Settings2,
  Sparkles,
  TerminalSquare,
  Trash2,
  UsersRound,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';
import { Badge, Button, Card, Dialog, DialogContent, DialogTitle, Input, Tooltip } from '../../../shared/view/ui';

import {
  CCUI_SCRIPT_APIS,
  EVENT_BY_NAME,
  buildFieldChoices,
  buildReferenceChoices,
  buildScriptTemplate,
  findMatchedTool,
  getClaudeOutputFields,
  inferNativeMatcherMode,
  scriptApiName,
} from './catalog';
import { createHookItemId } from './editorUtils';
import HookSelect, { type HookSelectOption } from './HookSelect';
import type {
  FieldChoice,
  FieldType,
  HookConfig,
  HookConfigDraft,
  HookEventName,
  HookPostAction,
  HookResources,
  HookScriptLanguage,
  HookScriptOutput,
  HookValueBinding,
  JsonSchemaProperty,
} from './types';

type HookConfigEditorProps = {
  hook: HookConfigDraft | HookConfig;
  visibleEvents: HookEventName[];
  resources: HookResources;
  busy: boolean;
  dirty: boolean;
  onChange: (hook: HookConfigDraft | HookConfig) => void;
  onBack: () => void;
  onSave: () => void;
  onPublish: () => void;
  onManageBindings: () => void;
  onManageEvents: () => void;
};

function Section({
  number,
  title,
  description,
  children,
  action,
}: {
  number: number;
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card className="overflow-visible border-border/80 shadow-none">
      <div className="flex items-start gap-3 border-b border-border/70 px-4 py-3.5 sm:px-5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xs font-semibold text-primary">
          {number}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {description ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </Card>
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function fieldLabel(t: ReturnType<typeof useTranslation>['t'], field: FieldChoice) {
  if (field.label) return field.label;
  if (field.labelKey) return t(field.labelKey, { defaultValue: field.path });
  return field.path;
}

function fieldGroup(t: ReturnType<typeof useTranslation>['t'], field: FieldChoice) {
  return t(`hooks.fieldGroups.${field.group}`, { defaultValue: field.group });
}

function pythonEnvironmentPath(path: string) {
  return path.replace(/[A-Z]/g, (value) => `_${value.toLowerCase()}`);
}

function literalDefault(type: FieldType, property?: JsonSchemaProperty): unknown {
  if (property && Object.prototype.hasOwnProperty.call(property, 'default')) return property.default;
  if (type === 'boolean') return false;
  if (type === 'number') return 0;
  if (type === 'array') return [];
  if (type === 'object') return {};
  return '';
}

function propertyType(property?: JsonSchemaProperty): FieldType {
  if (property?.type === 'number' || property?.type === 'integer') return 'number';
  if (property?.type === 'boolean') return 'boolean';
  if (property?.type === 'array') return 'array';
  if (property?.type === 'object') return 'object';
  return 'string';
}

function LiteralInput({
  type,
  property,
  value,
  onChange,
}: {
  type: FieldType;
  property?: JsonSchemaProperty;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [jsonText, setJsonText] = useState(() => {
    try {
      return JSON.stringify(value ?? literalDefault(type, property), null, 2);
    } catch {
      return type === 'array' ? '[]' : '{}';
    }
  });
  const [jsonError, setJsonError] = useState(false);

  if (property?.enum?.length) {
    return (
      <HookSelect
        value={String(value ?? '')}
        options={property.enum.map((item) => ({ value: String(item), label: String(item) }))}
        onChange={onChange}
        placeholder="选择值"
        ariaLabel="选择固定值"
      />
    );
  }
  if (type === 'boolean') {
    return (
      <HookSelect
        value={String(Boolean(value))}
        options={[{ value: 'true', label: '是' }, { value: 'false', label: '否' }]}
        onChange={(next) => onChange(next === 'true')}
        placeholder="选择值"
        ariaLabel="选择布尔值"
      />
    );
  }
  if (type === 'object' || type === 'array') {
    return (
      <div>
        <textarea
          rows={4}
          value={jsonText}
          onChange={(event) => {
            const next = event.target.value;
            setJsonText(next);
            try {
              const parsed = JSON.parse(next);
              const valid = type === 'array' ? Array.isArray(parsed) : parsed && typeof parsed === 'object' && !Array.isArray(parsed);
              setJsonError(!valid);
              if (valid) onChange(parsed);
            } catch {
              setJsonError(true);
            }
          }}
          className={cn(
            'w-full resize-y rounded-xl border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-4 focus-visible:ring-primary/10',
            jsonError ? 'border-destructive' : 'border-input',
          )}
        />
        {jsonError ? <p className="mt-1 text-[10px] text-destructive">请输入有效的 JSON</p> : null}
      </div>
    );
  }
  return (
    <Input
      type={type === 'number' ? 'number' : 'text'}
      value={typeof value === 'string' || typeof value === 'number' ? value : ''}
      onChange={(event) => onChange(type === 'number' ? Number(event.target.value) : event.target.value)}
      className="h-10 rounded-xl"
    />
  );
}

function BindingEditor({
  binding,
  type,
  property,
  references,
  onChange,
}: {
  binding: HookValueBinding;
  type: FieldType;
  property?: JsonSchemaProperty;
  references: FieldChoice[];
  onChange: (binding: HookValueBinding) => void;
}) {
  const { t } = useTranslation('admin');
  const sourceValue = binding.source === 'reference' ? binding.path : '__literal__';
  const options: HookSelectOption[] = [
    { value: '__literal__', label: t('hooks.fixedValue'), group: t('hooks.fieldGroups.value') },
    ...references.map((field) => ({
      value: field.path,
      label: fieldLabel(t, field),
      description: field.path,
      group: fieldGroup(t, field),
    })),
  ];

  return (
    <div className="grid gap-2 lg:grid-cols-[minmax(180px,0.8fr)_minmax(240px,1.2fr)]">
      <HookSelect
        value={sourceValue}
        options={options}
        onChange={(source) => onChange(source === '__literal__'
          ? { source: 'literal', value: literalDefault(type, property) }
          : { source: 'reference', path: source })}
        placeholder={t('hooks.actions.valueSource')}
        ariaLabel={t('hooks.actions.valueSource')}
      />
      {binding.source !== 'reference' ? (
        <LiteralInput
          type={type}
          property={property}
          value={binding.source === 'literal' ? binding.value : binding.template}
          onChange={(value) => onChange({ source: 'literal', value })}
        />
      ) : (
        <div className="flex min-h-10 items-center rounded-xl border border-dashed border-border px-3 text-xs text-muted-foreground">
          <code className="truncate">{binding.path}</code>
        </div>
      )}
    </div>
  );
}

function ScriptOutputsEditor({
  outputs,
  onChange,
}: {
  outputs: HookScriptOutput[];
  onChange: (outputs: HookScriptOutput[]) => void;
}) {
  const addOutput = () => {
    let index = outputs.length + 1;
    while (outputs.some((output) => output.name === `output${index}`)) index += 1;
    onChange([...outputs, { name: `output${index}`, type: 'string' }]);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-foreground">脚本输出变量</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">脚本在 output 中返回同名字段，供后续行为和最终返回配置引用。</div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addOutput}>
          <Plus className="h-3.5 w-3.5" />
          添加变量
        </Button>
      </div>
      {!outputs.length ? (
        <div className="rounded-xl border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
          没有声明输出。脚本仍可执行文件处理、环境读取和日志输出。
        </div>
      ) : null}
      {outputs.map((output, index) => (
        <div key={`${output.name}-${index}`} className="grid gap-2 rounded-xl border border-border bg-background p-3 md:grid-cols-[minmax(130px,1fr)_130px_auto]">
          <Input
            value={output.name}
            onChange={(event) => {
              const next = [...outputs];
              next[index] = { ...output, name: event.target.value.replace(/[^A-Za-z0-9_$]/g, '') };
              onChange(next);
            }}
            placeholder="变量名"
            className="h-9 rounded-lg font-mono text-xs"
          />
          <HookSelect
            value={output.type}
            options={(['string', 'number', 'boolean', 'object', 'array'] as FieldType[]).map((value) => ({ value, label: value }))}
            onChange={(value) => {
              const next = [...outputs];
              next[index] = { ...output, type: value as FieldType };
              onChange(next);
            }}
            placeholder="类型"
            ariaLabel="输出变量类型"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onChange(outputs.filter((_, outputIndex) => outputIndex !== index))}
            aria-label="删除脚本输出变量"
          >
            <Trash2 className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function BooleanConditionEditor({
  condition,
  references,
  actionVerb,
  ariaLabel,
  onChange,
}: {
  condition: unknown;
  references: FieldChoice[];
  actionVerb: '调用' | '记录' | '发送';
  ariaLabel: string;
  onChange: (condition: HookValueBinding | null) => void;
}) {
  const conditionRecord = asRecord(condition);
  const conditionPath = conditionRecord.source === 'reference'
    ? String(conditionRecord.path || '')
    : '__always__';
  const booleanReferences = references.filter((field) => field.type === 'boolean');

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-foreground">执行条件（布尔变量，可选）</span>
        <Badge variant="outline" className="font-mono text-[10px]">boolean</Badge>
      </div>
      <HookSelect
        value={conditionPath}
        options={[
          { value: '__always__', label: `不限制（始终${actionVerb}）` },
          ...booleanReferences.map((field) => ({
            value: field.path,
            label: field.label || field.path,
            description: `boolean · ${field.path}`,
            group: field.group === 'script' ? '脚本输出 · boolean' : '当前事件 · boolean',
          })),
        ]}
        onChange={(value) => onChange(
          value === '__always__' ? null : { source: 'reference', path: value },
        )}
        placeholder={`不限制（始终${actionVerb}）`}
        ariaLabel={ariaLabel}
      />
      <p className="text-[10px] leading-4 text-muted-foreground">
        请选择 boolean 类型变量：值为 true 时{actionVerb}，false 时跳过；不选择则始终{actionVerb}。
      </p>
      {booleanReferences.length === 0 ? (
        <p className="text-[10px] leading-4 text-amber-600 dark:text-amber-400">
          当前没有可用的布尔变量，请先在脚本输出变量中添加 boolean 类型变量。
        </p>
      ) : null}
    </div>
  );
}

function MpcActionEditor({
  action,
  resources,
  references,
  onChange,
}: {
  action: HookPostAction;
  resources: HookResources;
  references: FieldChoice[];
  onChange: (config: Record<string, unknown>) => void;
}) {
  const config = asRecord(action.config);
  const toolName = typeof config.toolName === 'string' ? config.toolName : '';
  const tool = resources.mcpTools.find((item) => item.name === toolName);
  const inputs = asRecord(config.inputs);
  const properties = tool?.inputSchema?.properties || {};
  const required = new Set(tool?.inputSchema?.required || []);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-foreground">MCP 工具</span>
          <HookSelect
            value={toolName}
            options={resources.mcpTools.map((item) => ({
              value: item.name,
              label: `${item.serverDisplayName} · ${item.toolName}`,
              description: item.description || item.name,
            }))}
            onChange={(nextToolName) => {
              const nextTool = resources.mcpTools.find((item) => item.name === nextToolName);
              const nextInputs = Object.fromEntries(Object.entries(nextTool?.inputSchema?.properties || {}).map(([key, property]) => {
                const type = propertyType(property);
                return [key, { source: 'literal', value: literalDefault(type, property) }];
              }));
              onChange({
                ...config,
                toolName: nextToolName,
                mcpServerId: nextTool?.mcpServerId || '',
                inputs: nextInputs,
              });
            }}
            placeholder={resources.mcpTools.length ? '选择 MCP 工具' : '暂无可调用的 MCP 工具'}
            ariaLabel="选择 MCP 工具"
          />
        </label>
        <BooleanConditionEditor
          condition={config.condition}
          references={references}
          actionVerb="调用"
          ariaLabel="选择 MCP 执行条件布尔变量"
          onChange={(condition) => onChange({ ...config, condition })}
        />
      </div>

      {tool && Object.keys(properties).length ? (
        <div className="space-y-2">
          <div className="text-xs font-medium text-foreground">工具参数</div>
          {Object.entries(properties).map(([key, property]) => {
            const type = propertyType(property);
            const rawBinding = asRecord(inputs[key]);
            const binding: HookValueBinding = rawBinding.source === 'reference'
              ? { source: 'reference', path: String(rawBinding.path || '') }
              : { source: 'literal', value: Object.prototype.hasOwnProperty.call(rawBinding, 'value') ? rawBinding.value : literalDefault(type, property) };
            return (
              <div key={key} className="space-y-2 rounded-xl border border-border bg-muted/10 p-3">
                <div>
                  <span className="text-xs font-medium text-foreground">{key}</span>
                  {required.has(key) ? <span className="ml-1 text-destructive">*</span> : null}
                  <span className="ml-2 text-[10px] text-muted-foreground">{property.description || property.type || 'string'}</span>
                </div>
                <BindingEditor
                  binding={binding}
                  type={type}
                  property={property}
                  references={references}
                  onChange={(nextBinding) => onChange({ ...config, inputs: { ...inputs, [key]: nextBinding } })}
                />
              </div>
            );
          })}
        </div>
      ) : null}
      {tool && !Object.keys(properties).length ? (
        <div className="rounded-xl border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">该工具没有输入参数。</div>
      ) : null}
    </div>
  );
}

const DEFAULT_MCP_LOOP_TERMINATION_SCRIPT = `async def run(event, ccui):
    result = event.get("result") or {}
    status = result.get("status")

    if status == "success":
        return {"output": {"status": "success"}}
    if status == "failed":
        return {"output": {"status": "failed"}}
    return {"output": {"status": "running"}}
`;

function McpLoopActionEditor({
  action,
  matchedTool,
  onChange,
}: {
  action: HookPostAction;
  matchedTool?: HookResources['mcpTools'][number];
  onChange: (config: Record<string, unknown>) => void;
}) {
  const config = asRecord(action.config);
  const terminationScript = typeof config.terminationScript === 'string'
    ? config.terminationScript
    : DEFAULT_MCP_LOOP_TERMINATION_SCRIPT;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-foreground">循环目标</span>
          {matchedTool ? (
            <div className="flex min-h-10 items-center rounded-xl border border-border bg-muted/20 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-foreground">
                  {matchedTool.serverDisplayName} · {matchedTool.toolName}
                </div>
                <code className="block truncate text-[10px] text-muted-foreground">{matchedTool.name}</code>
              </div>
              <Badge variant="outline" className="ml-auto shrink-0">来自 Matcher</Badge>
            </div>
          ) : (
            <div className="min-h-10 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
              Matcher 必须完整匹配一个已发布的 MCP 工具。
            </div>
          )}
        </div>
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-foreground">页面等待提示</span>
          <Input
            value={typeof config.waitingLabel === 'string' ? config.waitingLabel : ''}
            onChange={(event) => onChange({ ...config, waitingLabel: event.target.value })}
            placeholder="等待任务完成"
            className="h-10 rounded-xl text-xs"
          />
        </label>
      </div>

      <div className="rounded-xl border border-border bg-muted/10 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
        每轮自动复用首次触发 Hook 的完整 MCP 调用参数，无需再次配置参数映射。
      </div>

      <div className="space-y-2">
        <div className="text-xs font-semibold text-foreground">循环策略</div>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-foreground">轮询间隔（ms）</span>
            <Input type="number" min={10} value={Number(config.pollIntervalMs ?? 10000)} onChange={(event) => onChange({ ...config, pollIntervalMs: Number(event.target.value) })} className="h-10 rounded-xl font-mono text-xs" />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-foreground">单次超时（ms）</span>
            <Input type="number" min={10} value={Number(config.perCallTimeoutMs ?? 15000)} onChange={(event) => onChange({ ...config, perCallTimeoutMs: Number(event.target.value) })} className="h-10 rounded-xl font-mono text-xs" />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-foreground">最长等待（ms）</span>
            <Input type="number" min={10} value={Number(config.maxWaitMs ?? 2700000)} onChange={(event) => onChange({ ...config, maxWaitMs: Number(event.target.value) })} className="h-10 rounded-xl font-mono text-xs" />
          </label>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="text-xs font-semibold text-foreground">Python 终止脚本</div>
          <Badge variant="outline">每轮执行</Badge>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-7 text-xs"
            onClick={() => onChange({ ...config, terminationScript: DEFAULT_MCP_LOOP_TERMINATION_SCRIPT })}
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            重置示例
          </Button>
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-slate-950">
          <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-xs text-slate-300">
            <TerminalSquare className="h-4 w-4 text-sky-300" />
            <span>termination.py</span>
          </div>
          <textarea
            value={terminationScript}
            onChange={(event) => onChange({ ...config, terminationScript: event.target.value })}
            spellCheck={false}
            className="min-h-[260px] w-full resize-y border-0 bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100 outline-none"
          />
        </div>
        <div className="grid gap-2 text-[11px] leading-5 text-muted-foreground md:grid-cols-2">
          <div className="rounded-xl border border-border bg-muted/10 px-3 py-2">
            输入：<code>event.result</code>、<code>event.initial_result</code>、<code>event.inputs</code>、<code>event.attempt_count</code>、<code>event.elapsed_ms</code>
          </div>
          <div className="rounded-xl border border-border bg-muted/10 px-3 py-2">
            返回：<code>{'{"output":{"status":"running | success | failed"}}'}</code>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
        <code>mcp_loop_run</code> 是 CCUI 内部后置行为，不会暴露给 Agent。它会重复调用 Matcher 命中的 MCP 工具；Python 脚本返回 <code>success</code> 或 <code>failed</code> 后，最后一次结果将返回给 Agent 并恢复会话。
      </div>
    </div>
  );
}

function SkillActionEditor({
  action,
  resources,
  references,
  onChange,
}: {
  action: HookPostAction;
  resources: HookResources;
  references: FieldChoice[];
  onChange: (config: Record<string, unknown>) => void;
}) {
  const config = asRecord(action.config);
  const skillId = typeof config.skillId === 'string' ? config.skillId : '';
  const skillName = typeof config.skillName === 'string' ? config.skillName : '';
  const template = typeof config.argumentsTemplate === 'string' ? config.argumentsTemplate : '';
  const [pickerOpen, setPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectionRef = useRef({ start: template.length, end: template.length });
  const referenceOptions = references.map((field) => ({
    value: field.path,
    label: field.path,
    description: field.label || field.description || field.type,
    group: field.group === 'event'
      ? '当前事件'
      : field.group === 'environment'
        ? '环境变量'
        : field.group === 'script'
          ? '脚本输出'
          : '前序行为输出',
  }));

  const selectReference = (path: string) => {
    const token = `{{${path}}}`;
    const selection = selectionRef.current;
    const next = `${template.slice(0, selection.start)}${token}${template.slice(selection.end)}`;
    const cursor = selection.start + token.length;
    onChange({ ...config, argumentsTemplate: next });
    setPickerOpen(false);
    selectionRef.current = { start: cursor, end: cursor };
    globalThis.setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursor, cursor);
    }, 0);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-foreground">内置 Hook Skill</span>
          <HookSelect
            value={skillId}
            options={resources.skills.map((skill) => ({
              value: skill.skillId,
              label: skill.displayName || skill.name,
              description: skill.description || `/${skill.name} · v${skill.version}`,
            }))}
            onChange={(value) => {
              const skill = resources.skills.find((item) => item.skillId === value);
              onChange({
                ...config,
                skillId: skill?.skillId || '',
                skillName: skill?.name || '',
              });
            }}
            placeholder={resources.skills.length ? '选择内置 Hook Skill' : '暂无内置 Hook Skill'}
            ariaLabel="选择内置 Hook Skill"
          />
        </label>
        <BooleanConditionEditor
          condition={config.condition}
          references={references}
          actionVerb="调用"
          ariaLabel="选择 Skill 执行条件布尔变量"
          onChange={(condition) => onChange({ ...config, condition })}
        />
      </div>
      {resources.skillSource?.error ? (
        <p className="text-xs leading-5 text-destructive">{resources.skillSource.error}</p>
      ) : null}
      <p className="text-xs leading-5 text-muted-foreground">
        这里只显示 CCUI Hook 内置 Skill（镜像随附或管理员上传）；用户开启 Hook 时会把完整目录缓存到工作区专用的 hook-config 目录。
      </p>
      <div className="block space-y-1.5">
        <span className="text-xs font-medium text-foreground">Skill 参数</span>
        <div className="relative">
          <textarea
            ref={textareaRef}
            rows={3}
            value={template}
            onChange={(event) => {
              const cursor = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
              selectionRef.current = {
                start: cursor,
                end: event.currentTarget.selectionEnd ?? cursor,
              };
              onChange({ ...config, argumentsTemplate: event.currentTarget.value });
            }}
            onClick={(event) => {
              selectionRef.current = {
                start: event.currentTarget.selectionStart,
                end: event.currentTarget.selectionEnd,
              };
            }}
            onKeyDown={(event) => {
              const cursor = event.currentTarget.selectionStart;
              if (event.key === '/') {
                event.preventDefault();
                selectionRef.current = { start: cursor, end: event.currentTarget.selectionEnd };
                setPickerOpen(true);
              } else {
                selectionRef.current = { start: cursor, end: event.currentTarget.selectionEnd };
              }
            }}
            placeholder="输入 Skill 参数；输入 / 选择变量"
            className="w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 text-sm outline-none focus-visible:ring-4 focus-visible:ring-primary/10"
          />
          <HookSelect
            value=""
            options={referenceOptions}
            onChange={selectReference}
            placeholder="搜索变量"
            ariaLabel="选择 Skill 参数变量"
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            hideTrigger
            className="absolute inset-x-0 top-full z-40"
            menuClassName="min-w-[360px]"
          />
        </div>
      </div>
      <div className="rounded-xl bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        实际恢复问题：<code>/{skillName || 'skill'} {template}</code>
      </div>
    </div>
  );
}

function AgentMessageActionEditor({
  action,
  references,
  onChange,
}: {
  action: HookPostAction;
  references: FieldChoice[];
  onChange: (config: Record<string, unknown>) => void;
}) {
  const config = asRecord(action.config);
  const template = typeof config.messageTemplate === 'string' ? config.messageTemplate : '';
  const [pickerOpen, setPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectionRef = useRef({ start: template.length, end: template.length });
  const referenceOptions = references.map((field) => ({
    value: field.path,
    label: field.path,
    description: field.label || field.description || field.type,
    group: field.group === 'event'
      ? '当前事件'
      : field.group === 'environment'
        ? '环境变量'
        : field.group === 'script'
          ? '脚本输出'
          : '前序行为输出',
  }));

  const selectReference = (path: string) => {
    const token = `{{${path}}}`;
    const selection = selectionRef.current;
    const next = `${template.slice(0, selection.start)}${token}${template.slice(selection.end)}`;
    const cursor = selection.start + token.length;
    onChange({ ...config, messageTemplate: next });
    setPickerOpen(false);
    selectionRef.current = { start: cursor, end: cursor };
    globalThis.setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursor, cursor);
    }, 0);
  };

  return (
    <div className="space-y-4">
      <BooleanConditionEditor
        condition={config.condition}
        references={references}
        actionVerb="发送"
        ariaLabel="选择 Agent 消息发送条件布尔变量"
        onChange={(condition) => onChange({ ...config, condition })}
      />
      <div className="block space-y-1.5">
        <span className="text-xs font-medium text-foreground">消息内容</span>
        <div className="relative">
          <textarea
            ref={textareaRef}
            rows={5}
            value={template}
            onChange={(event) => {
              const cursor = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
              selectionRef.current = {
                start: cursor,
                end: event.currentTarget.selectionEnd ?? cursor,
              };
              onChange({ ...config, messageTemplate: event.currentTarget.value });
            }}
            onClick={(event) => {
              selectionRef.current = {
                start: event.currentTarget.selectionStart,
                end: event.currentTarget.selectionEnd,
              };
            }}
            onKeyDown={(event) => {
              const cursor = event.currentTarget.selectionStart;
              if (event.key === '/') {
                event.preventDefault();
                selectionRef.current = { start: cursor, end: event.currentTarget.selectionEnd };
                setPickerOpen(true);
              } else {
                selectionRef.current = { start: cursor, end: event.currentTarget.selectionEnd };
              }
            }}
            placeholder="输入发送给 Agent 的消息；输入 / 选择变量"
            className="w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 text-sm outline-none focus-visible:ring-4 focus-visible:ring-primary/10"
          />
          <HookSelect
            value=""
            options={referenceOptions}
            onChange={selectReference}
            placeholder="搜索变量"
            ariaLabel="选择 Agent 消息变量"
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            hideTrigger
            className="absolute inset-x-0 top-full z-40"
            menuClassName="min-w-[360px]"
          />
        </div>
      </div>
      <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
        当前回答结束并执行 Hook 后，这条消息会进入原会话的下一回合队列，不会加载 Skill。
      </div>
    </div>
  );
}

function RecordActionEditor({
  action,
  references,
  onChange,
}: {
  action: HookPostAction;
  references: FieldChoice[];
  onChange: (config: Record<string, unknown>) => void;
}) {
  const config = asRecord(action.config);
  const recordType = typeof config.recordType === 'string' ? config.recordType : '';
  const fields = asRecord(config.fields);
  const fieldEntries = Object.entries(fields);

  const updateFields = (nextFields: Record<string, unknown>) => {
    onChange({ ...config, fields: nextFields });
  };

  const addField = () => {
    let index = fieldEntries.length + 1;
    while (Object.prototype.hasOwnProperty.call(fields, `field${index}`)) index += 1;
    updateFields({ ...fields, [`field${index}`]: { source: 'literal', value: '' } });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-foreground">记录类型</span>
          <Input
            value={recordType}
            onChange={(event) => onChange({ ...config, recordType: event.target.value })}
            placeholder="例如 sql_response_metrics"
            className="h-10 rounded-xl font-mono text-xs"
          />
        </label>
        <BooleanConditionEditor
          condition={config.condition}
          references={references}
          actionVerb="记录"
          ariaLabel="选择记录执行条件布尔变量"
          onChange={(condition) => onChange({ ...config, condition })}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-foreground">记录字段</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">将事件、环境、脚本输出或前序行为结果映射为数据库记录。</div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addField}>
            <Plus className="h-3.5 w-3.5" />
            添加字段
          </Button>
        </div>
        {!fieldEntries.length ? (
          <div className="rounded-xl border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
            暂无字段；执行时会写入一个空对象记录。
          </div>
        ) : null}
        {fieldEntries.map(([fieldName, rawBinding], index) => {
          const bindingRecord = asRecord(rawBinding);
          const binding: HookValueBinding = bindingRecord.source === 'reference'
            ? { source: 'reference', path: String(bindingRecord.path || '') }
            : { source: 'literal', value: bindingRecord.value ?? '' };
          const referenceType = binding.source === 'reference'
            ? references.find((field) => field.path === binding.path)?.type
            : undefined;
          return (
            <div key={`${fieldName}-${index}`} className="space-y-2 rounded-xl border border-border bg-muted/10 p-3">
              <div className="flex items-center gap-2">
                <Input
                  value={fieldName}
                  onChange={(event) => {
                    const nextName = event.target.value;
                    const nextEntries = fieldEntries.map(([key, value], entryIndex) => (
                      entryIndex === index ? [nextName, value] : [key, value]
                    ));
                    updateFields(Object.fromEntries(nextEntries));
                  }}
                  placeholder="字段名"
                  className="h-9 flex-1 rounded-lg font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => updateFields(Object.fromEntries(fieldEntries.filter((_, entryIndex) => entryIndex !== index)))}
                  aria-label="删除记录字段"
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
              <BindingEditor
                binding={binding}
                type={referenceType || 'string'}
                references={references}
                onChange={(nextBinding) => updateFields({ ...fields, [fieldName]: nextBinding })}
              />
            </div>
          );
        })}
      </div>
      <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
        记录会写入 CCUI SQLite 数据库的 <code>hook_data_records</code> 表。保存并返回 Hook 列表后，点击该 Hook 的“业务数据”即可查看最近记录。
      </div>
    </div>
  );
}

function PostActionsEditor({
  hook,
  resources,
  references,
  onChange,
}: {
  hook: HookConfigDraft | HookConfig;
  resources: HookResources;
  references: FieldChoice[];
  onChange: (actions: HookPostAction[]) => void;
}) {
  const canQueueAgentTurn = hook.eventName === 'Stop' || hook.eventName === 'StopFailure';
  const matchedTool = findMatchedTool(resources, hook.matcher.value, hook.matcher.mode);
  const matchedMcpTool = resources.mcpTools.find((tool) => tool.name === matchedTool?.name);
  const canAddMcpLoop = hook.eventName === 'PostToolUse'
    && Boolean(matchedMcpTool)
    && !hook.postActions.some((action) => action.type === 'mcp_loop_run');
  const hasMcpLoop = hook.postActions.some((action) => action.type === 'mcp_loop_run');
  const addAction = (type: HookPostAction['type']) => {
    const action: HookPostAction = {
      id: createHookItemId(),
      type,
      position: hook.postActions.length,
      config: type === 'call_mcp_tool'
        ? { toolName: '', condition: null, inputs: {} }
        : type === 'mcp_loop_run'
          ? {
              pollIntervalMs: 10000,
              perCallTimeoutMs: 15000,
              maxWaitMs: 2700000,
              terminationScript: DEFAULT_MCP_LOOP_TERMINATION_SCRIPT,
              waitingLabel: '等待任务完成',
            }
        : type === 'write_record'
          ? { recordType: '', condition: null, fields: {} }
          : type === 'invoke_skill'
            ? { skillId: '', skillName: '', condition: null, argumentsTemplate: '' }
            : { messageTemplate: '', condition: null },
    };
    onChange([...hook.postActions, action]);
  };

  const updateAction = (index: number, config: Record<string, unknown>) => {
    const next = [...hook.postActions];
    next[index] = { ...next[index], config };
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => addAction('call_mcp_tool')} disabled={hasMcpLoop}>
          <Wrench className="h-4 w-4" />
          调用 MCP 工具
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => addAction('write_record')} disabled={hasMcpLoop}>
          <Database className="h-4 w-4" />
          记录数据
        </Button>
        <Tooltip content={canAddMcpLoop ? '暂停当前 Agent，复用首次调用参数循环调用 Matcher 命中的 MCP，命中终止条件后恢复。' : '请先让 PostToolUse Matcher 完整匹配一个已发布的 MCP 工具；一个 Hook 最多配置一次循环。'}>
          <span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => addAction('mcp_loop_run')}
              disabled={!canAddMcpLoop}
            >
              <RefreshCcw className="h-4 w-4" />
              循环调用 MCP
            </Button>
          </span>
        </Tooltip>
        <Tooltip content={canQueueAgentTurn ? '回答正常或异常结束后，启动一个新的模型回合调用 Skill。' : '调用 Skill 仅适用于回答结束或回答异常结束。'}>
          <span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => addAction('invoke_skill')}
              disabled={!canQueueAgentTurn || hasMcpLoop}
            >
              <Sparkles className="h-4 w-4" />
              调用 Skill
            </Button>
          </span>
        </Tooltip>
        <Tooltip content={canQueueAgentTurn ? '回答正常或异常结束后，把消息排入原会话的下一回合。' : '发送 Agent 消息仅适用于回答结束或回答异常结束。'}>
          <span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => addAction('send_agent_message')}
              disabled={!canQueueAgentTurn || hasMcpLoop}
            >
              <MessageSquare className="h-4 w-4" />
              发送 Agent 消息
            </Button>
          </span>
        </Tooltip>
      </div>
      {!hook.postActions.length ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          没有配置后置行为。可添加业务数据写入、MCP 工具、循环调用、Skill 或 Agent 消息，也可只返回字段给 Claude。
        </div>
      ) : null}
      {hook.postActions.map((action, index) => {
        const availableReferences = references.filter((field) => {
          if (field.group !== 'action') return true;
          const referencedId = field.path.split('.')[1];
          return hook.postActions.findIndex((item) => item.id === referencedId) < index;
        });
        return (
          <div key={action.id} className="overflow-visible rounded-xl border border-border bg-background">
            <div className="flex items-center gap-2 rounded-t-xl border-b border-border bg-muted/20 px-3 py-2.5">
              {action.type === 'call_mcp_tool'
                ? <Wrench className="h-4 w-4 text-primary" />
                : action.type === 'mcp_loop_run'
                  ? <RefreshCcw className="h-4 w-4 text-primary" />
                : action.type === 'write_record'
                  ? <Database className="h-4 w-4 text-primary" />
                  : action.type === 'invoke_skill'
                    ? <Sparkles className="h-4 w-4 text-primary" />
                    : <MessageSquare className="h-4 w-4 text-primary" />}
              <span className="text-xs font-semibold text-foreground">
                {index + 1}. {action.type === 'call_mcp_tool'
                  ? '调用 MCP 工具'
                  : action.type === 'mcp_loop_run'
                    ? '循环调用 MCP（暂停并恢复）'
                  : action.type === 'write_record'
                    ? '记录数据'
                    : action.type === 'invoke_skill'
                      ? '调用 Skill（恢复回合）'
                      : '发送 Agent 消息（下一回合）'}
              </span>
              <code className="ml-1 hidden text-[10px] text-muted-foreground sm:inline">actions.{action.id}.output</code>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="ml-auto h-8 w-8"
                onClick={() => onChange(hook.postActions.filter((_, actionIndex) => actionIndex !== index).map((item, nextIndex) => ({ ...item, position: nextIndex })))}
                aria-label="删除后置行为"
              >
                <Trash2 className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>
            <div className="p-4">
              {action.type === 'call_mcp_tool' ? (
                <MpcActionEditor
                  action={action}
                  resources={resources}
                  references={availableReferences}
                  onChange={(config) => updateAction(index, config)}
                />
              ) : action.type === 'mcp_loop_run' ? (
                <McpLoopActionEditor
                  action={action}
                  matchedTool={matchedMcpTool}
                  onChange={(config) => updateAction(index, config)}
                />
              ) : action.type === 'write_record' ? (
                <RecordActionEditor
                  action={action}
                  references={availableReferences}
                  onChange={(config) => updateAction(index, config)}
                />
              ) : action.type === 'invoke_skill' ? (
                <SkillActionEditor
                  action={action}
                  resources={resources}
                  references={availableReferences}
                  onChange={(config) => updateAction(index, config)}
                />
              ) : (
                <AgentMessageActionEditor
                  action={action}
                  references={availableReferences}
                  onChange={(config) => updateAction(index, config)}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function responseProperty(path: string): JsonSchemaProperty | undefined {
  if (path === 'decision') return { type: 'string', enum: ['block'] };
  if (path.endsWith('permissionDecision')) return { type: 'string', enum: ['allow', 'deny', 'ask', 'defer'] };
  if (path.endsWith('.action')) return { type: 'string', enum: ['accept', 'decline', 'cancel'] };
  return undefined;
}

function ReturnValueEditor({
  binding,
  type,
  property,
  references,
  onChange,
}: {
  binding: HookValueBinding;
  type: FieldType;
  property?: JsonSchemaProperty;
  references: FieldChoice[];
  onChange: (binding: HookValueBinding) => void;
}) {
  const { t } = useTranslation('admin');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [rawValue, setRawValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectionRef = useRef<{ start: number; end: number } | null>(null);
  const options: HookSelectOption[] = references.map((field) => ({
    value: field.path,
    label: fieldLabel(t, field),
    description: field.path,
    group: fieldGroup(t, field),
  }));

  useEffect(() => {
    if (binding.source === 'template') {
      setRawValue(binding.template);
    } else if (binding.source === 'reference') {
      setRawValue(`{{${binding.path}}}`);
    } else if (type === 'object' || type === 'array') {
      try {
        setRawValue(JSON.stringify(binding.value));
      } catch {
        setRawValue(type === 'array' ? '[]' : '{}');
      }
    } else {
      setRawValue(String(binding.value ?? ''));
    }
    setInvalid(false);
  }, [binding, type]);

  const applyRawValue = (value: string) => {
    setRawValue(value);
    const exactReference = value.trim().match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (exactReference) {
      setInvalid(false);
      onChange({ source: 'reference', path: exactReference[1] });
      return;
    }
    if (type === 'string') {
      const enumValues = property?.enum?.map(String);
      const valid = !enumValues?.length || enumValues.includes(value);
      setInvalid(!valid);
      if (valid) {
        onChange(value.includes('{{')
          ? { source: 'template', template: value }
          : { source: 'literal', value });
      }
      return;
    }
    if (type === 'boolean') {
      const valid = value === 'true' || value === 'false';
      setInvalid(!valid);
      if (valid) onChange({ source: 'literal', value: value === 'true' });
      return;
    }
    if (type === 'number') {
      const parsed = Number(value);
      const valid = value.trim() !== '' && Number.isFinite(parsed);
      setInvalid(!valid);
      if (valid) onChange({ source: 'literal', value: parsed });
      return;
    }
    try {
      const parsed = JSON.parse(value);
      const valid = type === 'array'
        ? Array.isArray(parsed)
        : parsed && typeof parsed === 'object' && !Array.isArray(parsed);
      setInvalid(!valid);
      if (valid) onChange({ source: 'literal', value: parsed });
    } catch {
      setInvalid(true);
    }
  };

  const selectReference = (path: string) => {
    const token = `{{${path}}}`;
    const selection = selectionRef.current || { start: rawValue.length, end: rawValue.length };
    const next = type === 'string'
      ? `${rawValue.slice(0, selection.start)}${token}${rawValue.slice(selection.end)}`
      : token;
    const cursor = type === 'string' ? selection.start + token.length : token.length;
    setRawValue(next);
    setInvalid(false);
    onChange(type === 'string'
      ? { source: 'template', template: next }
      : { source: 'reference', path });
    setPickerOpen(false);
    selectionRef.current = { start: cursor, end: cursor };
    globalThis.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(cursor, cursor);
    }, 0);
  };

  const placeholder = property?.enum?.length
    ? `可填写：${property.enum.join(' / ')}，或输入 / 选择变量`
    : type === 'boolean'
      ? '填写 true 或 false，或输入 / 选择变量'
      : type === 'object'
        ? '填写 JSON 对象，或输入 / 选择变量'
        : type === 'array'
          ? '填写 JSON 数组，或输入 / 选择变量'
          : type === 'number'
            ? '填写数字，或输入 / 选择变量'
            : '填写内容，输入 / 选择变量';

  return (
    <div className="relative min-w-0">
      <input
        ref={inputRef}
        value={rawValue}
        onChange={(event) => applyRawValue(event.target.value)}
        onKeyUp={(event) => {
          if (event.key !== '/') return;
          const cursor = event.currentTarget.selectionStart ?? rawValue.length;
          selectionRef.current = { start: Math.max(0, cursor - 1), end: cursor };
          setPickerOpen(true);
        }}
        placeholder={placeholder}
        aria-invalid={invalid}
        title={invalid ? '当前值格式不正确' : undefined}
        className={cn(
          'h-10 w-full rounded-xl border bg-background px-3 text-sm outline-none transition focus-visible:ring-4 focus-visible:ring-primary/10',
          invalid ? 'border-destructive' : 'border-input',
        )}
      />
      <HookSelect
        value=""
        options={options}
        onChange={selectReference}
        placeholder="/ 变量"
        ariaLabel="选择返回值变量"
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        hideTrigger
        className="absolute inset-x-0 top-full z-40"
        menuClassName="!top-0 mt-1 w-full"
      />
    </div>
  );
}

function ClaudeResponseEditor({
  hook,
  references,
  onChange,
}: {
  hook: HookConfigDraft | HookConfig;
  references: FieldChoice[];
  onChange: (bindings: Record<string, HookValueBinding>) => void;
}) {
  const outputs = getClaudeOutputFields(hook.eventName);
  const bindings = hook.claudeResponse.bindings;

  if (!outputs.length) {
    return (
      <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs leading-5 text-muted-foreground">
        {hook.eventName === 'StopFailure'
          ? '回答异常结束事件会忽略 Hook 返回值；可使用 MCP 工具、Skill 恢复回合或高级脚本处理。'
          : '当前事件没有可配置的 Claude 返回字段。'}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {outputs.map((output) => {
        const binding = bindings[output.path];
        const enabled = Boolean(binding);
        return (
          <div
            key={output.path}
            className={cn(
              'grid grid-cols-[minmax(120px,0.8fr)_68px_minmax(160px,1.2fr)] items-center gap-3 rounded-xl border bg-background p-3 transition-colors',
              enabled ? 'border-primary/35' : 'border-border',
            )}
          >
            <div className="min-w-0">
              <code className="block break-all text-xs font-semibold text-foreground">{output.path}</code>
              <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{output.description}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={`${enabled ? '关闭' : '开启'}返回字段 ${output.path}`}
              onClick={() => {
                if (!enabled) {
                  onChange({
                    ...bindings,
                    [output.path]: {
                      source: 'literal',
                      value: literalDefault(output.type, responseProperty(output.path)),
                    },
                  });
                  return;
                }
                const next = { ...bindings };
                delete next[output.path];
                onChange(next);
              }}
              className="flex items-center gap-1.5 justify-self-center rounded-lg py-1 text-[11px] text-muted-foreground outline-none focus-visible:ring-4 focus-visible:ring-primary/10"
            >
              <span>返回</span>
              <span className={cn(
                'inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors',
                enabled ? 'bg-primary' : 'bg-muted-foreground/25',
              )}>
                <span className={cn(
                  'h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                  enabled ? 'translate-x-4' : 'translate-x-0',
                )} />
              </span>
            </button>
            {binding ? (
              <ReturnValueEditor
                binding={binding}
                type={output.type}
                property={responseProperty(output.path)}
                references={references}
                onChange={(nextBinding) => onChange({ ...bindings, [output.path]: nextBinding })}
              />
            ) : (
              <input
                disabled
                placeholder="开启返回后填写，输入 / 选择变量"
                className="h-10 w-full rounded-xl border border-input bg-muted/30 px-3 text-sm text-muted-foreground outline-none"
              />
            )}
          </div>
        );
      })}
      <div className="rounded-xl bg-muted/30 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
        `hookSpecificOutput.hookEventName` 由运行时按当前事件自动补充，不需要配置。
      </div>
    </div>
  );
}

export default function HookConfigEditor({
  hook,
  visibleEvents,
  resources,
  busy,
  dirty,
  onChange,
  onBack,
  onSave,
  onPublish,
  onManageBindings,
  onManageEvents,
}: HookConfigEditorProps) {
  const { t } = useTranslation('admin');
  const [scriptReferencesOpen, setScriptReferencesOpen] = useState(false);
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const isPersisted = 'id' in hook;
  const status = isPersisted ? hook.status : 'draft';
  const eventDefinition = EVENT_BY_NAME.get(hook.eventName);
  const inputs = useMemo(() => buildFieldChoices(hook, resources), [hook, resources]);
  const references = useMemo(() => buildReferenceChoices(hook, resources), [hook, resources]);
  const language = hook.extensionLogic?.language || 'javascript';
  const scriptApis = CCUI_SCRIPT_APIS.filter((api) => !api.javascript.startsWith('ccui.records.'));
  const scriptEnvironmentVariables = resources.environmentVariables.filter((variable) => variable.path.startsWith('ccui.env.'));
  const matcherValue = hook.matcher.value || '';
  const hasMcpLoop = hook.postActions.some((action) => action.type === 'mcp_loop_run');
  const nativeMatcherMode = inferNativeMatcherMode(hook.eventName, matcherValue);
  const matcherRegexError = useMemo(() => {
    if (!eventDefinition?.matcherField || eventDefinition.matcherKind === 'fileNames') return false;
    if (nativeMatcherMode !== 'regex' || !matcherValue) return false;
    try {
      new RegExp(matcherValue);
      return false;
    } catch {
      return true;
    }
  }, [eventDefinition, matcherValue, nativeMatcherMode]);

  const updateDraft = (patch: Partial<HookConfigDraft>) => onChange({ ...hook, ...patch });
  const buildTemplate = (
    eventName: HookEventName,
    nextLanguage: HookScriptLanguage,
    outputs: HookScriptOutput[],
  ) => {
    const nextHook = { ...hook, eventName };
    const nextInputs = buildFieldChoices(nextHook, resources);
    return buildScriptTemplate({
      eventName,
      eventLabel: t(`hooks.events.${eventName}.label`),
      eventDescription: t(`hooks.events.${eventName}.description`),
      inputs: nextInputs.map((field) => ({ path: field.path, label: fieldLabel(t, field), type: field.type })),
      outputs,
      language: nextLanguage,
    });
  };

  const editorEvents = visibleEvents.includes(hook.eventName) ? visibleEvents : [hook.eventName, ...visibleEvents];
  const eventOptions = editorEvents.map((eventName) => ({
    value: eventName,
    label: t(`hooks.events.${eventName}.label`),
    description: t(`hooks.events.${eventName}.description`),
  }));
  const hasEffect = Boolean(hook.extensionLogic?.code.trim())
    || hook.postActions.length > 0
    || Object.keys(hook.claudeResponse.bindings).length > 0;
  const canSave = Boolean(hook.name.trim()) && !matcherRegexError;
  const canPublish = canSave && hasEffect;
  const handleBack = () => {
    if (dirty) {
      setDiscardDialogOpen(true);
      return;
    }
    onBack();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/10">
      <div className="sticky top-0 z-20 flex shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 py-2.5 backdrop-blur sm:px-5">
        <Button type="button" variant="ghost" size="sm" onClick={handleBack} className="px-2">
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">{t('hooks.backToList')}</span>
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{hook.name || t('hooks.newHook')}</div>
          <div className="text-[11px] text-muted-foreground">
            {t(`statuses.${status}`)}{isPersisted && hook.version > 0 ? ` · v${hook.version}` : ''}
          </div>
        </div>
        {isPersisted && hook.bindingController === 'sql_check' ? (
          <div className="flex items-center gap-2">
            <Badge variant="outline">{t('hooks.builtin')}</Badge>
            {status === 'published' ? <Badge variant="outline">{t('hooks.bindings.sqlCheckManaged')}</Badge> : null}
          </div>
        ) : isPersisted && status === 'published' ? (
          <Button type="button" variant="outline" size="sm" onClick={onManageBindings} disabled={busy}>
            <UsersRound className="h-4 w-4" />
            {hook.activationScope === 'all_users'
              ? t('hooks.bindings.allUsersShort')
              : hook.boundTenantCount > 0
                ? t('hooks.bindings.boundTenantCountShort', { count: hook.boundTenantCount })
                : hook.boundUserCount > 0
                  ? t('hooks.bindings.boundCountShort', { count: hook.boundUserCount })
                  : t('hooks.bindings.manage')}
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={onSave} disabled={busy || !canSave}>
          <Save className="h-4 w-4" />
          <span className="hidden sm:inline">{t('hooks.saveDraft')}</span>
        </Button>
        <Button type="button" size="sm" onClick={onPublish} disabled={busy || !canPublish}>
          {t('hooks.publish')}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-4 px-3 py-4 sm:px-5 sm:py-5">
          <Section
            number={1}
            title="选择 Hook 事件"
            description="事件决定 Claude Code 何时回调，以及后续配置能获得哪些参数。"
          >
            <div className="grid gap-x-4 gap-y-4 lg:grid-cols-2 lg:items-start">
              <label className="block space-y-1.5">
                <span className="flex h-7 items-center text-xs font-medium text-foreground">{t('hooks.fields.name')}</span>
                <Input
                  value={hook.name}
                  onChange={(event) => updateDraft({ name: event.target.value })}
                  placeholder={t('hooks.fields.namePlaceholder')}
                  className="h-10 rounded-xl"
                  maxLength={120}
                />
              </label>
              <div className="space-y-1.5">
                <div className="flex h-7 items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-foreground">{t('hooks.triggerEvent')}</span>
                    <Tooltip content={t(`hooks.events.${hook.eventName}.description`)}>
                      <button type="button" className="text-muted-foreground" aria-label={t(`hooks.events.${hook.eventName}.description`)}>
                        <Info className="h-3.5 w-3.5" />
                      </button>
                    </Tooltip>
                  </div>
                  <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onManageEvents}>
                    <Settings2 className="h-3.5 w-3.5" />
                    {t('hooks.moreEvents')}
                  </Button>
                </div>
                <HookSelect
                  value={hook.eventName}
                  options={eventOptions}
                  onChange={(value) => {
                    const eventName = value as HookEventName;
                    updateDraft({
                      eventName,
                      matcher: {},
                      postActions: eventName === 'Stop' || eventName === 'StopFailure'
                        ? hook.postActions
                        : hook.postActions.filter((action) => (
                            action.type !== 'invoke_skill' && action.type !== 'send_agent_message'
                          )).map((action, index) => ({ ...action, position: index })),
                      claudeResponse: { bindings: {} },
                    });
                  }}
                  placeholder={t('hooks.selectEvent')}
                  ariaLabel={t('hooks.selectEvent')}
                />
              </div>
              <label className="block space-y-1.5 lg:col-span-2">
                <span className="text-xs font-medium text-foreground">{t('hooks.fields.description')}</span>
                <textarea
                  rows={2}
                  value={hook.description}
                  onChange={(event) => updateDraft({ description: event.target.value })}
                  placeholder={t('hooks.fields.descriptionPlaceholder')}
                  className="min-h-[70px] w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 text-sm outline-none focus-visible:ring-4 focus-visible:ring-primary/10"
                  maxLength={1000}
                />
              </label>
            </div>
          </Section>

          <Section
            number={2}
            title="定义 Matcher"
            description="Matcher 由 Claude Code 原生执行；留空或 * 表示匹配该事件的每次回调。"
            action={eventDefinition?.matcherField ? (
              <Badge variant={nativeMatcherMode === 'regex' ? 'default' : 'outline'}>
                {eventDefinition.matcherKind === 'fileNames'
                  ? '文件名列表'
                  : t(`hooks.matcher.detected.${nativeMatcherMode}`, { defaultValue: nativeMatcherMode })}
              </Badge>
            ) : <Badge variant="outline">该事件不支持 Matcher</Badge>}
          >
            <div className="max-w-3xl space-y-2">
              <div className="text-xs text-muted-foreground">
                {eventDefinition?.matcherField
                  ? t(`hooks.matcherFields.${eventDefinition.matcherField}`, { defaultValue: eventDefinition.matcherField })
                  : '当前事件回调'}
              </div>
              <Input
                value={matcherValue}
                disabled={!eventDefinition?.matcherField}
                onChange={(event) => {
                  if (!eventDefinition?.matcherField) return;
                  const value = event.target.value;
                  const detected = inferNativeMatcherMode(hook.eventName, value);
                  updateDraft({ matcher: value ? {
                    mode: eventDefinition.matcherKind === 'fileNames' || detected !== 'regex' ? 'exact' : 'regex',
                    value,
                  } : {} });
                }}
                placeholder={!eventDefinition?.matcherField
                  ? 'Claude Code 会在每次该事件发生时回调'
                  : eventDefinition.matcherKind === 'fileNames'
                    ? '例如 .envrc|.env'
                    : '例如 Bash|Read 或 mcp__database__.*；留空匹配全部'}
                className={cn('h-11 rounded-xl font-mono', matcherRegexError && 'border-destructive')}
                aria-invalid={matcherRegexError}
              />
              {matcherRegexError ? (
                <div className="flex items-center gap-2 text-xs text-destructive">
                  <CircleAlert className="h-3.5 w-3.5" />
                  {t('hooks.matcher.invalidRegex')}
                </div>
              ) : null}
            </div>
          </Section>

          <Section
            number={3}
            title="高级脚本（可选）"
            description="脚本用于文件处理、环境读取和自定义计算；结构化记录请使用后置行为中的“记录数据”。"
            action={hook.extensionLogic ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => updateDraft({ extensionLogic: null })}>
                关闭脚本
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => updateDraft({ extensionLogic: {
                  language: 'javascript',
                  outputs: [],
                  code: buildTemplate(hook.eventName, 'javascript', []),
                } })}
              >
                <Code2 className="h-4 w-4" />
                启用脚本
              </Button>
            )}
          >
            {hook.extensionLogic ? (
              <div className="space-y-4">
                <ScriptOutputsEditor
                  outputs={hook.extensionLogic.outputs}
                  onChange={(outputs) => updateDraft({ extensionLogic: { ...hook.extensionLogic!, outputs } })}
                />
                <div className="grid overflow-hidden rounded-xl border border-border xl:grid-cols-[minmax(0,1fr)_300px]">
                  <div className="min-w-0 bg-slate-950">
                    <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-xs text-slate-300">
                      {language === 'javascript' ? <FileCode2 className="h-4 w-4 text-yellow-300" /> : <TerminalSquare className="h-4 w-4 text-sky-300" />}
                      <span>{language === 'javascript' ? 'hook.js' : 'hook.py'}</span>
                      <div className="ml-auto flex items-center gap-1">
                        {(['javascript', 'python'] as HookScriptLanguage[]).map((item) => (
                          <button
                            key={item}
                            type="button"
                            onClick={() => updateDraft({ extensionLogic: {
                              language: item,
                              outputs: hook.extensionLogic!.outputs,
                              code: buildTemplate(hook.eventName, item, hook.extensionLogic!.outputs),
                            } })}
                            className={cn(
                              'rounded px-2 py-1 text-[10px]',
                              language === item ? 'bg-white/15 text-white' : 'text-slate-400 hover:text-white',
                            )}
                          >
                            {item === 'javascript' ? 'JavaScript' : 'Python'}
                          </button>
                        ))}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 text-slate-300 hover:bg-white/10 hover:text-white"
                          onClick={() => updateDraft({ extensionLogic: {
                            ...hook.extensionLogic!,
                            code: buildTemplate(hook.eventName, language, hook.extensionLogic!.outputs),
                          } })}
                        >
                          <RefreshCcw className="h-3.5 w-3.5" />
                          重新生成模板
                        </Button>
                      </div>
                    </div>
                    <textarea
                      value={hook.extensionLogic.code}
                      onChange={(event) => updateDraft({ extensionLogic: { ...hook.extensionLogic!, code: event.target.value } })}
                      spellCheck={false}
                      className="min-h-[500px] w-full resize-y border-0 bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100 outline-none"
                    />
                  </div>
                  <aside className="max-h-[600px] space-y-4 overflow-y-auto border-t border-border bg-muted/10 p-4 xl:border-l xl:border-t-0">
                    <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                      <Braces className="h-3.5 w-3.5 text-primary" />
                      Claude 回调参数
                    </div>
                    <div className="space-y-1.5">
                      {inputs.map((field) => (
                        <div key={field.path} className="rounded-lg border border-border/70 bg-background px-2.5 py-2">
                          <code className="block truncate text-[11px] text-foreground">{field.path}</code>
                          <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{fieldLabel(t, field)} · {field.type}</span>
                        </div>
                      ))}
                    </div>
                  </aside>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs leading-5 text-muted-foreground">
                高级脚本不是必填。需要读取文件、读取运行环境或执行自定义计算时再启用。
              </div>
            )}

            <div className="mt-4 overflow-hidden rounded-xl border border-border bg-muted/10">
              <button
                type="button"
                aria-expanded={scriptReferencesOpen}
                onClick={() => setScriptReferencesOpen((current) => !current)}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs font-medium text-foreground hover:bg-muted/30"
              >
                <Braces className="h-3.5 w-3.5 text-primary" />
                <span>脚本可用 API 与固定变量</span>
                <Badge variant="outline" className="ml-1">{scriptApis.length + scriptEnvironmentVariables.length}</Badge>
                <span className="ml-auto text-[10px] text-muted-foreground">按需展开</span>
                <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', scriptReferencesOpen && 'rotate-180')} />
              </button>
              {scriptReferencesOpen ? (
                <div className="grid gap-2 border-t border-border p-3 sm:grid-cols-2 xl:grid-cols-3">
                  {scriptApis.map((api) => (
                    <div key={api.javascript} className="rounded-lg border border-border/70 bg-background px-2.5 py-2">
                      <code className="block break-all text-[11px] font-semibold text-foreground">{scriptApiName(api, language)}</code>
                      <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{api.description}</p>
                    </div>
                  ))}
                  {scriptEnvironmentVariables.map((variable) => (
                    <div key={variable.path} className="rounded-lg border border-border/70 bg-background px-2.5 py-2">
                      <code className="block break-all text-[11px] font-semibold text-foreground">
                        {language === 'python' ? pythonEnvironmentPath(variable.path) : variable.path}
                      </code>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {t(`hooks.variables.${variable.path.replace('ccui.env.', '')}`, { defaultValue: variable.type })} · {variable.type}
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </Section>

          <Section
            number={4}
            title="Hook 后置行为"
            description="高级脚本完成后按顺序记录数据或调用 MCP 工具；回答正常或异常结束时还可以调用 Skill，或直接向 Agent 发送下一回合消息。"
          >
            <PostActionsEditor
              hook={hook}
              resources={resources}
              references={references}
              onChange={(postActions) => updateDraft({
                postActions,
                ...(postActions.some((action) => action.type === 'mcp_loop_run')
                  ? { claudeResponse: { bindings: {} } }
                  : {}),
              })}
            />
          </Section>

          <Section
            number={5}
            title="返回给 Claude"
            description={hasMcpLoop
              ? '循环调用 MCP 会接管当前工具结果，普通 Hook 返回字段已停用。'
              : '只有这里配置的字段才会组装为 HookJSONOutput；脚本和行为输出不会自动返回。'}
          >
            {hasMcpLoop ? (
              <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm leading-6 text-muted-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <p>
                  循环行为将自动暂停 Agent，并在结束后使用最后一次 MCP 返回结果替换原工具输出，无需配置返回字段。
                </p>
              </div>
            ) : (
              <ClaudeResponseEditor
                hook={hook}
                references={references}
                onChange={(bindings) => updateDraft({ claudeResponse: { bindings } })}
              />
            )}
          </Section>

        </div>
      </div>
      <Dialog open={discardDialogOpen} onOpenChange={setDiscardDialogOpen}>
        <DialogContent className="max-w-md p-5">
          <DialogTitle>{t('hooks.unsaved.title')}</DialogTitle>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{t('hooks.unsaved.description')}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setDiscardDialogOpen(false)}>
              {t('hooks.unsaved.continueEditing')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setDiscardDialogOpen(false);
                onBack();
              }}
            >
              {t('hooks.unsaved.discard')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
