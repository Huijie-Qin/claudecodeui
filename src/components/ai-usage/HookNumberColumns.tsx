import type { TFunction } from 'i18next';

import type { ReportColumn } from './ReportTable';
import { formatHookNumber, hookNumberMetrics, type HookNumberMetric } from './usageUtils';

// All four statistics remain in the published result; show only the selection.
export function hookNumberColumns(t: TFunction, metric: HookNumberMetric = 'sum', sortable = false): ReportColumn[] {
  const { key, title } = hookNumberMetrics.find((item) => item.key === metric) || hookNumberMetrics[0];
  return [
    { key, title: `${t('fieldResult')} · ${t(title)}`, ...(sortable ? { sortKey: key } : {}),
      render: (row) => <span className="whitespace-nowrap font-medium tabular-nums">{formatHookNumber(row[key])}</span> },
  ];
}
