import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';

import { usageRequest } from './client';
import { collectWorkbook, workbookBytes, workbookSpecs } from './reportWorkbook';
import type { ReportViewStore } from './reportViewState';
import { isUsageAccessFailure, usageFailureKey } from './requestState';

export default function WorkbookDownload({ tenantId, batchId, through, views, codeAvailable, disabled, onAccessError }: {
  tenantId: number; batchId: string; through: string; views: ReportViewStore; codeAvailable: boolean; disabled: boolean; onAccessError: () => void;
}) {
  const { t } = useTranslation('aiUsage');
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => () => controller.current?.abort(), [tenantId, batchId]);
  const start = async () => {
    if (disabled || controller.current) return;
    const active = new AbortController(); controller.current = active;
    setBusy(true); setError(''); setMessage('');
    try {
      const specs = workbookSpecs({ tenantId, batchId, through, views, codeAvailable, t });
      const sheets = await collectWorkbook({ specs, tenantId, batchId, signal: active.signal, request: usageRequest, t,
        onProgress: (sheet, count) => setMessage(t('workbook.progress', { sheet, count })) });
      const bytes = await workbookBytes(sheets);
      active.signal.throwIfAborted();
      // Packing can take time: check live permissions and the batch once more before download.
      const access = await usageRequest<{ canExport: boolean; canViewTenant: boolean }>('capabilities', { tenantId }, active.signal);
      const status = await usageRequest<{ batchId: string }>('status', { tenantId }, active.signal);
      if (!access.canExport || !access.canViewTenant) throw new Error('exportDenied');
      if (status.batchId !== batchId) throw new Error('batchMismatch');
      active.signal.throwIfAborted();
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const link = document.createElement('a');
      link.href = url; link.download = `AI-Reports_${tenantId}_${through}.xlsx`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(t('workbook.complete', { count: sheets.length }));
    } catch (caught) {
      if (active.signal.aborted) return;
      setMessage('');
      if (isUsageAccessFailure(caught) || (caught instanceof Error && caught.message === 'exportDenied')) onAccessError();
      else setError(usageFailureKey(caught, caught instanceof Error && ['exportTooLarge', 'exportChanged', 'batchMismatch'].includes(caught.message) ? caught.message : 'exportFailed'));
    } finally {
      if (controller.current === active) { controller.current = null; setBusy(false); }
    }
  };
  return <div className="flex flex-col items-end gap-1">
    <Button size="sm" variant="outline" disabled={disabled || busy} title={t('workbook.hint')} onClick={() => void start()}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}{t(busy ? 'workbook.busy' : 'workbook.download')}
    </Button>
    {message && <span role="status" className="max-w-64 text-xs text-muted-foreground">{message}</span>}
    {error && <span role="alert" className="max-w-64 text-xs text-destructive">{t(error)}</span>}
  </div>;
}
