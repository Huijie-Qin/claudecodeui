import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, Dispatch, KeyboardEvent, SetStateAction } from 'react';
import ReactDOM from 'react-dom';
import { AlertTriangle, CalendarClock, ChevronDown, ChevronRight, Edit2, Loader2, MessageSquare, Pause, Play, Repeat2, Save, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../../utils/api';
import type { LLMProvider, Project } from '../../../../types/app';
import { Button, Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import { type MentionableFile, useFileMentions } from '../../hooks/useFileMentions';
import { type SlashCommand, useSlashCommands } from '../../hooks/useSlashCommands';
import { isSkillSlashCommand } from '../../hooks/useSlashCommands.utils';

import CommandMenu from './CommandMenu';

type ScheduledTask = {
  id: number;
  provider: LLMProvider;
  name: string;
  prompt: string;
  scheduleType?: ScheduleType;
  scheduleCron?: string | null;
  intervalMinutes: number;
  scheduleStartAt?: string | null;
  nextRunAt: string;
  enabled: boolean;
  model?: string | null;
  permissionMode?: string | null;
  lastRunAt?: string | null;
  lastSessionId?: string | null;
  sessionMode?: 'new' | 'merge';
  lastError?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type ScheduleType = 'interval' | 'cron';
type ScheduleMode = 'interval' | 'cron' | 'visual';
type ScheduledTasksDialogMode = 'create' | 'manage';
type VisualFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

type TaskEditForm = {
  name: string;
  prompt: string;
  scheduleMode: ScheduleMode;
  scheduleCron: string;
  visualFrequency: VisualFrequency;
  visualMinute: number;
  visualHour: number;
  visualWeekday: number;
  visualMonthDay: number;
  intervalMinutes: number;
  nextRunAt: string;
  enabled: boolean;
  sessionMode: 'new' | 'merge';
};

type ScheduledTasksDialogProps = {
  open: boolean;
  selectedProject: Project;
  provider: LLMProvider;
  model?: string;
  permissionMode?: string;
  initialPrompt?: string;
  initialTaskId?: number | null;
  selectedSessionId?: string | null;
  selectedSessionName?: string | null;
  mode?: ScheduledTasksDialogMode;
  onClose: () => void;
};

type ErrorPayload = {
  error?: string;
  message?: string;
};

type TranslationFunction = ReturnType<typeof useTranslation>['t'];

type ScheduleControlValues = Pick<
  TaskEditForm,
  | 'scheduleMode'
  | 'scheduleCron'
  | 'visualFrequency'
  | 'visualMinute'
  | 'visualHour'
  | 'visualWeekday'
  | 'visualMonthDay'
  | 'intervalMinutes'
  | 'nextRunAt'
>;

const WEEKDAYS = [
  { value: 1, labelKey: 'scheduledTasks.weekdays.mon', defaultLabel: 'Mon' },
  { value: 2, labelKey: 'scheduledTasks.weekdays.tue', defaultLabel: 'Tue' },
  { value: 3, labelKey: 'scheduledTasks.weekdays.wed', defaultLabel: 'Wed' },
  { value: 4, labelKey: 'scheduledTasks.weekdays.thu', defaultLabel: 'Thu' },
  { value: 5, labelKey: 'scheduledTasks.weekdays.fri', defaultLabel: 'Fri' },
  { value: 6, labelKey: 'scheduledTasks.weekdays.sat', defaultLabel: 'Sat' },
  { value: 0, labelKey: 'scheduledTasks.weekdays.sun', defaultLabel: 'Sun' },
];

const VISUAL_FREQUENCIES: Array<{ value: VisualFrequency; labelKey: string; defaultLabel: string }> = [
  { value: 'monthly', labelKey: 'scheduledTasks.frequencies.monthly', defaultLabel: 'Monthly' },
  { value: 'weekly', labelKey: 'scheduledTasks.frequencies.weekly', defaultLabel: 'Weekly' },
  { value: 'daily', labelKey: 'scheduledTasks.frequencies.daily', defaultLabel: 'Daily' },
  { value: 'hourly', labelKey: 'scheduledTasks.frequencies.hourly', defaultLabel: 'Hourly' },
];

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function toLocalInputValue(value?: string | null) {
  const date = value ? new Date(value) : new Date(Date.now() + 60 * 60_000);
  if (Number.isNaN(date.getTime())) {
    return toLocalInputValue(null);
  }
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeCronInput(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function isValidCronCandidate(value: string) {
  const fields = normalizeCronInput(value).split(/\s+/);
  return fields.length === 5 && fields.every(Boolean);
}

function buildVisualCron({
  visualFrequency,
  visualMinute,
  visualHour,
  visualWeekday,
  visualMonthDay,
}: Pick<TaskEditForm, 'visualFrequency' | 'visualMinute' | 'visualHour' | 'visualWeekday' | 'visualMonthDay'>) {
  const minute = clampNumber(visualMinute, 0, 59);
  const hour = clampNumber(visualHour, 0, 23);
  const weekday = clampNumber(visualWeekday, 0, 6);
  const monthDay = clampNumber(visualMonthDay, 1, 31);

  if (visualFrequency === 'hourly') return `${minute} * * * *`;
  if (visualFrequency === 'daily') return `${minute} ${hour} * * *`;
  if (visualFrequency === 'weekly') return `${minute} ${hour} * * ${weekday}`;
  return `${minute} ${hour} ${monthDay} * *`;
}

const CRON_FIELD_CONFIGS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7, normalize: (value: number) => (value === 7 ? 0 : value) },
];

const MAX_PREVIEW_SEARCH_MINUTES = 366 * 24 * 60 * 2;

type CronFieldConfig = {
  name: string;
  min: number;
  max: number;
  normalize?: (value: number) => number;
};

function requireCronInteger(value: string, fieldName: string) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${fieldName} must be an integer`);
  }
  return Number(value);
}

function normalizeCronFieldValue(value: number, config: CronFieldConfig) {
  if (value < config.min || value > config.max) {
    throw new Error(`${config.name} must be between ${config.min} and ${config.max}`);
  }
  return config.normalize ? config.normalize(value) : value;
}

function parseCronField(field: string, config: CronFieldConfig) {
  const raw = String(field || '').trim();
  if (!raw) {
    throw new Error(`${config.name} is required`);
  }

  const values = new Set<number>();
  const parts = raw.split(',');
  let isWildcard = false;

  for (const part of parts) {
    const slashParts = part.split('/');
    const [rangePart, stepPart] = slashParts;
    if (slashParts.length > 2) {
      throw new Error(`${config.name} has an invalid step`);
    }

    const step = stepPart === undefined ? 1 : requireCronInteger(stepPart, config.name);
    if (step <= 0) {
      throw new Error(`${config.name} step must be greater than 0`);
    }

    let start;
    let end;
    if (rangePart === '*') {
      isWildcard = parts.length === 1;
      start = config.min;
      end = config.max;
    } else if (rangePart.includes('-')) {
      const rangeParts = rangePart.split('-');
      const [startPart, endPart] = rangeParts;
      if (!startPart || !endPart || rangeParts.length > 2) {
        throw new Error(`${config.name} has an invalid range`);
      }
      start = requireCronInteger(startPart, config.name);
      end = requireCronInteger(endPart, config.name);
    } else {
      start = requireCronInteger(rangePart, config.name);
      end = start;
    }

    if (start > end) {
      throw new Error(`${config.name} range start must be before range end`);
    }

    for (let value = start; value <= end; value += step) {
      values.add(normalizeCronFieldValue(value, config));
    }
  }

  return { values, isWildcard };
}

function parseCronExpression(expression: string) {
  const fields = normalizeCronInput(expression).split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('Cron expression must have 5 fields');
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((field, index) =>
    parseCronField(field, CRON_FIELD_CONFIGS[index]));

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
  };
}

function cronMatchesDate(parsed: ReturnType<typeof parseCronExpression>, date: Date) {
  const minuteMatches = parsed.minute.values.has(date.getMinutes());
  const hourMatches = parsed.hour.values.has(date.getHours());
  const monthMatches = parsed.month.values.has(date.getMonth() + 1);
  const dayOfMonthMatches = parsed.dayOfMonth.values.has(date.getDate());
  const dayOfWeekMatches = parsed.dayOfWeek.values.has(date.getDay());

  const dayMatches =
    parsed.dayOfMonth.isWildcard || parsed.dayOfWeek.isWildcard
      ? dayOfMonthMatches && dayOfWeekMatches
      : dayOfMonthMatches || dayOfWeekMatches;

  return minuteMatches && hourMatches && monthMatches && dayMatches;
}

function getNextCronRunDates(
  expression: string,
  fromDate: Date,
  count = 5,
  { inclusive = false } = {},
) {
  const parsed = parseCronExpression(expression);
  if (Number.isNaN(fromDate.getTime())) {
    return [];
  }

  const runs: Date[] = [];
  const candidate = new Date(fromDate);
  const startsOnMinute = candidate.getSeconds() === 0 && candidate.getMilliseconds() === 0;
  candidate.setSeconds(0, 0);
  if (!inclusive || !startsOnMinute) {
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  for (let index = 0; index < MAX_PREVIEW_SEARCH_MINUTES && runs.length < count; index += 1) {
    if (cronMatchesDate(parsed, candidate)) {
      runs.push(new Date(candidate));
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return runs;
}

function getNextVisualRunDates(
  values: ScheduleControlValues,
  count = 5,
  notBeforeDate: Date | null = null,
) {
  const start = new Date(values.nextRunAt);
  if (Number.isNaN(start.getTime())) {
    return [];
  }

  const lowerBound = notBeforeDate && start.getTime() <= notBeforeDate.getTime()
    ? notBeforeDate
    : start;
  return getNextCronRunDates(buildVisualCron(values), lowerBound, count, {
    inclusive: lowerBound === start,
  });
}

function inferVisualCron(cron?: string | null): Pick<TaskEditForm, 'scheduleMode' | 'visualFrequency' | 'visualMinute' | 'visualHour' | 'visualWeekday' | 'visualMonthDay'> {
  const fields = normalizeCronInput(cron || '').split(/\s+/);
  const fallback = {
    scheduleMode: 'cron' as ScheduleMode,
    visualFrequency: 'daily' as VisualFrequency,
    visualMinute: 0,
    visualHour: 9,
    visualWeekday: 1,
    visualMonthDay: 1,
  };

  if (fields.length !== 5) return fallback;
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
  const minute = Number(minuteField);
  const hour = Number(hourField);
  const day = Number(dayField);
  const weekday = Number(weekdayField);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59 || monthField !== '*') return fallback;

  if (hourField === '*' && dayField === '*' && weekdayField === '*') {
    return { ...fallback, scheduleMode: 'visual', visualFrequency: 'hourly', visualMinute: minute };
  }
  if (Number.isInteger(hour) && hour >= 0 && hour <= 23 && dayField === '*' && weekdayField === '*') {
    return { ...fallback, scheduleMode: 'visual', visualFrequency: 'daily', visualMinute: minute, visualHour: hour };
  }
  if (Number.isInteger(hour) && hour >= 0 && hour <= 23 && dayField === '*' && Number.isInteger(weekday) && weekday >= 0 && weekday <= 6) {
    return { ...fallback, scheduleMode: 'visual', visualFrequency: 'weekly', visualMinute: minute, visualHour: hour, visualWeekday: weekday };
  }
  if (Number.isInteger(hour) && hour >= 0 && hour <= 23 && Number.isInteger(day) && day >= 1 && day <= 31 && weekdayField === '*') {
    return { ...fallback, scheduleMode: 'visual', visualFrequency: 'monthly', visualMinute: minute, visualHour: hour, visualMonthDay: day };
  }
  return fallback;
}

function buildSchedulePayload(
  values: Pick<TaskEditForm, 'scheduleMode' | 'scheduleCron' | 'visualFrequency' | 'visualMinute' | 'visualHour' | 'visualWeekday' | 'visualMonthDay' | 'intervalMinutes' | 'nextRunAt'>,
  messages = {
    firstRunInvalid: 'First run must be a valid date/time',
    startAfterInvalid: 'Start after must be a valid date/time',
  },
) {
  const nextRunDate = new Date(values.nextRunAt);
  if (Number.isNaN(nextRunDate.getTime())) {
    throw new Error(values.scheduleMode === 'interval' ? messages.firstRunInvalid : messages.startAfterInvalid);
  }

  if (values.scheduleMode === 'interval') {
    return {
      scheduleType: 'interval' as ScheduleType,
      scheduleCron: null,
      intervalMinutes: Math.max(1, Number(values.intervalMinutes) || 1),
      nextRunAt: nextRunDate.toISOString(),
    };
  }

  const cron = normalizeCronInput(values.scheduleMode === 'visual' ? buildVisualCron(values) : values.scheduleCron);
  return {
    scheduleType: 'cron' as ScheduleType,
    scheduleCron: cron,
    intervalMinutes: Math.max(1, Number(values.intervalMinutes) || 1),
    startAfterAt: nextRunDate.toISOString(),
  };
}

function buildTaskEditForm(task: ScheduledTask): TaskEditForm {
  const scheduleType = task.scheduleType || 'interval';
  const visualSchedule = scheduleType === 'cron'
    ? inferVisualCron(task.scheduleCron)
    : {
        scheduleMode: 'interval' as ScheduleMode,
        visualFrequency: 'daily' as VisualFrequency,
        visualMinute: 0,
        visualHour: 9,
        visualWeekday: 1,
        visualMonthDay: 15,
      };
  return {
    name: task.name || '',
    prompt: task.prompt || '',
    scheduleMode: visualSchedule.scheduleMode,
    scheduleCron: task.scheduleCron || '',
    visualFrequency: visualSchedule.visualFrequency,
    visualMinute: visualSchedule.visualMinute,
    visualHour: visualSchedule.visualHour,
    visualWeekday: visualSchedule.visualWeekday,
    visualMonthDay: visualSchedule.visualMonthDay,
    intervalMinutes: Math.max(1, Number(task.intervalMinutes) || 1),
    nextRunAt: toLocalInputValue(task.scheduleStartAt || task.nextRunAt),
    enabled: task.enabled,
    sessionMode: task.sessionMode === 'merge' ? 'merge' : 'new',
  };
}

function formatDateTime(value?: string | null, neverLabel = 'Never') {
  if (!value) return neverLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatScheduleSummary(
  task: Pick<ScheduledTask, 'scheduleType' | 'scheduleCron' | 'intervalMinutes'>,
  t: TranslationFunction,
) {
  if ((task.scheduleType || 'interval') === 'cron' && task.scheduleCron) {
    return t('scheduledTasks.summary.cron', { defaultValue: 'Cron {{expression}}', expression: task.scheduleCron });
  }
  return t('scheduledTasks.summary.everyMinutes', {
    defaultValue: 'Every {{count}} min',
    count: task.intervalMinutes,
  });
}

function DetailRow({ label, value, tone = 'default' }: { label: string; value?: string | null; tone?: 'default' | 'error' }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 break-words text-xs ${tone === 'error' ? 'text-destructive' : 'text-foreground'}`}>
        {value || '-'}
      </dd>
    </div>
  );
}

function SessionModeOptions({
  sessionMode,
  onChange,
  disabled = false,
  t,
}: {
  sessionMode: 'new' | 'merge';
  onChange: (sessionMode: 'new' | 'merge') => void;
  disabled?: boolean;
  t: TranslationFunction;
}) {
  const options = [
    {
      value: 'new' as const,
      label: t('scheduledTasks.sessionModes.new', { defaultValue: 'New session for every run' }),
      description: t('scheduledTasks.sessionModeDescriptions.new', {
        defaultValue: 'Each run uses an independent context and does not affect other runs.',
      }),
    },
    {
      value: 'merge' as const,
      label: t('scheduledTasks.sessionModes.merge', { defaultValue: 'Merge into one session' }),
      description: t('scheduledTasks.sessionModeDescriptions.merge', {
        defaultValue: 'Create a session on the first run and continue it on later runs.',
      }),
    },
  ];

  return (
    <fieldset>
      <legend className="mb-2 text-xs font-medium text-muted-foreground">
        {t('scheduledTasks.labels.sessionMode', { defaultValue: 'Session mode' })}
      </legend>
      <div role="radiogroup" className="overflow-hidden rounded-md border border-border bg-background">
        {options.map((option, index) => {
          const selected = sessionMode === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={`flex min-h-[58px] w-full items-start gap-3 px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                index > 0 ? 'border-t border-border' : ''
              } ${selected ? 'bg-primary/5' : 'hover:bg-accent/50'}`}
            >
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                  selected ? 'border-primary' : 'border-muted-foreground/60'
                }`}
              >
                {selected ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{option.label}</span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{option.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function FileMentionDropdown({
  show,
  files,
  selectedIndex,
  onSelect,
}: {
  show: boolean;
  files: MentionableFile[];
  selectedIndex: number;
  onSelect: (file: MentionableFile) => void;
}) {
  if (!show || files.length === 0) {
    return null;
  }

  return (
    <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-card shadow-lg">
      {files.map((file, index) => (
        <button
          key={file.path}
          type="button"
          className={`block w-full border-b border-border/40 px-3 py-2 text-left last:border-b-0 ${
            index === selectedIndex
              ? 'bg-primary/10 text-primary'
              : 'text-foreground hover:bg-accent/60'
          }`}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onSelect(file);
          }}
        >
          <span className="block truncate text-sm font-medium">{file.name}</span>
          <span className="block truncate font-mono text-xs text-muted-foreground">{file.path}</span>
        </button>
      ))}
    </div>
  );
}

function ScheduleControls({
  values,
  onChange,
  disabled = false,
  separateStartTime = false,
  limitPreviewToNow = false,
  allowAdvancedModes = false,
}: {
  values: ScheduleControlValues;
  onChange: (values: ScheduleControlValues) => void;
  disabled?: boolean;
  separateStartTime?: boolean;
  limitPreviewToNow?: boolean;
  allowAdvancedModes?: boolean;
}) {
  const { t } = useTranslation('chat');
  const update = (patch: Partial<ScheduleControlValues>) => onChange({ ...values, ...patch });
  const generatedCron = buildVisualCron(values);
  const cronValue = values.scheduleMode === 'visual' ? generatedCron : values.scheduleCron;
  const nextVisualRuns = getNextVisualRunDates(values, 5, limitPreviewToNow ? new Date() : null);
  const visualTime = `${pad(values.visualHour)}:${pad(values.visualMinute)}`;
  const selectedWeekday = WEEKDAYS.find((weekday) => weekday.value === values.visualWeekday);
  const visualScheduleSummary = values.visualFrequency === 'hourly'
    ? t('scheduledTasks.summary.hourly', {
        defaultValue: 'Every hour at minute {{minute}}',
        minute: pad(values.visualMinute),
      })
    : values.visualFrequency === 'monthly'
    ? t('scheduledTasks.summary.monthly', {
        defaultValue: 'Every month on day {{day}} at {{time}}',
        day: values.visualMonthDay,
        time: visualTime,
      })
    : values.visualFrequency === 'weekly'
      ? t('scheduledTasks.summary.weekly', {
          defaultValue: 'Every {{weekday}} at {{time}}',
          weekday: selectedWeekday
            ? t(selectedWeekday.labelKey, { defaultValue: selectedWeekday.defaultLabel })
            : '',
          time: visualTime,
        })
      : t('scheduledTasks.summary.daily', {
          defaultValue: 'Every day at {{time}}',
          time: visualTime,
        });
  const inlineStartTimeLabel = values.scheduleMode === 'interval'
    ? t('scheduledTasks.labels.firstRun', { defaultValue: 'First run' })
    : t('scheduledTasks.labels.startAfter', { defaultValue: 'Start after' });
  const renderStartTimeField = (label: string, className = 'space-y-1') => (
    <label className={className}>
      <span className="text-xs text-muted-foreground">
        {label}
      </span>
      <input
        type="datetime-local"
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        value={values.nextRunAt}
        onChange={(event) => update({ nextRunAt: event.target.value })}
        disabled={disabled}
      />
    </label>
  );

  return (
    <div className={separateStartTime ? 'space-y-3' : ''}>
      {separateStartTime ? (
        <div className="rounded-md border border-border bg-muted/20 p-3">
          <div className="text-xs font-medium text-muted-foreground">
            {t('scheduledTasks.labels.taskStartTime', { defaultValue: 'Task start time' })}
          </div>
          <div className="mt-3">
            {renderStartTimeField(
              t('scheduledTasks.labels.startAfter', { defaultValue: 'Start after' }),
              'block w-full max-w-sm space-y-1',
            )}
          </div>
        </div>
      ) : null}

      <div className="rounded-md border border-border bg-muted/20 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            {separateStartTime
              ? t('scheduledTasks.labels.taskScheduleRule', { defaultValue: 'Task schedule rule' })
              : t('scheduledTasks.labels.schedule', { defaultValue: 'Schedule' })}
          </span>
          {allowAdvancedModes ? (
            <div className="inline-flex rounded-md border border-border bg-background p-0.5">
              {([
                ...(values.scheduleMode === 'interval' ? ['interval' as ScheduleMode] : []),
                'visual' as ScheduleMode,
                'cron' as ScheduleMode,
              ]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`rounded px-2.5 py-1 text-xs transition-colors ${
                    values.scheduleMode === mode
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                  onClick={() => update({ scheduleMode: mode })}
                  disabled={disabled}
                >
                  {mode === 'cron'
                    ? t('scheduledTasks.modes.cron', { defaultValue: 'Cron' })
                    : mode === 'interval'
                      ? t('scheduledTasks.modes.interval', { defaultValue: 'Interval' })
                      : t('scheduledTasks.modes.visual', { defaultValue: 'Simple' })}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {values.scheduleMode === 'interval' ? (
          <div className="mt-3 grid gap-3 md:grid-cols-[180px_1fr]">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">
                {t('scheduledTasks.labels.everyMinutes', { defaultValue: 'Every minutes' })}
              </span>
              <input
                type="number"
                min={1}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={values.intervalMinutes}
                onChange={(event) => update({ intervalMinutes: Math.max(1, Number(event.target.value) || 1) })}
                disabled={disabled}
              />
            </label>
            {!separateStartTime ? renderStartTimeField(inlineStartTimeLabel) : null}
          </div>
        ) : null}

        {values.scheduleMode === 'cron' ? (
          <div className={`mt-3 grid gap-3 ${separateStartTime ? '' : 'md:grid-cols-[1fr_220px]'}`}>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">
                {t('scheduledTasks.labels.cronExpression', { defaultValue: 'Cron expression' })}
              </span>
              <input
                className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={values.scheduleCron}
                onChange={(event) => update({ scheduleCron: event.target.value })}
                placeholder="30 9 * * *"
                disabled={disabled}
              />
            </label>
            {!separateStartTime ? renderStartTimeField(inlineStartTimeLabel) : null}
          </div>
        ) : null}

        {values.scheduleMode === 'visual' ? (
          <div className="mt-3 grid gap-3">
            <div className={`grid gap-3 ${
              values.visualFrequency === 'daily' || values.visualFrequency === 'hourly'
                ? 'sm:grid-cols-2'
                : 'sm:grid-cols-3'
            }`}>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">
                  {t('scheduledTasks.labels.period', { defaultValue: 'Period' })}
                </span>
                <select
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={values.visualFrequency}
                  onChange={(event) => update({ visualFrequency: event.target.value as VisualFrequency })}
                  disabled={disabled}
                >
                  {VISUAL_FREQUENCIES.map((frequency) => (
                    <option key={frequency.value} value={frequency.value}>
                      {t(frequency.labelKey, { defaultValue: frequency.defaultLabel })}
                    </option>
                  ))}
                </select>
              </label>

              {values.visualFrequency === 'monthly' ? (
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">
                    {t('scheduledTasks.labels.date', { defaultValue: 'Date' })}
                  </span>
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={values.visualMonthDay}
                    onChange={(event) => update({ visualMonthDay: Number(event.target.value) })}
                    disabled={disabled}
                  >
                    {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                      <option key={day} value={day}>
                        {t('scheduledTasks.labels.dayOption', { defaultValue: 'Day {{day}}', day })}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {values.visualFrequency === 'weekly' ? (
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">
                    {t('scheduledTasks.labels.weekday', { defaultValue: 'Weekday' })}
                  </span>
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={values.visualWeekday}
                    onChange={(event) => update({ visualWeekday: Number(event.target.value) })}
                    disabled={disabled}
                  >
                    {WEEKDAYS.map((weekday) => (
                      <option key={weekday.value} value={weekday.value}>
                        {t(weekday.labelKey, { defaultValue: weekday.defaultLabel })}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {values.visualFrequency === 'hourly' ? (
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">
                    {t('scheduledTasks.labels.runMinute', { defaultValue: 'Run minute' })}
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={values.visualMinute}
                    onChange={(event) => update({ visualMinute: clampNumber(Number(event.target.value), 0, 59) })}
                    disabled={disabled}
                  />
                </label>
              ) : (
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">
                    {t('scheduledTasks.labels.runTime', { defaultValue: 'Run time' })}
                  </span>
                  <input
                    type="time"
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={visualTime}
                    onChange={(event) => {
                      const [hour, minute] = event.target.value.split(':').map(Number);
                      if (Number.isInteger(hour) && Number.isInteger(minute)) {
                        update({ visualHour: hour, visualMinute: minute });
                      }
                    }}
                    disabled={disabled}
                  />
                </label>
              )}
            </div>

            {!separateStartTime ? renderStartTimeField(inlineStartTimeLabel) : null}

            <div className="flex items-center gap-2 rounded-md bg-background px-3 py-2 text-xs text-foreground">
              <Repeat2 className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span>{visualScheduleSummary}</span>
            </div>

            <div className="rounded-md bg-background px-3 py-2 text-xs text-muted-foreground">
              <div className="mb-1 font-medium text-foreground">
                {t('scheduledTasks.labels.nextFiveRuns', { defaultValue: 'Next 5 runs' })}
              </div>
              {nextVisualRuns.length > 0 ? (
                <ol className="list-decimal space-y-0.5 pl-4">
                  {nextVisualRuns.map((runDate) => (
                    <li key={runDate.toISOString()}>{formatDateTime(runDate.toISOString(), '-')}</li>
                  ))}
                </ol>
              ) : (
                <div>{t('scheduledTasks.nextRunsUnavailable', { defaultValue: 'Choose a valid start time to preview runs.' })}</div>
              )}
            </div>
          </div>
        ) : null}

        {values.scheduleMode === 'cron' ? (
          <div className="mt-2 rounded-md bg-background px-3 py-2 text-xs text-muted-foreground">
            {t('scheduledTasks.cronHelp', {
              defaultValue: 'Cron runs use the server scheduler. Next run is calculated from the start time.',
            })}
            {cronValue && !isValidCronCandidate(cronValue) ? (
              <span className="ml-1 text-destructive">
                {t('scheduledTasks.cronInvalid', { defaultValue: 'Use 5 cron fields.' })}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

    </div>
  );
}

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => ({} as ErrorPayload));
  return payload.error || payload.message || fallback;
}

function getDefaultToolsSettings(provider: LLMProvider) {
  const key =
    provider === 'cursor'
      ? 'cursor-tools-settings'
      : provider === 'codex'
        ? 'codex-settings'
        : provider === 'gemini'
          ? 'gemini-settings'
          : 'claude-settings';

  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function ScheduledTasksDialog({
  open,
  selectedProject,
  provider,
  model,
  permissionMode,
  initialPrompt = '',
  initialTaskId = null,
  selectedSessionId = null,
  selectedSessionName = null,
  mode = 'manage',
  onClose,
}: ScheduledTasksDialogProps) {
  const { t } = useTranslation('chat');
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('visual');
  const [scheduleCron, setScheduleCron] = useState('');
  const [visualFrequency, setVisualFrequency] = useState<VisualFrequency>('monthly');
  const [visualMinute, setVisualMinute] = useState(0);
  const [visualHour, setVisualHour] = useState(9);
  const [visualWeekday, setVisualWeekday] = useState(1);
  const [visualMonthDay, setVisualMonthDay] = useState(15);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [nextRunAt, setNextRunAt] = useState(() => toLocalInputValue());
  const [enabled, setEnabled] = useState(true);
  const [sessionMode, setSessionMode] = useState<'new' | 'merge'>('new');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<number | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
  const [taskEditForm, setTaskEditForm] = useState<TaskEditForm | null>(null);
  const [isUpdatingTask, setIsUpdatingTask] = useState(false);
  const [deleteConfirmationTask, setDeleteConfirmationTask] = useState<ScheduledTask | null>(null);
  const [isDeletingTask, setIsDeletingTask] = useState(false);
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editPromptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const initialEditStartedRef = useRef<number | null>(null);
  const isTaskDetailMode = initialTaskId !== null && initialTaskId !== undefined;
  const showCreateForm = !isTaskDetailMode && mode === 'create';
  const showTasksList = isTaskDetailMode || mode === 'manage';
  const neverLabel = t('scheduledTasks.never', { defaultValue: 'Never' });
  const dialogTitle = isTaskDetailMode
    ? t('scheduledTasks.detailsTitle', { defaultValue: 'Scheduled task details' })
    : showCreateForm
      ? t('scheduledTasks.createTitle', { defaultValue: 'Create scheduled task' })
      : t('scheduledTasks.title', { defaultValue: 'Scheduled tasks' });

  const canSave = useMemo(
    () => {
      const scheduleIsValid = scheduleMode === 'interval'
        ? intervalMinutes >= 1
        : isValidCronCandidate(scheduleMode === 'visual'
            ? buildVisualCron({ visualFrequency, visualMinute, visualHour, visualWeekday, visualMonthDay })
            : scheduleCron);
      return Boolean(name.trim() && prompt.trim() && scheduleIsValid && nextRunAt && selectedProject.workspaceId && !isSaving);
    },
    [intervalMinutes, isSaving, name, nextRunAt, prompt, scheduleCron, scheduleMode, selectedProject.workspaceId, visualFrequency, visualHour, visualMinute, visualMonthDay, visualWeekday],
  );

  const canSaveTaskEdit = useMemo(
    () => Boolean(
      taskEditForm?.name.trim()
        && taskEditForm.prompt.trim()
        && (taskEditForm.scheduleMode === 'interval'
          ? taskEditForm.intervalMinutes >= 1
          : isValidCronCandidate(taskEditForm.scheduleMode === 'visual' ? buildVisualCron(taskEditForm) : taskEditForm.scheduleCron))
        && taskEditForm.nextRunAt
        && !isUpdatingTask,
    ),
    [isUpdatingTask, taskEditForm],
  );

  const visibleTasks = useMemo(
    () => isTaskDetailMode ? tasks.filter((task) => task.id === initialTaskId) : tasks,
    [initialTaskId, isTaskDetailMode, tasks],
  );

  const isScheduledPromptCommand = useCallback((command: SlashCommand) => {
    return provider === 'claude' && isSkillSlashCommand(command);
  }, [provider]);

  const setTaskEditPrompt = useCallback<Dispatch<SetStateAction<string>>>((nextValue) => {
    setTaskEditForm((current) => {
      if (!current) {
        return current;
      }

      const nextPrompt = typeof nextValue === 'function' ? nextValue(current.prompt) : nextValue;
      return { ...current, prompt: nextPrompt };
    });
  }, []);

  const {
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    input: prompt,
    setInput: setPrompt,
    textareaRef: promptTextareaRef,
    commandFilter: isScheduledPromptCommand,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input: prompt,
    setInput: setPrompt,
    textareaRef: promptTextareaRef,
  });

  const {
    slashCommandsCount: editSlashCommandsCount,
    filteredCommands: editFilteredCommands,
    frequentCommands: editFrequentCommands,
    showCommandMenu: showEditCommandMenu,
    selectedCommandIndex: selectedEditCommandIndex,
    resetCommandMenuState: resetEditCommandMenuState,
    handleCommandSelect: handleEditCommandSelect,
    handleToggleCommandMenu: handleEditToggleCommandMenu,
    handleCommandInputChange: handleEditCommandInputChange,
    handleCommandMenuKeyDown: handleEditCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    input: taskEditForm?.prompt || '',
    setInput: setTaskEditPrompt,
    textareaRef: editPromptTextareaRef,
    commandFilter: isScheduledPromptCommand,
  });

  const {
    showFileDropdown: showEditFileDropdown,
    filteredFiles: editFilteredFiles,
    selectedFileIndex: selectedEditFileIndex,
    selectFile: selectEditFile,
    setCursorPosition: setEditCursorPosition,
    handleFileMentionsKeyDown: handleEditFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input: taskEditForm?.prompt || '',
    setInput: setTaskEditPrompt,
    textareaRef: editPromptTextareaRef,
  });

  const promptTextareaRect = promptTextareaRef.current?.getBoundingClientRect();
  const commandMenuPosition = {
    top: promptTextareaRect ? promptTextareaRect.bottom + 8 : 0,
    left: promptTextareaRect ? promptTextareaRect.left : 16,
    bottom: promptTextareaRect ? Math.max(16, window.innerHeight - promptTextareaRect.bottom + 8) : 90,
  };
  const editPromptTextareaRect = editPromptTextareaRef.current?.getBoundingClientRect();
  const editCommandMenuPosition = {
    top: editPromptTextareaRect ? editPromptTextareaRect.bottom + 8 : 0,
    left: editPromptTextareaRect ? editPromptTextareaRect.left : 16,
    bottom: editPromptTextareaRect ? Math.max(16, window.innerHeight - editPromptTextareaRect.bottom + 8) : 90,
  };

  const resetForm = useCallback(() => {
    setName('');
    setPrompt(initialPrompt.trim());
    setScheduleMode('visual');
    setScheduleCron('');
    setVisualFrequency('monthly');
    setVisualMinute(0);
    setVisualHour(9);
    setVisualWeekday(1);
    setVisualMonthDay(15);
    setIntervalMinutes(60);
    setNextRunAt(toLocalInputValue());
    setEnabled(true);
    setSessionMode('new');
    setError(null);
    resetCommandMenuState();
    resetEditCommandMenuState();
  }, [initialPrompt, resetCommandMenuState, resetEditCommandMenuState]);

  const loadTasks = useCallback(async () => {
    if (!selectedProject.workspaceId) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.scheduledTasks.list(selectedProject.workspaceId);
      if (!response.ok) {
        setError(await readError(
          response,
          t('scheduledTasks.errors.loadFailed', { defaultValue: 'Failed to load scheduled tasks' }),
        ));
        return;
      }
      const payload = await response.json();
      const loadedTasks: ScheduledTask[] = payload.tasks || [];
      setTasks(loadedTasks);

      if (isTaskDetailMode && initialEditStartedRef.current !== initialTaskId) {
        const targetTask = loadedTasks.find((task) => task.id === initialTaskId);
        if (targetTask) {
          setExpandedTaskId(targetTask.id);
          initialEditStartedRef.current = targetTask.id;
        }
      }
    } catch (caughtError) {
      console.error('[ScheduledTasksDialog] Failed to load tasks:', caughtError);
      setError(t('scheduledTasks.errors.loadFailed', { defaultValue: 'Failed to load scheduled tasks' }));
    } finally {
      setIsLoading(false);
    }
  }, [initialTaskId, isTaskDetailMode, selectedProject.workspaceId, t]);

  useEffect(() => {
    if (expandedTaskId && tasks.length > 0 && !tasks.some((task) => task.id === expandedTaskId)) {
      setExpandedTaskId(null);
    }
    if (editingTaskId && tasks.length > 0 && !tasks.some((task) => task.id === editingTaskId)) {
      setEditingTaskId(null);
      setTaskEditForm(null);
    }
  }, [editingTaskId, expandedTaskId, tasks]);

  useEffect(() => {
    if (!open) {
      initialEditStartedRef.current = null;
      return;
    }

    initialEditStartedRef.current = null;
    setEditingTaskId(null);
    setTaskEditForm(null);
    resetForm();
    void loadTasks();
  }, [initialTaskId, loadTasks, open, resetForm]);

  const createTask = async () => {
    if (!selectedProject.workspaceId) {
      setError(t('scheduledTasks.errors.workspaceRequired', { defaultValue: 'Workspace is required' }));
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const schedulePayload = buildSchedulePayload({
        scheduleMode,
        scheduleCron,
        visualFrequency,
        visualMinute,
        visualHour,
        visualWeekday,
        visualMonthDay,
        intervalMinutes,
        nextRunAt,
      }, {
        firstRunInvalid: t('scheduledTasks.errors.firstRunInvalid', {
          defaultValue: 'First run must be a valid date/time',
        }),
        startAfterInvalid: t('scheduledTasks.errors.startAfterInvalid', {
          defaultValue: 'Start after must be a valid date/time',
        }),
      });
      const response = await api.scheduledTasks.create({
        workspaceId: selectedProject.workspaceId,
        provider,
        name: name.trim(),
        prompt: prompt.trim(),
        ...schedulePayload,
        enabled,
        model: model || null,
        permissionMode: permissionMode || null,
        toolsSettings: getDefaultToolsSettings(provider),
        sessionMode,
        sessionId: selectedSessionId || null,
      });

      if (!response.ok) {
        setError(await readError(
          response,
          t('scheduledTasks.errors.createFailed', { defaultValue: 'Failed to create scheduled task' }),
        ));
        return;
      }

      await (window as any).refreshProjects?.();
      onClose();
    } catch (caughtError) {
      console.error('[ScheduledTasksDialog] Failed to create task:', caughtError);
      setError(caughtError instanceof Error
        ? caughtError.message
        : t('scheduledTasks.errors.createFailed', { defaultValue: 'Failed to create scheduled task' }));
    } finally {
      setIsSaving(false);
    }
  };

  const startEditingTask = (task: ScheduledTask) => {
    setError(null);
    resetEditCommandMenuState();
    setExpandedTaskId(task.id);
    setEditingTaskId(task.id);
    setTaskEditForm(buildTaskEditForm(task));
  };

  const cancelTaskEdit = () => {
    resetEditCommandMenuState();
    setEditingTaskId(null);
    setTaskEditForm(null);
  };

  const saveTaskEdit = async (task: ScheduledTask) => {
    if (!taskEditForm) {
      return;
    }

    setIsUpdatingTask(true);
    setError(null);
    try {
      const schedulePayload = buildSchedulePayload(taskEditForm, {
        firstRunInvalid: t('scheduledTasks.errors.firstRunInvalid', {
          defaultValue: 'First run must be a valid date/time',
        }),
        startAfterInvalid: t('scheduledTasks.errors.startAfterInvalid', {
          defaultValue: 'Start after must be a valid date/time',
        }),
      });
      const response = await api.scheduledTasks.update(task.id, {
        name: taskEditForm.name.trim(),
        prompt: taskEditForm.prompt.trim(),
        ...schedulePayload,
        enabled: taskEditForm.enabled,
        sessionMode: taskEditForm.sessionMode,
      });

      if (!response.ok) {
        setError(await readError(
          response,
          t('scheduledTasks.errors.updateFailed', { defaultValue: 'Failed to update scheduled task' }),
        ));
        return;
      }

      await loadTasks();
      setExpandedTaskId(task.id);
      setEditingTaskId(null);
      setTaskEditForm(null);
      resetEditCommandMenuState();
      await (window as any).refreshProjects?.();
    } catch (caughtError) {
      console.error('[ScheduledTasksDialog] Failed to update task:', caughtError);
      setError(caughtError instanceof Error
        ? caughtError.message
        : t('scheduledTasks.errors.updateFailed', { defaultValue: 'Failed to update scheduled task' }));
    } finally {
      setIsUpdatingTask(false);
    }
  };

  const toggleTask = async (task: ScheduledTask) => {
    setError(null);
    try {
      const response = await api.scheduledTasks.update(task.id, { enabled: !task.enabled });
      if (!response.ok) {
        setError(await readError(
          response,
          t('scheduledTasks.errors.updateFailed', { defaultValue: 'Failed to update scheduled task' }),
        ));
        return;
      }
      await loadTasks();
      await (window as any).refreshProjects?.();
    } catch (caughtError) {
      console.error('[ScheduledTasksDialog] Failed to update task:', caughtError);
      setError(t('scheduledTasks.errors.updateFailed', { defaultValue: 'Failed to update scheduled task' }));
    }
  };

  const deleteTask = async (taskId: number): Promise<boolean> => {
    setError(null);
    setIsDeletingTask(true);
    try {
      const response = await api.scheduledTasks.remove(taskId);
      if (!response.ok) {
        setError(await readError(
          response,
          t('scheduledTasks.errors.deleteFailed', { defaultValue: 'Failed to delete scheduled task' }),
        ));
        return false;
      }
      if (expandedTaskId === taskId) {
        setExpandedTaskId(null);
      }
      if (editingTaskId === taskId) {
        resetEditCommandMenuState();
        setEditingTaskId(null);
        setTaskEditForm(null);
      }
      await loadTasks();
      await (window as any).refreshProjects?.();
      return true;
    } catch (caughtError) {
      console.error('[ScheduledTasksDialog] Failed to delete task:', caughtError);
      setError(t('scheduledTasks.errors.deleteFailed', { defaultValue: 'Failed to delete scheduled task' }));
      return false;
    } finally {
      setIsDeletingTask(false);
    }
  };

  const confirmDeleteTask = (task: ScheduledTask) => {
    resetCommandMenuState();
    resetEditCommandMenuState();
    setDeleteConfirmationTask(task);
  };

  const cancelDeleteTask = () => {
    if (!isDeletingTask) {
      setDeleteConfirmationTask(null);
    }
  };

  const handleConfirmDeleteTask = async () => {
    if (!deleteConfirmationTask) {
      return;
    }

    const deleted = await deleteTask(deleteConfirmationTask.id);
    if (deleted) {
      setDeleteConfirmationTask(null);
    }
  };

  const toggleTaskDetails = (taskId: number) => {
    const nextTaskId = expandedTaskId === taskId ? null : taskId;
    setExpandedTaskId(nextTaskId);
    if (nextTaskId === null && editingTaskId === taskId) {
      resetEditCommandMenuState();
      setEditingTaskId(null);
      setTaskEditForm(null);
    }
  };

  const handlePromptChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextPrompt = event.target.value;
    const cursorPosition = event.target.selectionStart;
    setPrompt(nextPrompt);
    setCursorPosition(cursorPosition);
    handleCommandInputChange(nextPrompt, cursorPosition);
  }, [handleCommandInputChange, setCursorPosition]);

  const handlePromptKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (handleCommandMenuKeyDown(event)) {
      return;
    }
    handleFileMentionsKeyDown(event);
  }, [handleCommandMenuKeyDown, handleFileMentionsKeyDown]);

  const handleEditPromptChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextPrompt = event.target.value;
    const cursorPosition = event.target.selectionStart;
    setTaskEditPrompt(nextPrompt);
    setEditCursorPosition(cursorPosition);
    handleEditCommandInputChange(nextPrompt, cursorPosition);
  }, [handleEditCommandInputChange, setEditCursorPosition, setTaskEditPrompt]);

  const handleEditPromptKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (handleEditCommandMenuKeyDown(event)) {
      return;
    }
    handleEditFileMentionsKeyDown(event);
  }, [handleEditCommandMenuKeyDown, handleEditFileMentionsKeyDown]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) { resetCommandMenuState(); resetEditCommandMenuState(); setDeleteConfirmationTask(null); onClose(); } }}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden p-0">
        <DialogTitle>
          {dialogTitle}
        </DialogTitle>
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <CalendarClock className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">
                {dialogTitle}
              </h2>
              <p className="truncate text-xs text-muted-foreground">
                {selectedProject.displayName || selectedProject.name}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={t('scheduledTasks.actions.close', { defaultValue: 'Close' })}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="max-h-[calc(90vh-132px)] overflow-y-auto px-5 py-4">
          <div className={!showCreateForm ? 'hidden' : 'grid gap-3'}>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">
                {t('scheduledTasks.labels.taskName', { defaultValue: 'Task name' })}
              </span>
              <input
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('scheduledTasks.placeholders.taskName', { defaultValue: 'Daily workspace check' })}
              />
            </label>
          </div>

          <div className={!showCreateForm ? 'hidden' : 'mt-3 space-y-1'}>
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs text-muted-foreground" htmlFor="scheduled-task-message">
                {t('scheduledTasks.labels.message', { defaultValue: 'Message' })}
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="relative h-7 gap-1.5 px-2 text-xs"
                onClick={handleToggleCommandMenu}
                disabled={slashCommandsCount === 0}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                {t('scheduledTasks.actions.skills', { defaultValue: 'Skills' })}
                {slashCommandsCount > 0 ? (
                  <span className="ml-0.5 rounded-sm bg-primary/10 px-1 text-[10px] text-primary">
                    {slashCommandsCount}
                  </span>
                ) : null}
              </Button>
            </div>
            <div className="relative">
              <FileMentionDropdown
                show={showFileDropdown}
                files={filteredFiles}
                selectedIndex={selectedFileIndex}
                onSelect={selectFile}
              />
              <CommandMenu
                commands={filteredCommands}
                selectedIndex={selectedCommandIndex}
                onSelect={handleCommandSelect}
                onClose={resetCommandMenuState}
                position={commandMenuPosition}
                isOpen={showCommandMenu}
                frequentCommands={frequentCommands}
              />
              <textarea
                id="scheduled-task-message"
                ref={promptTextareaRef}
                className="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={prompt}
                onChange={handlePromptChange}
                onKeyDown={handlePromptKeyDown}
                onClick={(event) => setCursorPosition(event.currentTarget.selectionStart)}
                onKeyUp={(event) => setCursorPosition(event.currentTarget.selectionStart)}
                onSelect={(event) => setCursorPosition(event.currentTarget.selectionStart)}
                placeholder={t('scheduledTasks.placeholders.message', {
                  defaultValue: 'Ask the agent what to do when the task runs',
                })}
              />
            </div>
          </div>

          {selectedSessionId ? (
            <div className={!showCreateForm ? 'hidden' : 'mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground'}>
              {t('scheduledTasks.boundSession', {
                defaultValue: 'Bound session: {{session}}',
                session: selectedSessionName || selectedSessionId,
              })}
            </div>
          ) : null}

          <div className={!showCreateForm ? 'hidden' : 'mt-3 space-y-3'}>
            <ScheduleControls
              values={{
                scheduleMode,
                scheduleCron,
                visualFrequency,
                visualMinute,
                visualHour,
                visualWeekday,
                visualMonthDay,
                intervalMinutes,
                nextRunAt,
              }}
              onChange={(values) => {
                setScheduleMode(values.scheduleMode);
                setScheduleCron(values.scheduleCron);
                setVisualFrequency(values.visualFrequency);
                setVisualMinute(values.visualMinute);
                setVisualHour(values.visualHour);
                setVisualWeekday(values.visualWeekday);
                setVisualMonthDay(values.visualMonthDay);
                setIntervalMinutes(values.intervalMinutes);
                setNextRunAt(values.nextRunAt);
              }}
              separateStartTime
            />
            <SessionModeOptions sessionMode={sessionMode} onChange={setSessionMode} t={t} />
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              {t('scheduledTasks.labels.enabled', { defaultValue: 'Enabled' })}
            </label>
          </div>

          {error ? (
            <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className={!showCreateForm ? 'hidden' : 'mt-4 flex justify-end'}>
            <Button onClick={() => void createTask()} disabled={!canSave}>
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" />}
              {t('scheduledTasks.actions.createTask', { defaultValue: 'Create task' })}
            </Button>
          </div>

          {showTasksList ? (
          <div className={showCreateForm ? 'mt-5 border-t border-border pt-4' : ''}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium text-foreground">
                {isTaskDetailMode
                  ? t('scheduledTasks.taskDetails', { defaultValue: 'Task details' })
                  : t('scheduledTasks.existingTasks', { defaultValue: 'Existing tasks' })}
              </h3>
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
            </div>

            {visibleTasks.length === 0 && !isLoading ? (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
                {isTaskDetailMode
                  ? t('scheduledTasks.notFound', { defaultValue: 'Scheduled task not found.' })
                  : t('scheduledTasks.noTasks', { defaultValue: 'No scheduled tasks yet.' })}
              </div>
            ) : (
              <div className="divide-y divide-border rounded-md border border-border">
                {visibleTasks.map((task) => {
                  const isExpanded = expandedTaskId === task.id;
                  const taskEditValues = editingTaskId === task.id ? taskEditForm : null;
                  return (
                    <div key={task.id} className="px-3 py-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-start gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          onClick={() => toggleTaskDetails(task.id)}
                          aria-expanded={isExpanded}
                        >
                          <span className="mt-0.5 shrink-0 text-muted-foreground">
                            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </span>
                          <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium text-foreground">{task.name}</span>
                              <span className={`rounded-sm px-1.5 py-0.5 text-[11px] ${
                                task.enabled
                                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                  : 'bg-muted text-muted-foreground'
                              }`}>
                                {task.enabled
                                  ? t('scheduledTasks.status.enabled', { defaultValue: 'Enabled' })
                                  : t('scheduledTasks.status.paused', { defaultValue: 'Paused' })}
                              </span>
                            </span>
                            <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">{task.prompt}</span>
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {t('scheduledTasks.summary.runInfo', {
                                defaultValue: '{{schedule}}. Next: {{next}}. Last: {{last}}',
                                schedule: formatScheduleSummary(task, t),
                                next: formatDateTime(task.nextRunAt, neverLabel),
                                last: formatDateTime(task.lastRunAt, neverLabel),
                              })}
                            </span>
                            {task.lastError ? (
                              <span className="mt-1 block text-xs text-destructive">{task.lastError}</span>
                            ) : null}
                          </span>
                        </button>
                        <div className="flex shrink-0 gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => startEditingTask(task)}
                            disabled={Boolean(taskEditValues)}
                          >
                            <Edit2 className="h-4 w-4" />
                            {t('scheduledTasks.actions.edit', { defaultValue: 'Edit' })}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void toggleTask(task)}
                            disabled={Boolean(taskEditValues)}
                          >
                            {task.enabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                            {task.enabled
                              ? t('scheduledTasks.actions.pause', { defaultValue: 'Pause' })
                              : t('scheduledTasks.actions.resume', { defaultValue: 'Resume' })}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => confirmDeleteTask(task)}
                            aria-label={t('scheduledTasks.actions.deleteTask', { defaultValue: 'Delete task' })}
                            disabled={Boolean(taskEditValues) || isDeletingTask}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>

                      {isExpanded ? (
                        <div className="mt-3 rounded-md border border-border bg-muted/20 p-3">
                          {taskEditValues ? (
                            <div className="grid gap-3">
                              <label className="space-y-1">
                                <span className="text-xs text-muted-foreground">
                                  {t('scheduledTasks.labels.taskName', { defaultValue: 'Task name' })}
                                </span>
                                <input
                                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                  value={taskEditValues.name}
                                  onChange={(event) => {
                                    setTaskEditForm((current) => current ? { ...current, name: event.target.value } : current);
                                  }}
                                  disabled={isUpdatingTask}
                                />
                              </label>

                              <div className="space-y-1">
                                <div className="flex items-center justify-between gap-2">
                                  <label className="text-xs text-muted-foreground" htmlFor="scheduled-task-edit-message">
                                    {t('scheduledTasks.labels.message', { defaultValue: 'Message' })}
                                  </label>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="relative h-7 gap-1.5 px-2 text-xs"
                                    onClick={handleEditToggleCommandMenu}
                                    disabled={editSlashCommandsCount === 0 || isUpdatingTask}
                                  >
                                    <MessageSquare className="h-3.5 w-3.5" />
                                    {t('scheduledTasks.actions.skills', { defaultValue: 'Skills' })}
                                    {editSlashCommandsCount > 0 ? (
                                      <span className="ml-0.5 rounded-sm bg-primary/10 px-1 text-[10px] text-primary">
                                        {editSlashCommandsCount}
                                      </span>
                                    ) : null}
                                  </Button>
                                </div>
                                <div className="relative">
                                  <FileMentionDropdown
                                    show={showEditFileDropdown}
                                    files={editFilteredFiles}
                                    selectedIndex={selectedEditFileIndex}
                                    onSelect={selectEditFile}
                                  />
                                  <CommandMenu
                                    commands={editFilteredCommands}
                                    selectedIndex={selectedEditCommandIndex}
                                    onSelect={handleEditCommandSelect}
                                    onClose={resetEditCommandMenuState}
                                    position={editCommandMenuPosition}
                                    isOpen={showEditCommandMenu}
                                    frequentCommands={editFrequentCommands}
                                  />
                                  <textarea
                                    id="scheduled-task-edit-message"
                                    ref={editPromptTextareaRef}
                                    className="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                    value={taskEditValues.prompt}
                                    onChange={handleEditPromptChange}
                                    onKeyDown={handleEditPromptKeyDown}
                                    onClick={(event) => setEditCursorPosition(event.currentTarget.selectionStart)}
                                    onKeyUp={(event) => setEditCursorPosition(event.currentTarget.selectionStart)}
                                    onSelect={(event) => setEditCursorPosition(event.currentTarget.selectionStart)}
                                    disabled={isUpdatingTask}
                                  />
                                </div>
                              </div>

                              <div className="space-y-3">
                                <ScheduleControls
                                  values={taskEditValues}
                                  onChange={(values) => {
                                    setTaskEditForm((current) => current ? { ...current, ...values } : current);
                                  }}
                                  disabled={isUpdatingTask}
                                  separateStartTime
                                  limitPreviewToNow
                                  allowAdvancedModes
                                />
                                <SessionModeOptions
                                  sessionMode={taskEditValues.sessionMode}
                                  onChange={(nextSessionMode) => {
                                    setTaskEditForm((current) => current
                                      ? { ...current, sessionMode: nextSessionMode }
                                      : current);
                                  }}
                                  disabled={isUpdatingTask}
                                  t={t}
                                />
                                <label className="flex items-center gap-2 text-sm text-foreground">
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4 rounded border-input"
                                    checked={taskEditValues.enabled}
                                    onChange={(event) => {
                                      setTaskEditForm((current) => current ? { ...current, enabled: event.target.checked } : current);
                                    }}
                                    disabled={isUpdatingTask}
                                  />
                                  {t('scheduledTasks.labels.enabled', { defaultValue: 'Enabled' })}
                                </label>
                              </div>

                              <div className="grid gap-3 sm:grid-cols-2">
                                <DetailRow label={t('scheduledTasks.labels.session', { defaultValue: 'Session' })} value={task.lastSessionId} />
                                <DetailRow
                                  label={t('scheduledTasks.labels.sessionMode', { defaultValue: 'Session mode' })}
                                  value={task.sessionMode === 'merge'
                                    ? t('scheduledTasks.sessionModes.merge', { defaultValue: 'Merge into one session' })
                                    : t('scheduledTasks.sessionModes.new', { defaultValue: 'New session for every run' })}
                                />
                                <DetailRow label={t('scheduledTasks.labels.model', { defaultValue: 'Model' })} value={task.model} />
                                <DetailRow label={t('scheduledTasks.labels.permission', { defaultValue: 'Permission' })} value={task.permissionMode} />
                                <DetailRow label={t('scheduledTasks.labels.startAfter', { defaultValue: 'Start after' })} value={formatDateTime(task.scheduleStartAt || task.nextRunAt, neverLabel)} />
                                <DetailRow label={t('scheduledTasks.labels.lastRun', { defaultValue: 'Last run' })} value={formatDateTime(task.lastRunAt, neverLabel)} />
                                <DetailRow label={t('scheduledTasks.labels.created', { defaultValue: 'Created' })} value={formatDateTime(task.createdAt, neverLabel)} />
                                {task.lastError ? (
                                  <DetailRow label={t('scheduledTasks.labels.lastError', { defaultValue: 'Last error' })} value={task.lastError} tone="error" />
                                ) : null}
                              </div>

                              <div className="flex justify-end gap-2">
                                <Button variant="ghost" size="sm" onClick={cancelTaskEdit} disabled={isUpdatingTask}>
                                  {t('scheduledTasks.actions.cancel', { defaultValue: 'Cancel' })}
                                </Button>
                                <Button size="sm" onClick={() => void saveTaskEdit(task)} disabled={!canSaveTaskEdit}>
                                  {isUpdatingTask ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                                  {t('scheduledTasks.actions.saveChanges', { defaultValue: 'Save changes' })}
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <dl className="grid gap-3 sm:grid-cols-2">
                              <DetailRow label={t('scheduledTasks.labels.message', { defaultValue: 'Message' })} value={task.prompt} />
                              <DetailRow label={t('scheduledTasks.labels.schedule', { defaultValue: 'Schedule' })} value={formatScheduleSummary(task, t)} />
                              <DetailRow label={t('scheduledTasks.labels.startAfter', { defaultValue: 'Start after' })} value={formatDateTime(task.scheduleStartAt || task.nextRunAt, neverLabel)} />
                              <DetailRow label={t('scheduledTasks.labels.nextRun', { defaultValue: 'Next run' })} value={formatDateTime(task.nextRunAt, neverLabel)} />
                              <DetailRow label={t('scheduledTasks.labels.lastRun', { defaultValue: 'Last run' })} value={formatDateTime(task.lastRunAt, neverLabel)} />
                              <DetailRow label={t('scheduledTasks.labels.session', { defaultValue: 'Session' })} value={task.lastSessionId} />
                              <DetailRow
                                label={t('scheduledTasks.labels.sessionMode', { defaultValue: 'Session mode' })}
                                value={task.sessionMode === 'merge'
                                  ? t('scheduledTasks.sessionModes.merge', { defaultValue: 'Merge into one session' })
                                  : t('scheduledTasks.sessionModes.new', { defaultValue: 'New session for every run' })}
                              />
                              <DetailRow label={t('scheduledTasks.labels.model', { defaultValue: 'Model' })} value={task.model} />
                              <DetailRow label={t('scheduledTasks.labels.permission', { defaultValue: 'Permission' })} value={task.permissionMode} />
                              <DetailRow label={t('scheduledTasks.labels.created', { defaultValue: 'Created' })} value={formatDateTime(task.createdAt, neverLabel)} />
                              {task.lastError ? (
                                <DetailRow label={t('scheduledTasks.labels.lastError', { defaultValue: 'Last error' })} value={task.lastError} tone="error" />
                              ) : null}
                            </dl>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          ) : null}
        </div>
      </DialogContent>
      {deleteConfirmationTask
        ? ReactDOM.createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
              <div className="p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                    <AlertTriangle className="h-6 w-6 text-red-600 dark:text-red-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="mb-2 text-lg font-semibold text-foreground">
                      {t('scheduledTasks.actions.deleteTask', { defaultValue: 'Delete task' })}
                    </h3>
                    <p className="mb-1 text-sm text-muted-foreground">
                      {t('scheduledTasks.confirmDelete', {
                        defaultValue: 'Delete scheduled task "{{name}}"? This cannot be undone.',
                        name: deleteConfirmationTask.name,
                      })}
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex gap-3 border-t border-border bg-muted/30 p-4">
                <Button variant="outline" className="flex-1" onClick={cancelDeleteTask} disabled={isDeletingTask}>
                  {t('scheduledTasks.actions.cancel', { defaultValue: 'Cancel' })}
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1 bg-red-600 text-white hover:bg-red-700"
                  onClick={() => void handleConfirmDeleteTask()}
                  disabled={isDeletingTask}
                >
                  {isDeletingTask ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                  {t('scheduledTasks.actions.deleteTask', { defaultValue: 'Delete task' })}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )
        : null}
    </Dialog>
  );
}
