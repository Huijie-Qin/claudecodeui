import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Play, Square, Wand2, X } from 'lucide-react';

import { api } from '../../../utils/api';
import { createClientMessageId as createRequestId } from '../../../utils/clientMessageId';

import EvaluationComparison from './EvaluationComparison';
import EvaluationRunDetail from './EvaluationRunDetail';
import ClampedCaseText from './ClampedCaseText';
import AddCaseMenu from './AddCaseMenu';
import TestFilesUpload from './TestFilesUpload';
import { acceptLatest, isActive, type CaseData, type EvalCase, type EvaluationJob } from './types';

const button = 'inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50';
const field = 'w-full rounded-md border border-border bg-background p-2 text-sm';
async function payload(response: Response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || value.message || `HTTP ${response.status}`);
  return value;
}

export default function SkillEvaluationPanel({ workspaceId, name, canManage, onFilesChanged }: {
  workspaceId: number; name: string; canManage: boolean; onFilesChanged: () => void;
}) {
  const { t } = useTranslation('common');
  const tr = (key: string, values: Record<string, unknown> = {}) => t(`skillEvaluation.${key}`, values) as string;
  const [data, setData] = useState<CaseData | null>(null), [job, setJob] = useState<EvaluationJob | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<EvalCase | null>(null), [editorRevision, setEditorRevision] = useState('');
  const [optimizeOpen, setOptimizeOpen] = useState(false), [maxIterations, setMaxIterations] = useState('3');
  const [detail, setDetail] = useState<{ jobId: string; caseId: number; round: number } | null>(null);
  const [diff, setDiff] = useState<{ writebackStatus: string; files: Array<{ name: string; before: string; after: string }> } | null>(null);
  const live = useRef(true), latestJob = useRef<EvaluationJob | null>(null);
  const uploading = useRef(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const generationJob = useRef<EvaluationJob | null>(null);
  const editable = canManage && data?.canManage !== false;
  const receive = useCallback((next: EvaluationJob | null) => {
    if (!live.current) return;
    const accepted = acceptLatest(latestJob.current, next);
    if (accepted?.id !== latestJob.current?.id) { setDetail(null); setDiff(null); }
    latestJob.current = accepted; setJob(accepted);
  }, []);
  const refreshCases = useCallback(async () => {
    const value = await payload(await api.skillEvaluations.cases(workspaceId, name));
    if (live.current) { setData(value); generationJob.current = value.generationJob || null; }
  }, [workspaceId, name]);
  const refreshLatest = useCallback(async () => {
    const value = await payload(await api.skillEvaluations.latest(workspaceId, name));
    const previous = latestJob.current;
    receive(value.job);
    if (generationJob.current) {
      const task = await payload(await api.skillEvaluations.job(workspaceId, generationJob.current.id));
      if (!isActive(task.job)) { if (task.job.error) setError(task.job.error); await refreshCases(); }
    }
    if (isActive(previous) && !isActive(value.job)) { await refreshCases(); }
  }, [workspaceId, name, receive, refreshCases]);
  const pollingActive = isActive(job) || !!data?.generationJob;
  useEffect(() => {
    live.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    const poll = async () => {
      try { await refreshLatest(); } catch (e) { if (live.current) setError((e as Error).message); }
      if (!disposed && live.current) timer = setTimeout(poll, document.hidden ? 30000 : (isActive(latestJob.current) || generationJob.current) ? 2000 : 8000);
    };
    void refreshCases().catch((e: Error) => { if (live.current) setError(e.message); });
    void poll();
    const focus = () => { void Promise.all([refreshCases(), refreshLatest()]).catch((e: Error) => setError(e.message)); };
    window.addEventListener('focus', focus);
    return () => { disposed = true; live.current = false; clearTimeout(timer); window.removeEventListener('focus', focus); };
  }, [refreshCases, refreshLatest, pollingActive]);
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); } catch (e) { if (live.current) setError((e as Error).message); }
    finally { if (live.current) setBusy(false); }
  }
  function edit(item?: EvalCase) {
    setEditor(item ? structuredClone(item) : { id: 0, prompt: '', expected_output: '', files: [], expectations: [] });
    setEditorRevision(data?.revision || '');
  }
  async function uploadInputs(files: File[]) {
    if (busy || uploading.current) return;
    uploading.current = true;
    try {
      await act(async () => {
        const failures: string[] = [];
        for (const [index, file] of files.entries()) {
          setUploadProgress({ current: index + 1, total: files.length });
          try {
            const form = new FormData(); form.append('fileName', file.name); form.append('file', file);
            const result = await payload(await api.skillEvaluations.upload(workspaceId, name, form));
            if (!live.current) return;
            setEditor((current) => current ? { ...current, files: [...(current.files || []), result.path] } : null);
          } catch { failures.push(file.name); }
          if (!live.current) return;
        }
        if (failures.length) throw new Error(tr('testFiles.failed', { names: failures.join('、') }));
      });
    } finally { uploading.current = false; if (live.current) setUploadProgress(null); }
  }
  async function start(mode: 'run-all' | 'optimize') {
    if (!data) return;
    await act(async () => {
      const result = await payload(await api.skillEvaluations.start(workspaceId, name, {
        mode, requestId: createRequestId(), expectedContentHash: data.contentHash, expectedEvalsRevision: data.revision,
        ...(mode === 'optimize' ? { maxIterations: Number(maxIterations) } : {}),
      }));
      receive(result.job); setOptimizeOpen(false);
    });
  }
  function showReport(caseId: number) {
    if (!job) return;
    setDetail({ jobId: job.id, caseId, round: job.rounds.at(-1)?.round ?? 0 });
  }
  const generating = !!data?.generationJob;
  const active = isActive(job), latestRound = job?.rounds.at(-1);
  return <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-lg font-semibold">{tr('title')}</h2><p className="mt-1 text-xs text-muted-foreground">{tr('latestOnly')}</p></div>
      <div className="flex flex-wrap gap-2">
        <AddCaseMenu disabled={!editable || busy || !data} aiDisabled={active || generating} onManual={() => edit()} onAi={() => void act(async () => { const accepted = await payload(await api.skillEvaluations.generate(workspaceId, name, data?.revision)); let task = accepted.job; await refreshCases(); while (live.current && ['queued', 'running', 'cancelling'].includes(task.status)) { await new Promise((resolve) => setTimeout(resolve, 1500)); if (!live.current) return; task = (await payload(await api.skillEvaluations.job(workspaceId, task.id))).job; } if (task.status !== 'completed') throw new Error(task.error || task.stopReason); await refreshCases(); onFilesChanged(); })} />
        <button type="button" className={button} disabled={!editable || busy || active || generating || !data?.document.evals.length} onClick={() => void start('run-all')}><Play className="h-4 w-4" />{tr('run')}</button>
        <button type="button" className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`} disabled={!editable || busy || active || generating || !data?.document.evals.length} onClick={() => setOptimizeOpen(true)}><Wand2 className="h-4 w-4" />{tr('optimize')}</button>
      </div>
    </div>
    {error && <div role="alert" className="mb-4 flex items-start justify-between gap-3 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{error}<button type="button" aria-label={tr('close')} onClick={() => setError('')}><X className="h-4 w-4" /></button></div>}
    {busy && <div role="status" className="mb-3 flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{tr('working')}</div>}
    {generating && <div role="status" className="mb-4 flex items-center justify-between rounded border border-border p-3 text-sm"><span>{tr('generating')}</span>{editable && <button type="button" className={button} onClick={() => void (async () => { try { await payload(await api.skillEvaluations.cancel(workspaceId, data!.generationJob!.id)); await refreshCases(); } catch (e) { setError((e as Error).message); } })()}>{tr('stop')}</button>}</div>}
    {job && <div className="mb-5 space-y-2 rounded-lg border border-border bg-muted/30 p-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2"><strong>{tr(`states.${job.status}`)} · {tr(`states.${job.outcome}`)}</strong>
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          {job.mode === 'optimize' && job.iteration > 0 && <button type="button" className={button} disabled={busy} onClick={() => void act(async () => { const id = job.id; const result = await payload(await api.skillEvaluations.diff(workspaceId, id)); if (latestJob.current?.id === id) setDiff(result); })}>{tr('diff')}</button>}
          {active && editable && <button type="button" className={button} disabled={busy} onClick={() => void act(async () => { await payload(await api.skillEvaluations.cancel(workspaceId, job.id)); await refreshLatest(); })}><Square className="h-3 w-3" />{tr('stop')}</button>}
        </div>
      </div>
      <p className="text-sm">{tr('phase')}: {tr(`phases.${job.phase}`)} · {tr('progress', { done: latestRound?.cases.filter((c) => !['not_run', 'running'].includes(c.status)).length || 0, total: latestRound?.cases.length || data?.document.evals.length || 0 })}</p>
      {job.mode === 'optimize' && <p className="text-sm">{tr('iterations', { current: job.iteration, max: job.maxIterations })} · {tr(`writeback.${job.writebackStatus}`)}</p>}
      {active && <p className="text-xs text-muted-foreground">{tr('snapshotNotice')}</p>}
      {job.current === false && <p className="text-sm text-amber-700 dark:text-amber-400">{tr('stale')}</p>}
      {job.error && <p className="text-sm text-red-600 dark:text-red-400">{job.error}</p>}
      {job.stopReason && <p className="text-xs text-muted-foreground">{tr('stopReason')}: {tr(`reasons.${job.stopReason}`, { defaultValue: job.stopReason })}</p>}
    </div>}
    {!data ? <p role="status" className="text-sm text-muted-foreground">{tr('loading')}</p> : !data.document.evals.length ? <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">{tr('empty')}</div> : <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[650px] table-fixed text-left text-sm"><colgroup><col /><col /><col className="w-28" /><col className="w-64" /></colgroup><thead className="bg-muted/50"><tr>{['scenario', 'expected', 'result', 'actions'].map((k) => <th key={k} className="p-3 font-medium">{tr(k)}</th>)}</tr></thead>
        <tbody>{data.document.evals.map((item) => {
          const run = latestRound?.cases.find((c) => c.caseId === item.id);
          return <tr key={item.id} className="border-t border-border align-top"><td className="p-3"><ClampedCaseText text={item.prompt} /></td><td className="p-3"><ClampedCaseText text={item.expected_output} /></td>
            <td className="p-3"><ClampedCaseText text={tr(`states.${run?.status || 'not_run'}`)} /></td><td className="p-3"><div className="flex flex-wrap gap-2">
              <button type="button" className={button} disabled={!run || run.status === 'not_run'} onClick={() => void showReport(item.id)}>{tr('details')}</button>
              {editable && <><button type="button" className={button} disabled={busy} onClick={() => edit(item)}>{tr('edit')}</button><button type="button" className={button} disabled={busy || data.protectedIds.includes(item.id)} title={data.protectedIds.includes(item.id) ? tr('protected') : ''} onClick={() => void act(async () => { await payload(await api.skillEvaluations.deleteCase(workspaceId, name, item.id, data.revision)); await refreshCases(); onFilesChanged(); })}>{tr('delete')}</button></>}
            </div></td></tr>;
        })}</tbody></table>
    </div>}
    {latestRound && data && latestRound.cases.filter((c) => !data.document.evals.some((item) => item.id === c.caseId)).map((c) => <button key={c.caseId} type="button" className={`${button} mr-2 mt-3`} disabled={c.status === 'not_run'} onClick={() => void showReport(c.caseId)}>{tr('snapshotCase', { id: c.caseId })} · {tr(`states.${c.status}`)}</button>)}
    {editor && <div role="dialog" aria-modal="true" aria-label={tr('caseEditor')} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) setEditor(null); }}>
      <form className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl" onSubmit={(e) => { e.preventDefault(); void act(async () => { await payload(await api.skillEvaluations.saveCase(workspaceId, name, editor.id || null, { expectedRevision: editorRevision, case: { ...editor, expectations: editor.expectations?.filter((s) => s.trim()) } })); setEditor(null); await refreshCases(); await refreshLatest(); onFilesChanged(); }); }}>
        <header className="shrink-0 border-b border-border px-6 py-4"><h3 className="font-semibold">{tr('caseEditor')}</h3></header>
        <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-6">
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <label className="block text-sm">{tr('scenario')}<textarea autoFocus required rows={4} maxLength={50000} className={`${field} mt-1`} placeholder={tr('scenarioPlaceholder')} value={editor.prompt} onChange={(e) => setEditor({ ...editor, prompt: e.target.value })} /></label>
        <label className="block text-sm">{tr('expected')}<textarea required rows={4} maxLength={50000} className={`${field} mt-1`} placeholder={tr('expectedPlaceholder')} value={editor.expected_output} onChange={(e) => setEditor({ ...editor, expected_output: e.target.value })} /></label>
        <label className="block text-sm">{tr('expectations')}<textarea rows={3} className={`${field} mt-1`} placeholder={tr('expectationsPlaceholder')} value={(editor.expectations || []).join('\n')} onChange={(e) => setEditor({ ...editor, expectations: e.target.value.split('\n') })} /></label>
        <TestFilesUpload files={editor.files || []} busy={busy} progress={uploadProgress}
          onUpload={(files) => void uploadInputs(files)} onError={setError}
          onRemove={(file) => setEditor((current) => current ? { ...current, files: current.files?.filter((path) => path !== file) } : null)} />
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-6 py-4"><button type="button" className={button} disabled={busy} onClick={() => setEditor(null)}>{tr('cancel')}</button><button type="submit" className={`${button} bg-primary text-primary-foreground`} disabled={busy || !editor.prompt.trim() || !editor.expected_output.trim()}>{tr('save')}</button></footer>
      </form>
    </div>}
    {optimizeOpen && <div role="dialog" aria-modal="true" aria-label={tr('optimize')} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form className="w-full max-w-md space-y-4 rounded-xl border border-border bg-background p-6" onSubmit={(e) => { e.preventDefault(); void start('optimize'); }}>
        <h3 className="font-semibold">{tr('optimize')}</h3>{error && <p role="alert" className="text-sm text-red-600">{error}</p>}<p className="text-sm text-muted-foreground">{tr('optimizeNotice')}</p>
        <label className="block text-sm">{tr('maxIterations')}<input autoFocus required type="number" min={1} max={10} step={1} value={maxIterations} onChange={(e) => setMaxIterations(e.target.value)} className={`${field} mt-2`} /></label>
        <div className="flex justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={() => setOptimizeOpen(false)}>{tr('cancel')}</button><button type="submit" className={`${button} bg-primary text-primary-foreground`} disabled={busy || !Number.isInteger(Number(maxIterations)) || Number(maxIterations) < 1 || Number(maxIterations) > 10}>{tr('startOptimize')}</button></div>
      </form>
    </div>}
    {detail && job && job.mode === 'optimize' && <EvaluationComparison key={`${detail.jobId}:${detail.caseId}`} workspaceId={workspaceId} job={job} caseId={detail.caseId} canCancel={editable && active} busy={busy}
      onCancel={() => void act(async () => { await payload(await api.skillEvaluations.cancel(workspaceId, job.id)); await refreshLatest(); })} onClose={() => setDetail(null)} />}
    {detail && job && job.mode !== 'optimize' && <EvaluationRunDetail key={`${detail.jobId}:${detail.caseId}:${detail.round}`}
      workspaceId={workspaceId} job={job} caseId={detail.caseId} round={detail.round}
      canCancel={editable && active} busy={busy}
      onCancel={() => void act(async () => { await payload(await api.skillEvaluations.cancel(workspaceId, job.id)); await refreshLatest(); })}
      onRound={(round) => setDetail({ ...detail, round })}
      onClose={() => setDetail(null)} />}
    {diff && <div role="dialog" aria-modal="true" aria-label={tr('diff')} className="fixed inset-0 z-50 overflow-auto bg-background p-5">
      <div className="mb-4 flex justify-between gap-3"><h2 className="font-semibold">{tr('diff')} · {tr(`writeback.${diff.writebackStatus}`)}</h2><button type="button" className={button} onClick={() => setDiff(null)}>{tr('close')}</button></div>
      {!diff.files.length && <p>{tr('noChanges')}</p>}
      {diff.files.map((file) => <section key={file.name} className="mb-6"><h3 className="mb-2 break-all font-medium">{file.name}</h3><div className="overflow-x-auto"><div className="grid min-w-[700px] grid-cols-2 gap-3">{[file.before, file.after].map((text, i) => <pre key={i} className={`overflow-auto whitespace-pre-wrap break-words rounded border border-border p-4 text-xs ${i ? 'bg-green-50 dark:bg-green-950/30' : 'bg-red-50 dark:bg-red-950/30'}`}>{text}</pre>)}</div></div></section>)}
    </div>}
  </div>;
}
