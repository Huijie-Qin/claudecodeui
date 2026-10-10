import { useRef } from 'react';
import { CalendarDays, UsersRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import MetricDefinition from './MetricDefinition';
import ReportSelect from './ReportSelect';
import { isTimeGroup, splitReportGroups } from './groupingState';

export default function ReportGrouping({ value, options, onChange, labels = {} }: {
  value: string; options: readonly string[]; onChange: (value: string) => void; labels?: Record<string, string>;
}) {
  const { t } = useTranslation('aiUsage');
  const { objects, periods } = splitReportGroups(options);
  const time = isTimeGroup(value);
  const lastObject = useRef(time ? objects[0] : value);
  const lastPeriod = useRef(time ? value : periods[0]);
  const select = (next: string) => {
    if (isTimeGroup(next)) lastPeriod.current = next; else lastObject.current = next;
    onChange(next);
  };
  if (options.length < 2) return null;
  return <div className="ai-report-grouping">
    {objects.length > 0 && periods.length > 0 && <div className="ai-report-view-switch" role="group" aria-label={t('grouping.view')}>
      <button type="button" aria-pressed={!time} onClick={() => select(objects.includes(lastObject.current) ? lastObject.current : objects[0])}><UsersRound aria-hidden="true" />{t('grouping.objects')}</button>
      <button type="button" aria-pressed={time} onClick={() => select(periods.includes(lastPeriod.current) ? lastPeriod.current : periods[0])}><CalendarDays aria-hidden="true" />{t('grouping.time')}</button>
    </div>}
    <ReportSelect label={t(time ? 'grouping.granularity' : 'grouping.object')} value={value} onChange={select} menuMinWidth={160}
      options={(time ? periods : objects).map(group => ({ value: group, label: labels[group] || t(time ? `grouping.${group}` : `group.${group}`) }))} />
    {time && <MetricDefinition><span className="ai-report-grouping-hint">{t(value === 'week' ? 'grouping.weekHint' : value === 'month' ? 'grouping.monthHint' : 'grouping.dayHint')}</span></MetricDefinition>}
  </div>;
}
