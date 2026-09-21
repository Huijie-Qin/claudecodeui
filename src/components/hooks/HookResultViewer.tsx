import { memo, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ResultPage } from './hookResultPages';

function ResultPreview({ value, contentId }: { value: unknown; contentId: string }) {
  const { t } = useTranslation('chat');
  const [preview, setPreview] = useState<ResultPage | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    setBusy(true);
    setError(false);
    setPreview(null);
    let instance: Worker | undefined;
    const fail = () => { setError(true); setBusy(false); };
    try {
      instance = new Worker(new URL('./hookResult.worker.ts', import.meta.url), { type: 'module' });
      instance.onerror = fail;
      instance.onmessage = ({ data }) => {
        if (data.type === 'error') { fail(); return; }
        if (data.type === 'preview') {
          setPreview(data);
          setBusy(false);
          instance?.terminate();
        }
      };
      instance.postMessage({ type: 'init', value });
    } catch { fail(); }
    return () => {
      instance?.terminate();
    };
  }, [value]);

  return (
    <div id={contentId} data-hook-result-preview aria-busy={busy}>
      {error ? <p role="alert" className="py-2 text-xs text-red-600">{t('hookResultViewer.error')}</p>
        : preview ? <pre className="my-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background/75 p-2 text-[11px] leading-relaxed text-foreground/80">{preview.text}</pre>
          : <p role="status" className="py-2 text-xs text-muted-foreground">{t('hookResultViewer.loading')}</p>}
      {preview?.hasMore ? <p className="mt-1 text-[10px] text-muted-foreground">{t('hookResultViewer.limit')}</p> : null}
    </div>
  );
}

// Do not mount a worker, traverse data, or format JSON while collapsed.
export default memo(function HookResultViewer({ value }: { value: unknown }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <div data-hook-result-viewer className="mt-1.5">
      <button type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(!open)} className="rounded border border-current/20 px-2 py-1 text-xs font-medium hover:bg-muted">
        {t(open ? 'hookResultViewer.collapse' : 'hookResultViewer.view')}
      </button>
      {open ? <ResultPreview value={value} contentId={contentId} /> : null}
    </div>
  );
});
