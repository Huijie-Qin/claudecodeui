import { useContext, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';

import { usageRequest } from './client';
import { ReportExportAccess } from './ReportExportContext';
import { isUsageAccessFailure, usageFailureKey } from './requestState';
import { collectExportRows, downloadReportCsv, reportCsv, reportExportFilename } from './reportExport';
import type { ReportColumn } from './ReportTable';

export default function ReportExportButton({ endpoint, params, columns, total, title, disabled = false, compact = false, onAccessError }: {
  endpoint: string; params: Record<string, unknown>; columns: ReportColumn[]; total: number;
  title: string; disabled?: boolean; compact?: boolean; onAccessError: () => void;
}) {
  const { t } = useTranslation('aiUsage');
  const allowed = useContext(ReportExportAccess);
  const controller = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const key = JSON.stringify([endpoint, params, total, columns.map(({ key, title }) => [key, title]), title, allowed, disabled]);
  useEffect(() => {
    setProgress(null); setMessage(''); setError('');
    return () => { controller.current?.abort(); controller.current = null; };
  }, [key]);
  const start = async () => {
    if (!allowed || disabled || controller.current) return;
    const active = new AbortController(); controller.current = active;
    setProgress(0); setMessage(''); setError('');
    try {
      const rows = await collectExportRows({ endpoint, params: { ...params }, total, signal: active.signal, request: usageRequest, onProgress: setProgress });
      const csv = reportCsv(columns, rows);
      active.signal.throwIfAborted();
      downloadReportCsv(csv, reportExportFilename(title, params));
      setMessage(t('exportComplete', { count: rows.length }));
    } catch (caught) {
      if (active.signal.aborted) return;
      if (isUsageAccessFailure(caught) || (caught instanceof Error && caught.message === 'exportDenied')) onAccessError();
      else setError(usageFailureKey(caught, caught instanceof Error && ['exportTooLarge', 'exportChanged', 'batchMismatch'].includes(caught.message) ? caught.message : 'exportFailed'));
    } finally {
      if (controller.current === active) { controller.current = null; setProgress(null); }
    }
  };
  if (!allowed) return null;
  return <div className="flex flex-col items-end gap-1.5">
    <Button data-report-export type="button" size="sm" variant="outline" disabled={disabled || progress !== null} aria-label={t('exportCurrent')} title={t('exportCurrentHint')} onClick={() => void start()}>
      {progress === null ? <ArrowDownToLine className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
      {progress === null ? compact ? null : t('exportCurrent') : t('exportProgress', { count: progress, total })}
    </Button>
    {message && <span role="status" className="text-xs text-muted-foreground">{message}</span>}
    {error && <span role="alert" className="max-w-72 text-xs text-destructive">{t(error)}</span>}
  </div>;
}
