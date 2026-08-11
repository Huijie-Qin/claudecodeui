import {
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Braces,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Code2,
  Database,
  Filter,
  Info,
  Plus,
  Power,
  PowerOff,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';
import { Badge, Button, Card, Input, Tooltip } from '../../../shared/view/ui';

import {
  ACTION_TYPES,
  EVENT_BY_NAME,
  actionAvailability,
  buildFieldChoices,
  buildScriptTemplate,
  findMatchedTool,
  getToolTargetFields,
  inferScriptOutputs,
  isConcreteToolMatcher,
  TOOL_EVENTS,
} from './catalog';
import { createHookItemId } from './editorUtils';
import HookSelect, { type HookSelectOption } from './HookSelect';
import type {
  FieldChoice,
  FieldType,
  HookAction,
  HookActionType,
  HookCondition,
  HookConditionOperator,
  HookConfig,
  HookConfigDraft,
  HookEventName,
  HookResources,
  JsonSchemaProperty,
} from './types';

type HookConfigEditorProps = {
  hook: HookConfigDraft | HookConfig;
  visibleEvents: HookEventName[];
  resources: HookResources;
  busy: boolean;
  onChange: (hook: HookConfigDraft | HookConfig) => void;
  onBack: () => void;
  onSave: () => void;
  onPublish: () => void;
  onStart: () => void;
  onStop: () => void;
  onManageEvents: () => void;
};

type Translator = ReturnType<typeof useTranslation>['t'];

function getFieldLabel(t: Translator, field: FieldChoice) {
  if (field.label) return field.label;
  if (field.labelKey) return t(field.labelKey, { defaultValue: field.path });
  return field.path;
}

function getFieldGroup(t: Translator, field: FieldChoice) {
  return t(`hooks.fieldGroups.${field.group}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function fieldTypeForPath(fields: FieldChoice[], path: string): FieldType {
  return fields.find((field) => field.path === path)?.type || 'string';
}

function defaultOperator(type: FieldType): HookConditionOperator {
  if (type === 'boolean') return 'is_true';
  if (type === 'number') return 'equals';
  if (type === 'object' || type === 'array') return 'is_not_empty';
  return 'contains';
}

function operatorOptions(t: Translator, type: FieldType): HookSelectOption[] {
  const byType: Record<FieldType, HookConditionOperator[]> = {
    string: ['contains', 'not_contains', 'equals', 'not_equals', 'starts_with', 'ends_with', 'matches_regex', 'is_empty', 'is_not_empty'],
    number: ['equals', 'not_equals', 'greater_than', 'less_than', 'is_empty', 'is_not_empty'],
    boolean: ['is_true', 'is_false'],
    object: ['is_empty', 'is_not_empty'],
    array: ['is_empty', 'is_not_empty'],
  };
  return byType[type].map((operator) => ({
    value: operator,
    label: t(`hooks.operators.${operator}`),
  }));
}

function Section({
  number,
  title,
  children,
  action,
}: {
  number: number;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card className="overflow-visible border-border/80 shadow-none">
      <div className="flex items-center gap-3 border-b border-border/70 px-4 py-3.5 sm:px-5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xs font-semibold text-primary">
          {number}
        </span>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </Card>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-6 w-11 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/15',
        checked ? 'border-primary bg-primary' : 'border-input bg-muted',
      )}
    >
      <span className={cn(
        'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
        checked ? 'translate-x-5' : 'translate-x-0',
      )} />
    </button>
  );
}

function TemplateEditor({
  value,
  onChange,
  fields,
  label,
  placeholder,
  rows = 5,
}: {
  value: string;
  onChange: (value: string) => void;
  fields: FieldChoice[];
  label: string;
  placeholder: string;
  rows?: number;
}) {
  const { t } = useTranslation('admin');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState<number | null>(null);

  const insertField = (field: FieldChoice) => {
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? value.length;
    const start = slashIndex == null ? cursor : slashIndex;
    const token = `\${${field.path.slice(1)}}`;
    const nextValue = `${value.slice(0, start)}${token}${value.slice(cursor)}`;
    onChange(nextValue);
    setPickerOpen(false);
    setSlashIndex(null);
    requestAnimationFrame(() => {
      const nextCursor = start + token.length;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const updatePicker = (nextValue: string, cursor: number) => {
    if (cursor > 0 && nextValue[cursor - 1] === '/') {
      setSlashIndex(cursor - 1);
      setPickerOpen(true);
    } else if (pickerOpen && slashIndex != null && cursor <= slashIndex) {
      setPickerOpen(false);
      setSlashIndex(null);
    }
  };

  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <div className="relative">
        <textarea
          ref={textareaRef}
          rows={rows}
          value={value}
          onChange={(event) => {
            const nextValue = event.target.value;
            onChange(nextValue);
            updatePicker(nextValue, event.target.selectionStart);
          }}
          onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === 'Escape') setPickerOpen(false);
          }}
          placeholder={placeholder}
          className="w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground shadow-sm outline-none transition focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/10"
        />
        <button
          type="button"
          className="absolute bottom-2.5 right-2.5 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground shadow-sm hover:text-foreground"
          onClick={() => {
            setSlashIndex(textareaRef.current?.selectionStart ?? value.length);
            setPickerOpen((current) => !current);
          }}
        >
          / {t('hooks.insertVariable')}
        </button>
        {pickerOpen ? (
          <div className="absolute left-2 right-2 top-full z-40 mt-1 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-xl">
            {fields.map((field) => (
              <button
                key={field.path}
                type="button"
                onClick={() => insertField(field)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-accent"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{getFieldLabel(t, field)}</span>
                <code className="shrink-0 text-[10px] text-muted-foreground">{field.path}</code>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <span className="text-[11px] text-muted-foreground">{t('hooks.slashHint')}</span>
    </label>
  );
}

function ValueInput({
  property,
  value,
  onChange,
}: {
  property?: JsonSchemaProperty;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation('admin');
  if (property?.enum?.length) {
    return (
      <HookSelect
        value={String(value ?? '')}
        options={property.enum.map((entry) => ({ value: String(entry), label: String(entry) }))}
        onChange={onChange}
        placeholder={t('hooks.selectValue')}
        ariaLabel={t('hooks.selectValue')}
      />
    );
  }
  if (property?.type === 'boolean') {
    return (
      <HookSelect
        value={String(value ?? '')}
        options={[
          { value: 'true', label: t('hooks.boolean.true') },
          { value: 'false', label: t('hooks.boolean.false') },
        ]}
        onChange={(next) => onChange(next === 'true')}
        placeholder={t('hooks.selectValue')}
        ariaLabel={t('hooks.selectValue')}
      />
    );
  }
  return (
    <Input
      value={value == null ? '' : String(value)}
      type={property?.type === 'number' || property?.type === 'integer' ? 'number' : 'text'}
      onChange={(event) => onChange(
        property?.type === 'number' || property?.type === 'integer'
          ? Number(event.target.value)
          : event.target.value,
      )}
      placeholder={property?.description || t('hooks.fixedValue')}
      className="h-10 rounded-xl"
    />
  );
}

function RecordActionEditor({
  action,
  fields,
  onConfigChange,
}: ActionEditorProps) {
  const { t } = useTranslation('admin');
  const selected = asStringArray(action.config.fields);
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {fields.map((field) => {
        const checked = selected.includes(field.path);
        return (
          <button
            key={field.path}
            type="button"
            onClick={() => onConfigChange({
              fields: checked
                ? selected.filter((path) => path !== field.path)
                : [...selected, field.path],
            })}
            className={cn(
              'flex items-start gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors',
              checked ? 'border-primary/50 bg-primary/5' : 'border-border bg-background hover:bg-muted/30',
            )}
          >
            <span className={cn(
              'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]',
              checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
            )}>{checked ? '✓' : ''}</span>
            <span className="min-w-0">
              <span className="block text-xs font-medium text-foreground">{getFieldLabel(t, field)}</span>
              <code className="mt-0.5 block truncate text-[10px] text-muted-foreground">{field.path}</code>
            </span>
          </button>
        );
      })}
    </div>
  );
}

type ActionEditorProps = {
  action: HookAction;
  fields: FieldChoice[];
  resources: HookResources;
  matcherValue?: string;
  eventName: HookEventName;
  onConfigChange: (patch: Record<string, unknown>) => void;
};

function CallToolActionEditor({ action, fields, resources, onConfigChange }: ActionEditorProps) {
  const { t } = useTranslation('admin');
  const toolName = asString(action.config.toolName);
  const tool = resources.mcpTools.find((item) => item.name === toolName);
  const inputs = asRecord(action.config.inputs);
  const properties = tool?.inputSchema?.properties || {};
  const required = new Set(tool?.inputSchema?.required || []);
  const sourceOptions: HookSelectOption[] = [
    { value: '__literal__', label: t('hooks.fixedValue'), group: t('hooks.fieldGroups.value') },
    ...fields.map((field) => ({
      value: field.path,
      label: getFieldLabel(t, field),
      description: field.path,
      group: getFieldGroup(t, field),
    })),
  ];

  const updateInput = (key: string, binding: Record<string, unknown>) => {
    onConfigChange({ inputs: { ...inputs, [key]: binding } });
  };

  return (
    <div className="space-y-4">
      <label className="block max-w-xl space-y-1.5">
        <span className="text-xs font-medium text-foreground">{t('hooks.actions.tool')}</span>
        <HookSelect
          value={toolName}
          options={resources.mcpTools.map((item) => ({
            value: item.name,
            label: `${item.serverDisplayName} · ${item.toolName}`,
            description: item.description || item.name,
          }))}
          onChange={(nextToolName) => {
            const nextTool = resources.mcpTools.find((item) => item.name === nextToolName);
            const nextInputs = Object.fromEntries(Object.entries(nextTool?.inputSchema?.properties || {}).map(([key, property]) => [
              key,
              { source: 'literal', value: property.default ?? '' },
            ]));
            onConfigChange({ toolName: nextToolName, inputs: nextInputs });
          }}
          placeholder={resources.mcpTools.length ? t('hooks.actions.selectMcpTool') : t('hooks.actions.noMcpTools')}
          ariaLabel={t('hooks.actions.selectMcpTool')}
        />
      </label>

      {tool ? (
        Object.keys(properties).length ? (
          <div className="space-y-2">
            <div className="text-xs font-medium text-foreground">{t('hooks.actions.toolInputs')}</div>
            {Object.entries(properties).map(([key, property]) => {
              const binding = asRecord(inputs[key]);
              const sourceValue = binding.source === 'reference' ? asString(binding.path) : '__literal__';
              return (
                <div key={key} className="grid gap-2 rounded-xl border border-border bg-muted/10 p-3 lg:grid-cols-[minmax(150px,0.7fr)_minmax(180px,0.9fr)_minmax(220px,1.2fr)]">
                  <div className="min-w-0 self-center">
                    <div className="truncate text-xs font-medium text-foreground">
                      {key}{required.has(key) ? <span className="ml-1 text-destructive">*</span> : null}
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground">{property.description || property.type || 'string'}</div>
                  </div>
                  <HookSelect
                    value={sourceValue}
                    options={sourceOptions}
                    onChange={(source) => updateInput(key, source === '__literal__'
                      ? { source: 'literal', value: property.default ?? '' }
                      : { source: 'reference', path: source })}
                    placeholder={t('hooks.actions.valueSource')}
                    ariaLabel={`${key} ${t('hooks.actions.valueSource')}`}
                  />
                  {sourceValue === '__literal__' ? (
                    <ValueInput
                      property={property}
                      value={binding.value}
                      onChange={(value) => updateInput(key, { source: 'literal', value })}
                    />
                  ) : (
                    <div className="flex h-10 items-center rounded-xl border border-dashed border-border px-3 text-xs text-muted-foreground">
                      <code className="truncate">{sourceValue}</code>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
            {t('hooks.actions.toolNoInputs')}
          </div>
        )
      ) : null}
    </div>
  );
}

function AppendContextActionEditor({ action, fields, onConfigChange }: ActionEditorProps) {
  const { t } = useTranslation('admin');
  return (
    <TemplateEditor
      value={asString(action.config.template)}
      onChange={(template) => onConfigChange({ template })}
      fields={fields}
      label={t('hooks.actions.contextTemplate')}
      placeholder={t('hooks.actions.contextPlaceholder')}
    />
  );
}

function RecoveryActionEditor({ action, fields, resources, onConfigChange }: ActionEditorProps) {
  const { t } = useTranslation('admin');
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-foreground">{t('hooks.actions.skill')}</span>
          <HookSelect
            value={asString(action.config.skillName)}
            options={resources.skills.map((skill) => ({
              value: skill.name,
              label: skill.displayName || skill.name,
              description: skill.description || `/${skill.name}`,
            }))}
            onChange={(skillName) => onConfigChange({ skillName })}
            placeholder={resources.skills.length ? t('hooks.actions.selectSkill') : t('hooks.actions.noSkills')}
            ariaLabel={t('hooks.actions.selectSkill')}
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-foreground">{t('hooks.actions.maxTurns')}</span>
          <HookSelect
            value={String(action.config.maxTurns || 1)}
            options={[1, 2, 3, 5].map((value) => ({ value: String(value), label: String(value) }))}
            onChange={(value) => onConfigChange({ maxTurns: Number(value) })}
            placeholder="1"
            ariaLabel={t('hooks.actions.maxTurns')}
          />
        </label>
      </div>
      <TemplateEditor
        value={asString(action.config.argumentsTemplate)}
        onChange={(argumentsTemplate) => onConfigChange({ argumentsTemplate })}
        fields={fields}
        label={t('hooks.actions.skillArguments')}
        placeholder={t('hooks.actions.skillArgumentsPlaceholder')}
      />
      <div className="rounded-xl bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <code>/{asString(action.config.skillName) || 'skill'} {asString(action.config.argumentsTemplate)}</code>
      </div>
    </div>
  );
}

function DecisionActionEditor({ action, eventName, onConfigChange }: ActionEditorProps) {
  const { t } = useTranslation('admin');
  const outcomes = eventName === 'PermissionRequest'
    ? ['allow', 'deny', 'ask']
    : eventName === 'Stop'
      ? ['continue', 'block']
      : ['continue', 'block'];
  return (
    <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
      <label className="space-y-1.5">
        <span className="text-xs font-medium text-foreground">{t('hooks.actions.decision')}</span>
        <HookSelect
          value={asString(action.config.outcome)}
          options={outcomes.map((outcome) => ({ value: outcome, label: t(`hooks.outcomes.${outcome}`) }))}
          onChange={(outcome) => onConfigChange({ outcome })}
          placeholder={t('hooks.actions.selectDecision')}
          ariaLabel={t('hooks.actions.selectDecision')}
        />
      </label>
      <label className="space-y-1.5">
        <span className="text-xs font-medium text-foreground">{t('hooks.actions.reason')}</span>
        <Input
          value={asString(action.config.reason)}
          onChange={(event) => onConfigChange({ reason: event.target.value })}
          placeholder={t('hooks.actions.reasonPlaceholder')}
          className="h-10 rounded-xl"
        />
      </label>
    </div>
  );
}

function MutationActionEditor({
  action,
  fields,
  resources,
  matcherValue,
  onConfigChange,
}: ActionEditorProps) {
  const { t } = useTranslation('admin');
  const isInput = action.type === 'update_input';
  const targets = isInput
    ? getToolTargetFields(resources, matcherValue)
    : [
        { path: 'tool_response', label: t('hooks.actions.wholeToolOutput'), description: '', type: 'object' as const },
        { path: 'tool_response.content', label: t('hooks.actions.toolTextContent'), description: 'content', type: 'string' as const },
        { path: 'tool_response.structuredContent', label: t('hooks.actions.toolStructuredContent'), description: 'structuredContent', type: 'object' as const },
      ];
  const replacement = asRecord(action.config.replacement);
  const replacementChoice = replacement.source === 'reference' ? asString(replacement.path) : '__literal__';
  const selectedTarget = targets.find((target) => target.path === action.config.targetPath);
  const sourceOptions: HookSelectOption[] = [
    { value: '__literal__', label: t('hooks.fixedValue'), group: t('hooks.fieldGroups.value') },
    ...fields.map((field) => ({
      value: field.path,
      label: getFieldLabel(t, field),
      description: field.path,
      group: getFieldGroup(t, field),
    })),
  ];

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <label className="space-y-1.5">
        <span className="text-xs font-medium text-foreground">{t('hooks.actions.fieldToChange')}</span>
        <HookSelect
          value={asString(action.config.targetPath)}
          options={targets.map((target) => ({
            value: target.path,
            label: target.label,
            description: target.description || target.path,
          }))}
          onChange={(targetPath) => onConfigChange({ targetPath })}
          placeholder={targets.length ? t('hooks.actions.selectFieldToChange') : t('hooks.actions.selectToolFirst')}
          ariaLabel={t('hooks.actions.selectFieldToChange')}
        />
      </label>
      <label className="space-y-1.5">
        <span className="text-xs font-medium text-foreground">{t('hooks.actions.changeTo')}</span>
        <HookSelect
          value={replacementChoice}
          options={sourceOptions}
          onChange={(source) => onConfigChange({
            replacement: source === '__literal__'
              ? { source: 'literal', value: '' }
              : { source: 'reference', path: source },
          })}
          placeholder={t('hooks.actions.selectNewValue')}
          ariaLabel={t('hooks.actions.selectNewValue')}
        />
      </label>
      {replacementChoice === '__literal__' ? (
        <label className="space-y-1.5 lg:col-start-2">
          <span className="text-xs font-medium text-foreground">{t('hooks.actions.newValue')}</span>
          <ValueInput
            property={{ type: selectedTarget?.type }}
            value={replacement.value}
            onChange={(value) => onConfigChange({ replacement: { source: 'literal', value } })}
          />
        </label>
      ) : null}
    </div>
  );
}

function ActionEditor(props: ActionEditorProps) {
  switch (props.action.type) {
    case 'record_data': return <RecordActionEditor {...props} />;
    case 'call_tool': return <CallToolActionEditor {...props} />;
    case 'append_context': return <AppendContextActionEditor {...props} />;
    case 'invoke_skill_recovery': return <RecoveryActionEditor {...props} />;
    case 'decision': return <DecisionActionEditor {...props} />;
    case 'update_input':
    case 'update_output': return <MutationActionEditor {...props} />;
    default: return null;
  }
}

const ACTION_ICONS: Record<HookActionType, ComponentType<{ className?: string }>> = {
  record_data: Database,
  call_tool: Wrench,
  append_context: Sparkles,
  invoke_skill_recovery: RotateCcw,
  decision: ShieldCheck,
  update_input: Filter,
  update_output: Braces,
};

function initialActionConfig(type: HookActionType): Record<string, unknown> {
  switch (type) {
    case 'record_data': return { fields: [] };
    case 'call_tool': return { toolName: '', inputs: {} };
    case 'append_context': return { template: '' };
    case 'invoke_skill_recovery': return { skillName: '', argumentsTemplate: '', maxTurns: 1 };
    case 'decision': return { outcome: '', reason: '' };
    case 'update_input':
    case 'update_output': return { targetPath: '', replacement: { source: 'literal', value: '' } };
    default: return {};
  }
}

export default function HookConfigEditor({
  hook,
  visibleEvents,
  resources,
  busy,
  onChange,
  onBack,
  onSave,
  onPublish,
  onStart,
  onStop,
  onManageEvents,
}: HookConfigEditorProps) {
  const { t } = useTranslation('admin');
  const [scriptOpen, setScriptOpen] = useState(Boolean(hook.advancedScript));
  const [expandedActions, setExpandedActions] = useState<Set<string>>(() => new Set(hook.actions.map((action) => action.id)));
  const isPersisted = 'id' in hook;
  const status = isPersisted ? hook.status : 'draft';
  const eventDefinition = EVENT_BY_NAME.get(hook.eventName);
  const fields = useMemo(() => buildFieldChoices(hook, resources), [hook, resources]);
  const gateFields = fields.filter((field) => field.gateAllowed !== false);
  const scriptInputFields = fields.filter((field) => field.group !== 'script' && field.group !== 'action');

  const updateDraft = (patch: Partial<HookConfigDraft>) => {
    onChange({ ...hook, ...patch });
  };

  const updateAction = (actionId: string, patch: Partial<HookAction>) => {
    updateDraft({
      actions: hook.actions.map((action) => action.id === actionId ? { ...action, ...patch } : action),
    });
  };

  const updateActionConfig = (actionId: string, patch: Record<string, unknown>) => {
    const action = hook.actions.find((item) => item.id === actionId);
    if (!action) return;
    updateAction(actionId, { config: { ...action.config, ...patch } });
  };

  const editorEvents = visibleEvents.includes(hook.eventName)
    ? visibleEvents
    : [hook.eventName, ...visibleEvents];
  const eventOptions = editorEvents.map((eventName) => ({
    value: eventName,
    label: t(`hooks.events.${eventName}.label`),
    description: t(`hooks.events.${eventName}.description`),
  }));

  const toolMatcherOptions: HookSelectOption[] = [
    { value: '*', label: t('hooks.matcher.allTools'), group: t('hooks.matcher.scope') },
    ...resources.builtinTools.map((tool) => ({
      value: tool.name,
      label: tool.name,
      description: tool.description,
      group: t('hooks.matcher.claudeTools'),
    })),
    ...resources.mcpTools.map((tool) => ({
      value: tool.name,
      label: `${tool.serverDisplayName} · ${tool.toolName}`,
      description: tool.name,
      group: t('hooks.matcher.mcpTools'),
    })),
  ];

  const addCondition = () => {
    const field = gateFields[0];
    if (!field) return;
    updateDraft({
      gate: {
        ...hook.gate,
        conditions: [
          ...hook.gate.conditions,
          {
            id: createHookItemId(),
            field: field.path,
            operator: defaultOperator(field.type),
            ...(!['boolean', 'object', 'array'].includes(field.type) ? { value: '' } : {}),
          },
        ],
      },
    });
  };

  const updateCondition = (id: string, patch: Partial<HookCondition>) => {
    updateDraft({
      gate: {
        ...hook.gate,
        conditions: hook.gate.conditions.map((condition) => (
          condition.id === id ? { ...condition, ...patch } : condition
        )),
      },
    });
  };

  const addAction = (type: HookActionType) => {
    const action: HookAction = {
      id: createHookItemId(),
      type,
      config: initialActionConfig(type),
    };
    updateDraft({ actions: [...hook.actions, action] });
    setExpandedActions((current) => new Set([...current, action.id]));
  };

  const moveAction = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= hook.actions.length) return;
    const actions = [...hook.actions];
    [actions[index], actions[target]] = [actions[target], actions[index]];
    updateDraft({ actions });
  };

  const matcherMode = hook.matcher.mode || 'exact';
  const matchedTool = findMatchedTool(resources, hook.matcher.value, matcherMode);
  const matcherRegexError = useMemo(() => {
    if (matcherMode !== 'regex' || !hook.matcher.value) return false;
    try {
      new RegExp(hook.matcher.value);
      return false;
    } catch {
      return true;
    }
  }, [hook.matcher.value, matcherMode]);
  const scriptOutputs = hook.advancedScript?.outputs || [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/10">
      <div className="sticky top-0 z-20 flex shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 py-2.5 backdrop-blur sm:px-5">
        <Button type="button" variant="ghost" size="sm" onClick={onBack} className="px-2">
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">{t('hooks.backToList')}</span>
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">
            {hook.name || t('hooks.newHook')}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {t(`statuses.${status}`)}{isPersisted && hook.version > 0 ? ` · v${hook.version}` : ''}
          </div>
        </div>
        {isPersisted && status === 'published' && hook.globalEnabled ? (
          <Button type="button" variant="outline" size="sm" onClick={onStop} disabled={busy}>
            <PowerOff className="h-4 w-4" />
            {t('hooks.stop')}
          </Button>
        ) : null}
        {isPersisted && status === 'published' && !hook.globalEnabled ? (
          <Button type="button" variant="outline" size="sm" onClick={onStart} disabled={busy}>
            <Power className="h-4 w-4" />
            {t('hooks.start')}
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={onSave} disabled={busy || !hook.name.trim() || matcherRegexError}>
          <Save className="h-4 w-4" />
          <span className="hidden sm:inline">{t('hooks.saveDraft')}</span>
        </Button>
        <Button type="button" size="sm" onClick={onPublish} disabled={busy || !hook.name.trim() || matcherRegexError}>
          {t('hooks.publish')}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-4 px-3 py-4 sm:px-5 sm:py-5">
          <Section number={1} title={t('hooks.sections.basic')}>
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
                    <Tooltip
                      content={t(`hooks.events.${hook.eventName}.description`)}
                      position="top"
                      delay={150}
                      className="max-w-xs whitespace-normal px-3 py-2 text-left font-normal leading-5"
                    >
                      <button
                        type="button"
                        className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary focus-visible:bg-primary/10 focus-visible:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                        aria-label={t(`hooks.events.${hook.eventName}.description`)}
                      >
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
                    const actions = hook.actions.filter((action) => actionAvailability(eventName, undefined, action.type).available);
                    updateDraft({ eventName, matcher: {}, gate: { mode: 'all', conditions: [] }, actions });
                  }}
                  placeholder={t('hooks.selectEvent')}
                  ariaLabel={t('hooks.selectEvent')}
                />
              </div>
              <label className="block space-y-1.5 lg:col-span-2">
                <span className="text-xs font-medium text-foreground">{t('hooks.fields.description')}</span>
                <textarea
                  rows={3}
                  value={hook.description}
                  onChange={(event) => updateDraft({ description: event.target.value })}
                  placeholder={t('hooks.fields.descriptionPlaceholder')}
                  className="min-h-[82px] w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground shadow-sm outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/10"
                  maxLength={1000}
                />
              </label>
            </div>
          </Section>

          <Section number={2} title={t('hooks.sections.matcher')}>
            {TOOL_EVENTS.has(hook.eventName) ? (
              <div className="space-y-2">
                <div className="grid max-w-3xl gap-2 sm:grid-cols-[160px_minmax(0,1fr)]">
                  <HookSelect
                    value={matcherMode}
                    options={[
                      { value: 'exact', label: t('hooks.matcher.exact') },
                      { value: 'regex', label: t('hooks.matcher.regex') },
                    ]}
                    onChange={(value) => {
                      const mode = value as 'exact' | 'regex';
                      const actions = hook.actions.filter((action) => actionAvailability(
                        hook.eventName,
                        undefined,
                        action.type,
                        mode,
                      ).available);
                      updateDraft({ matcher: { mode }, gate: { mode: 'all', conditions: [] }, actions });
                    }}
                    placeholder={t('hooks.matcher.mode')}
                    ariaLabel={t('hooks.matcher.mode')}
                  />
                  {matcherMode === 'exact' ? (
                    <HookSelect
                      value={hook.matcher.value || ''}
                      options={toolMatcherOptions}
                      onChange={(value) => {
                        const actions = hook.actions.filter((action) => actionAvailability(
                          hook.eventName,
                          value,
                          action.type,
                          'exact',
                        ).available);
                        updateDraft({ matcher: { mode: 'exact', value }, gate: { mode: 'all', conditions: [] }, actions });
                      }}
                      placeholder={t('hooks.matcher.selectTool')}
                      ariaLabel={t('hooks.matcher.selectTool')}
                      menuClassName="sm:min-w-[520px]"
                    />
                  ) : (
                    <Input
                      value={hook.matcher.value || ''}
                      onChange={(event) => updateDraft({ matcher: { mode: 'regex', value: event.target.value } })}
                      placeholder={t('hooks.matcher.regexPlaceholder')}
                      className={cn('h-10 rounded-xl font-mono', matcherRegexError && 'border-destructive')}
                      aria-invalid={matcherRegexError}
                    />
                  )}
                </div>
                {matcherRegexError ? (
                  <div className="flex items-center gap-2 text-xs text-destructive">
                    <CircleAlert className="h-3.5 w-3.5" />
                    {t('hooks.matcher.invalidRegex')}
                  </div>
                ) : null}
                {matcherMode === 'exact' && !isConcreteToolMatcher(hook.matcher.value, matcherMode) ? (
                  <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
                    <CircleAlert className="h-3.5 w-3.5" />
                    {t('hooks.matcher.specificToolHint')}
                  </div>
                ) : matchedTool ? (
                  <div className="text-xs text-muted-foreground">{matchedTool.description}</div>
                ) : null}
              </div>
            ) : eventDefinition?.matcherField ? (
              <div className="max-w-3xl space-y-1.5">
                <label htmlFor="hook-matcher" className="text-xs font-medium text-foreground">
                  {t(`hooks.matcherFields.${eventDefinition.matcherField}`, { defaultValue: eventDefinition.matcherField })}
                </label>
                <div className="grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)]">
                  <HookSelect
                    value={matcherMode}
                    options={[
                      { value: 'exact', label: t('hooks.matcher.exact') },
                      { value: 'regex', label: t('hooks.matcher.regex') },
                    ]}
                    onChange={(value) => updateDraft({ matcher: { mode: value as 'exact' | 'regex' } })}
                    placeholder={t('hooks.matcher.mode')}
                    ariaLabel={t('hooks.matcher.mode')}
                  />
                  <Input
                    id="hook-matcher"
                    value={hook.matcher.value || ''}
                    onChange={(event) => updateDraft({ matcher: {
                      mode: matcherMode,
                      ...(event.target.value ? { value: event.target.value } : {}),
                    } })}
                    placeholder={matcherMode === 'regex' ? t('hooks.matcher.regexPlaceholder') : t('hooks.matcher.optional')}
                    className={cn('h-10 rounded-xl', matcherMode === 'regex' && 'font-mono', matcherRegexError && 'border-destructive')}
                    aria-invalid={matcherRegexError}
                  />
                </div>
                {matcherRegexError ? <div className="text-xs text-destructive">{t('hooks.matcher.invalidRegex')}</div> : null}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">{t('hooks.matcher.notNeeded')}</div>
            )}
          </Section>

          <Section
            number={3}
            title={t('hooks.sections.script')}
            action={(
              <Toggle
                checked={Boolean(hook.advancedScript)}
                label={t('hooks.script.enable')}
                onChange={(enabled) => {
                  if (enabled) {
                    const code = buildScriptTemplate({
                      eventName: hook.eventName,
                      eventLabel: t(`hooks.events.${hook.eventName}.label`),
                      eventDescription: t(`hooks.events.${hook.eventName}.description`),
                      inputs: scriptInputFields.map((field) => ({
                        path: field.path,
                        label: getFieldLabel(t, field),
                        type: field.type,
                      })),
                    });
                    updateDraft({ advancedScript: { enabled: true, language: 'javascript', code, outputs: inferScriptOutputs(code) } });
                    setScriptOpen(true);
                  } else {
                    updateDraft({ advancedScript: null, gate: {
                      ...hook.gate,
                      conditions: hook.gate.conditions.filter((condition) => !condition.field.startsWith('$script.output.')),
                    } });
                  }
                }}
              />
            )}
          >
            {hook.advancedScript ? (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => setScriptOpen((current) => !current)}
                  className="flex w-full items-center gap-2 rounded-xl bg-muted/30 px-3 py-2 text-left text-xs font-medium text-foreground"
                >
                  {scriptOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  <Code2 className="h-4 w-4 text-primary" />
                  JavaScript
                  <Badge variant="outline" className="ml-auto">{t('hooks.script.outputsCount', { count: scriptOutputs.length })}</Badge>
                </button>
                {scriptOpen ? (
                  <div className="grid overflow-hidden rounded-xl border border-border lg:grid-cols-[minmax(0,1fr)_280px]">
                    <textarea
                      value={hook.advancedScript.code}
                      onChange={(event) => {
                        const code = event.target.value;
                        updateDraft({ advancedScript: {
                          enabled: true,
                          language: 'javascript',
                          code,
                          outputs: inferScriptOutputs(code),
                        } });
                      }}
                      spellCheck={false}
                      className="min-h-[320px] resize-y border-0 bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100 outline-none"
                    />
                    <div className="max-h-[520px] space-y-4 overflow-y-auto border-t border-border bg-muted/10 p-3 lg:border-l lg:border-t-0">
                      <div>
                        <div className="text-xs font-semibold text-foreground">{t('hooks.script.availableInputs')}</div>
                        <div className="mt-2 space-y-1.5">
                          <div className="rounded bg-background px-2 py-1 text-[10px] text-muted-foreground">
                            <div className="truncate text-foreground">{t('hooks.script.workspaceFiles')}</div>
                            <code className="block truncate">workspace</code>
                          </div>
                          {scriptInputFields.map((field) => (
                            <div key={field.path} className="rounded bg-background px-2 py-1 text-[10px] text-muted-foreground">
                              <div className="truncate text-foreground">{getFieldLabel(t, field)}</div>
                              <code className="block truncate">{field.path}</code>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-foreground">{t('hooks.script.returnFields')}</div>
                        <div className="mt-2 space-y-1.5">
                          {scriptOutputs.length ? scriptOutputs.map((output) => (
                            <div key={output.name} className="rounded-lg border border-border bg-background px-2.5 py-2">
                              <code className="text-[11px] text-primary">$script.output.{output.name}</code>
                              <div className="mt-0.5 text-[10px] text-muted-foreground">{output.type} · {output.description}</div>
                            </div>
                          )) : <div className="text-xs text-muted-foreground">{t('hooks.script.noOutputs')}</div>}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">{t('hooks.script.optional')}</div>
            )}
          </Section>

          <Section
            number={4}
            title={t('hooks.sections.gate')}
            action={(
              <Button type="button" variant="outline" size="sm" onClick={addCondition} disabled={!gateFields.length}>
                <Plus className="h-4 w-4" />
                {t('hooks.gate.add')}
              </Button>
            )}
          >
            {hook.gate.conditions.length ? (
              <div className="space-y-3">
                {hook.gate.conditions.length > 1 ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{t('hooks.gate.mode')}</span>
                    <HookSelect
                      value={hook.gate.mode}
                      options={[
                        { value: 'all', label: t('hooks.gate.all') },
                        { value: 'any', label: t('hooks.gate.any') },
                      ]}
                      onChange={(mode) => updateDraft({ gate: { ...hook.gate, mode: mode as 'all' | 'any' } })}
                      placeholder={t('hooks.gate.mode')}
                      ariaLabel={t('hooks.gate.mode')}
                      className="w-44"
                    />
                  </div>
                ) : null}
                {hook.gate.conditions.map((condition) => {
                  const type = fieldTypeForPath(gateFields, condition.field);
                  const field = gateFields.find((item) => item.path === condition.field);
                  const needsValue = !['is_true', 'is_false', 'is_empty', 'is_not_empty'].includes(condition.operator);
                  return (
                    <div key={condition.id} className="grid gap-2 rounded-xl border border-border bg-muted/10 p-3 lg:grid-cols-[minmax(200px,1.2fr)_minmax(150px,0.8fr)_minmax(180px,1fr)_40px]">
                      <HookSelect
                        value={condition.field}
                        options={gateFields.map((choice) => ({
                          value: choice.path,
                          label: getFieldLabel(t, choice),
                          description: choice.path,
                          group: getFieldGroup(t, choice),
                        }))}
                        onChange={(path) => {
                          const nextType = fieldTypeForPath(gateFields, path);
                          const operator = defaultOperator(nextType);
                          updateCondition(condition.id, {
                            field: path,
                            operator,
                            ...(['boolean', 'object', 'array'].includes(nextType) ? { value: undefined } : { value: '' }),
                          });
                        }}
                        placeholder={t('hooks.gate.field')}
                        ariaLabel={t('hooks.gate.field')}
                      />
                      <HookSelect
                        value={condition.operator}
                        options={operatorOptions(t, type)}
                        onChange={(operator) => updateCondition(condition.id, {
                          operator: operator as HookConditionOperator,
                          ...(['is_true', 'is_false', 'is_empty', 'is_not_empty'].includes(operator) ? { value: undefined } : {}),
                        })}
                        placeholder={t('hooks.gate.operator')}
                        ariaLabel={t('hooks.gate.operator')}
                      />
                      {needsValue ? (
                        field?.options?.length ? (
                          <HookSelect
                            value={String(condition.value ?? '')}
                            options={field.options}
                            onChange={(value) => updateCondition(condition.id, { value })}
                            placeholder={t('hooks.gate.value')}
                            ariaLabel={t('hooks.gate.value')}
                          />
                        ) : (
                          <Input
                            value={condition.value == null ? '' : String(condition.value)}
                            type={type === 'number' ? 'number' : 'text'}
                            onChange={(event) => updateCondition(condition.id, {
                              value: type === 'number' ? Number(event.target.value) : event.target.value,
                            })}
                            placeholder={t('hooks.gate.value')}
                            className="h-10 rounded-xl"
                          />
                        )
                      ) : <div className="hidden lg:block" />}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => updateDraft({ gate: { ...hook.gate, conditions: hook.gate.conditions.filter((item) => item.id !== condition.id) } })}
                        aria-label={t('hooks.gate.remove')}
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
                {t('hooks.gate.always')}
              </div>
            )}
          </Section>

          <Section number={5} title={t('hooks.sections.actions')}>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {ACTION_TYPES.map((type) => {
                const Icon = ACTION_ICONS[type];
                const availability = actionAvailability(hook.eventName, hook.matcher.value, type, matcherMode);
                if (!availability.available && !availability.reasonKey) return null;
                return (
                  <button
                    key={type}
                    type="button"
                    disabled={!availability.available}
                    onClick={() => addAction(type)}
                    className={cn(
                      'rounded-xl border border-border bg-background p-3 text-left transition hover:border-primary/40 hover:bg-primary/[0.03]',
                      !availability.available && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span>
                      <span className="text-xs font-semibold text-foreground">{t(`hooks.actions.types.${type}.label`)}</span>
                      <Plus className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div className="mt-2 text-[11px] leading-4 text-muted-foreground">
                      {availability.reasonKey ? t(availability.reasonKey) : t(`hooks.actions.types.${type}.description`)}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="mt-5 space-y-3">
              {hook.actions.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                  {t('hooks.actions.empty')}
                </div>
              ) : hook.actions.map((action, index) => {
                const Icon = ACTION_ICONS[action.type];
                const expanded = expandedActions.has(action.id);
                const actionFields = fields.filter((field) => {
                  if (field.group !== 'action') return true;
                  const outputIndex = Number(field.path.match(/^\$actions\.(\d+)\./)?.[1]);
                  return Number.isInteger(outputIndex) && outputIndex < index;
                });
                return (
                  <div key={action.id} className="overflow-visible rounded-xl border border-border bg-background">
                    <div className="flex items-center gap-2 px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => setExpandedActions((current) => {
                          const next = new Set(current);
                          if (next.has(action.id)) next.delete(action.id); else next.add(action.id);
                          return next;
                        })}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon className="h-3.5 w-3.5" /></span>
                        <span className="truncate text-xs font-semibold text-foreground">{index + 1}. {t(`hooks.actions.types.${action.type}.label`)}</span>
                      </button>
                      <Button type="button" variant="ghost" size="icon" disabled={index === 0} onClick={() => moveAction(index, -1)} aria-label={t('hooks.actions.moveUp')}>
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" disabled={index === hook.actions.length - 1} onClick={() => moveAction(index, 1)} aria-label={t('hooks.actions.moveDown')}>
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" onClick={() => updateDraft({ actions: hook.actions.filter((item) => item.id !== action.id) })} aria-label={t('hooks.actions.remove')}>
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </div>
                    {expanded ? (
                      <div className="border-t border-border bg-muted/[0.06] p-3 sm:p-4">
                        <ActionEditor
                          action={action}
                          fields={actionFields}
                          resources={resources}
                          matcherValue={hook.matcher.value}
                          eventName={hook.eventName}
                          onConfigChange={(patch) => updateActionConfig(action.id, patch)}
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
