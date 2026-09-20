import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import AnalysisPanel from './AnalysisPanel';
import Overlay from './ReportOverlay';
import { displayReportValue } from './usageUtils';
import type { UsageRow } from './types';

export default function TemplateReport({ params, onAccessError }: { params: Record<string, unknown>; onAccessError: () => void }) {
  const { t } = useTranslation('aiUsage');
  const [selected, setSelected] = useState<UsageRow | null>(null);
  return <>
    <AnalysisPanel tab="templates" params={params} onAccessError={onAccessError} onTemplate={setSelected} />
    {selected && <Overlay title={`${displayReportValue(selected.groupLabel)} · ${t('templateExploreTitle')}`} onClose={() => setSelected(null)} fullHeight>
      <AnalysisPanel key={String(selected.groupKey)} tab="templates" stateKey={`template:${selected.groupKey}`} groups={['user','workspace','day','week','month']} params={{ ...params, templateId: String(selected.groupKey) }} onAccessError={onAccessError} />
    </Overlay>}
  </>;
}
