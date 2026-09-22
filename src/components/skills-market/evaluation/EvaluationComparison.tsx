import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Square, X } from 'lucide-react';

import EvaluationRunDetail from './EvaluationRunDetail';
import type { EvaluationJob } from './types';

export default function EvaluationComparison({ workspaceId, job, caseId, canCancel, busy, onCancel, onClose }: {
  workspaceId: number; job: EvaluationJob; caseId: number; canCancel: boolean; busy: boolean; onCancel: () => void; onClose: () => void;
}) {
  const { t } = useTranslation('common');
  const tr = (key: string) => t(`skillEvaluation.${key}`);
  const [expected, setExpected] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const after = selected ?? job.rounds.filter((round) => round.round > 0).at(-1)?.round;
  const dialog = useRef<HTMLDivElement>(null), close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close.current(); } };
    document.addEventListener('keydown', escape);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', escape); previous?.focus(); };
  }, []);
  const button = 'inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50';
  return createPortal(<div className="fixed inset-0 z-[10050] bg-black/40 p-2 sm:p-5" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={tr('comparison.title')} className="mx-auto flex h-full max-w-[1600px] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl" onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select, summary, a[href], [tabindex="0"]') || []).filter((element) => element.getClientRects().length);
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <h2 className="font-semibold">{tr('comparison.title')} · #{caseId}</h2>
        <div className="flex gap-2">{canCancel && <button type="button" className={button} disabled={busy || job.status === 'cancelling'} onClick={onCancel}><Square className="h-4 w-4" />{tr('trace.stopRun')}</button>}
          <button type="button" className={button} onClick={onClose} aria-label={tr('close')}><X className="h-4 w-4" /></button></div>
      </header>
      <p className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground sm:hidden">{tr('comparison.swipe')}</p>
      {expected && <details className="shrink-0 border-b border-border px-4 py-3 text-sm" open><summary className="cursor-pointer font-medium">{tr('expected')}</summary><p className="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap break-words">{expected}</p></details>}
      <div className="min-h-0 flex-1 overflow-x-auto"><div className="grid h-full min-w-[900px] grid-cols-2">
        <EvaluationRunDetail key={`${job.id}:${caseId}:0`} embedded initial onExpected={setExpected} workspaceId={workspaceId} job={job} caseId={caseId} round={0} canCancel={false} busy={busy} onCancel={onCancel} onRound={() => {}} onClose={onClose} />
        {after ? <EvaluationRunDetail key={`${job.id}:${caseId}:${after}`} embedded workspaceId={workspaceId} job={job} caseId={caseId} round={after} canCancel={false} busy={busy} onCancel={onCancel} onRound={setSelected} onClose={onClose} />
          : <section aria-label={tr('comparison.after')} className="flex h-full flex-col border-l border-border"><h3 className="border-b border-border p-4 font-semibold">{tr('comparison.after')}</h3><p className="p-6 text-sm text-muted-foreground">{tr('comparison.pending')}</p></section>}
      </div></div>
    </div>
  </div>, document.body);
}
