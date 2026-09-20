import { useTranslation } from 'react-i18next';

import { hookNumberMetrics, isHookNumberMetric, type HookNumberMetric } from './usageUtils';

export default function HookStatisticSelect({ value, onChange }: {
  value: HookNumberMetric; onChange: (value: HookNumberMetric) => void;
}) {
  const { t } = useTranslation('aiUsage');
  return <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t('aggregation')}
    <select className="h-9 min-w-32 rounded border border-input bg-background px-3 text-sm text-foreground" value={value}
      onChange={(event) => { if (isHookNumberMetric(event.target.value)) onChange(event.target.value); }}>
      {hookNumberMetrics.map(({ key, title }) => <option key={key} value={key}>{t(title)}</option>)}
    </select>
  </label>;
}
