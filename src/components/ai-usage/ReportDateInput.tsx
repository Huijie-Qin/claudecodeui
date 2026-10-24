import { useId } from 'react';
import { CalendarDays } from 'lucide-react';

import { normalizeUsageDate } from './dateInput';

type Props = {
  value: string; onChange: (value: string) => void; max?: string;
  label: string; calendarLabel: string;
};

export default function ReportDateInput({ value, onChange, max, label, calendarLabel }: Props) {
  const id = useId();
  const normalized = normalizeUsageDate(value);
  return <div className="ai-report-date-input flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
    <label htmlFor={id}>{label}</label>
    <div className="flex h-9 min-w-0 items-center rounded-md border border-input bg-background text-foreground focus-within:ring-2 focus-within:ring-ring/30">
      <input id={id} type="text" value={value} placeholder="YYYY-MM-DD" autoComplete="off" spellCheck={false} maxLength={32}
        className="h-full min-w-0 flex-1 rounded-l-md bg-transparent px-3 text-sm outline-none"
        onChange={event => onChange(event.target.value)}
        onBlur={() => { if (normalized && normalized !== value) onChange(normalized); }} />
      <span className="relative flex h-full w-9 shrink-0 items-center justify-center rounded-r-md border-l border-input text-muted-foreground focus-within:bg-muted hover:bg-muted">
        <CalendarDays aria-hidden="true" className="h-4 w-4" />
        <input type="date" aria-label={`${label} · ${calendarLabel}`} title={calendarLabel}
          value={normalized || ''} max={max} tabIndex={0}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:cursor-pointer"
          onChange={event => onChange(event.target.value)} />
      </span>
    </div>
  </div>;
}
