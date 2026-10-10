import { useTranslation } from 'react-i18next';

import { hookNumberMetrics, isHookNumberMetric, type HookNumberMetric } from './usageUtils';
import ReportSelect from './ReportSelect';

export default function HookStatisticSelect({ value, onChange }: {
  value: HookNumberMetric; onChange: (value: HookNumberMetric) => void;
}) {
  const { t } = useTranslation('aiUsage');
  return <ReportSelect label={t('aggregation')} value={value} className="ai-report-statistic-select" menuMinWidth={160}
    options={hookNumberMetrics.map(({ key, title }) => ({ value: key, label: t(title) }))}
    onChange={next => { if (isHookNumberMetric(next)) onChange(next); }} />;
}
