import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileJson2, Loader2, RefreshCw, X } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '../../shared/view/ui';
import { api } from '../../utils/api';
import { useUiPreferences } from '../../hooks/useUiPreferences';

type ExecutionOutput = {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  eventName: string;
  durationMs: number | null;
  scriptOutput: unknown;
  response: unknown;
  errorMessage: string | null;
};

type Props = {
  workspaceId: number;
  hookId: string;
  hookName: string;
  executionId: string;
  onOpenChange?: (open: boolean) => void;
  inline?: boolean;
  executionStatus?: string;
};

export default function UserHookExecutionDetails({ workspaceId, hookId, hookName, executionId, onOpenChange, inline = false, executionStatus }: Props) {
  const { t } = useTranslation('chat');
  const { preferences } = useUiPreferences();
  const enabled = preferences.showHookExecutionDetails;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [execution, setExecution] = useState<ExecutionOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setOpen(false);
      onOpenChangeRef.current?.(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled || (!inline && !open)) return;
    const controller = new AbortController();
    setExecution(null);
    setError(null);
    setLoading(true);
    void (async () => {
      try {
        const response = await api.workspaceHookExecution(workspaceId, hookId, executionId, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(response.status === 403 || response.status === 404 ? 'unavailable' : 'loadFailed');
        }
        const payload = await response.json();
        if (!payload.execution || payload.execution.id !== executionId) throw new Error('loadFailed');
        if (!controller.signal.aborted) setExecution(payload.execution);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error && cause.message === 'unavailable' ? 'unavailable' : 'loadFailed');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [enabled, inline, open, revision, workspaceId, hookId, executionId, executionStatus]);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const renderOutput = (label: string, value: unknown, field: string) => (
    <section className="overflow-hidden rounded-lg border border-border" data-hook-output-field={field}>
      <h3 className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-semibold">{label}</h3>
      {value == null ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">
          {t(`hookExecutionDetails.${execution?.status === 'running' ? 'pending' : 'notRecorded'}`)}
        </p>
      ) : (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words bg-background p-3 font-mono text-xs leading-5 text-foreground">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </section>
  );

  const content = (
    <>
      <div className="min-h-0 space-y-3 overflow-y-auto p-4" aria-busy={loading}>
        {loading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t('hookExecutionDetails.loading')}
          </p>
        ) : error ? (
          <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{t(`hookExecutionDetails.${error}`)}</p>
        ) : execution ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className={`rounded-full px-2 py-1 font-medium ${execution.status === 'failed'
                ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
                : 'bg-muted text-foreground'}`}>
                {t(`hookExecutionDetails.status.${execution.status}`)}
              </span>
              <span>{execution.eventName}</span>
              {execution.durationMs != null ? <span>{execution.durationMs} ms</span> : null}
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{t('hookExecutionDetails.note')}</p>
            {execution.errorMessage ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{execution.errorMessage}</pre> : null}
            {renderOutput(t('hookExecutionDetails.scriptOutput'), execution.scriptOutput, 'scriptOutput')}
            {renderOutput(t('hookExecutionDetails.response'), execution.response, 'response')}
          </>
        ) : null}
      </div>
      <footer className="flex items-center justify-between gap-3 border-t border-border p-4">
        <p className="text-[11px] text-muted-foreground">{t('hookExecutionDetails.scope')}</p>
        <button type="button" disabled={loading} onClick={() => setRevision((value) => value + 1)} className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />{t('hookExecutionDetails.refresh')}
        </button>
      </footer>
    </>
  );

  if (inline) {
    return enabled ? (
      <section className="overflow-hidden rounded-lg border border-border bg-background/70" data-hook-script-response>
        <h4 className="border-b border-border px-4 py-2 text-xs font-semibold">{t('hookExecutionDetails.inlineTitle')}</h4>
        {content}
      </section>
    ) : null;
  }

  return (
    <Dialog open={enabled && open} onOpenChange={changeOpen}>
      {enabled ? (
        <DialogTrigger className="inline-flex items-center gap-1.5 rounded-md border border-violet-200 bg-background/80 px-2.5 py-1.5 text-xs font-medium text-violet-700 transition-colors hover:bg-violet-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-violet-800 dark:text-violet-200 dark:hover:bg-violet-900/50">
          <FileJson2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('hookExecutionDetails.view')}
        </DialogTrigger>
      ) : null}
      <DialogContent
        portalClassName="z-[10020]"
        className="flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-2xl flex-col overflow-hidden"
        aria-labelledby={titleId}
        data-user-hook-execution-detail
      >
        <header className="flex items-start gap-3 border-b border-border p-4">
          <div className="min-w-0 flex-1">
            <DialogTitle id={titleId} className="not-sr-only text-base font-semibold">{t('hookExecutionDetails.title')}</DialogTitle>
            <p className="mt-1 break-words text-xs text-muted-foreground">{hookName}</p>
          </div>
          <button type="button" onClick={() => changeOpen(false)} aria-label={t('hookExecutionDetails.close')} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        {content}
      </DialogContent>
    </Dialog>
  );
}
