import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDown, CheckCircle2, Download, FileText, Loader2, Square, X } from 'lucide-react';

import { messageRowClassName } from '../../chat/view/subcomponents/messagePresentationStyles';
import { api } from '../../../utils/api';
import { Markdown } from '../../chat/view/subcomponents/Markdown';
import { MessageBody, MessageFooter, MessageHeader, UserMessageBubble } from '../../chat/view/subcomponents/MessagePresentation';
import { CollapsibleDisplay } from '../../chat/tools/components/CollapsibleDisplay';
import { SubagentContainer } from '../../chat/tools/components/SubagentContainer';
import { TextContent } from '../../chat/tools/components/ContentRenderers/TextContent';
import { ToolTraceFrame } from '../../chat/tools/components/ToolTraceFrame';

import { isActive, type CaseReport, type EvaluationJob } from './types';

type Event = CaseReport['evidence']['events'][number];
const button = 'inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50';
const markdown = 'prose prose-sm prose-gray min-w-0 max-w-none break-words dark:prose-invert [overflow-wrap:anywhere] prose-pre:max-w-full prose-pre:overflow-x-auto';

export default function EvaluationRunDetail({ workspaceId, job, caseId, round, canCancel, busy, onCancel, onRound, onClose, embedded = false, initial = false, onExpected }: {
  embedded?: boolean; initial?: boolean; onExpected?: (text: string) => void;
  workspaceId: number; job: EvaluationJob; caseId: number; round: number; canCancel: boolean; busy: boolean;
  onCancel: () => void; onRound: (round: number) => void; onClose: () => void;
}) {
  const { t } = useTranslation('common');
  const tr = (key: string, values: Record<string, unknown> = {}) => t(`skillEvaluation.${key}`, values) as string;
  const [report, setReport] = useState<CaseReport | null>(null), [error, setError] = useState('');
  const [following, setFollowing] = useState(true), [highlight, setHighlight] = useState('');
  const [navigation, setNavigation] = useState<{ ref: string } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [clock, setClock] = useState(Date.now());
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null), scroller = useRef<HTMLDivElement>(null), bottom = useRef<HTMLDivElement>(null);
  const follow = useRef(true), currentJob = useRef(job), mounted = useRef(true), close = useRef(onClose);
  currentJob.current = job; close.current = onClose;
  const targetId = (ref: string) => `evaluation-${job.id}-${round}-${caseId}-${ref}`;
  useEffect(() => {
    mounted.current = true;
    if (embedded) return () => { mounted.current = false; };
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { mounted.current = false; document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, [embedded]);
  useEffect(() => {
    if (embedded && !preview) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      if (preview) setPreview(null); else close.current();
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [preview, embedded]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let again = true;
      try {
        const response = await api.skillEvaluations.report(workspaceId, job.id, caseId, round);
        const value = await response.json();
        if (disposed) return;
        if (!response.ok) {
          if (response.status === 410) { setReport(null); again = false; throw new Error(tr('trace.replaced')); }
          if (response.status === 404 && isActive(currentJob.current)) { setError(''); }
          else { again = response.status >= 500; throw new Error(value.error || value.message || `HTTP ${response.status}`); }
        } else {
          setReport(value); setError(''); onExpected?.(value.testCase.expected_output);
          again = value.status === 'running';
        }
      } catch (e) { if (!disposed) setError((e as Error).message); }
      if (!disposed && again) timer = setTimeout(poll, document.hidden ? 10000 : 1500);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
    // The selected run owns this polling loop; incoming job updates must not reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, job.id, caseId, round]);
  const status = report?.status || job.rounds.find((r) => r.round === round)?.cases.find((c) => c.caseId === caseId)?.status || 'not_run';
  const running = status === 'running' && isActive(job);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [report?.evidence.events.length, report?.status, report?.phase, report?.evidence.artifacts.length]);
  useEffect(() => {
    if (preview) dialog.current?.querySelector('[data-artifact-preview]')?.scrollIntoView({ block: 'nearest' });
  }, [preview]);
  const jump = (ref: string) => {
    follow.current = false; setFollowing(false); setHighlight(ref); setNavigation({ ref });
    const parents: Record<string, boolean> = {};
    let event = report?.evidence.events.find((e) => e.id === ref);
    while (event && !parents[event.id]) {
      parents[event.id] = true;
      event = report?.evidence.events.find((e) => e.id === event?.parent);
    }
    setExpanded((current) => ({ ...current, ...parents }));
  };
  useEffect(() => {
    if (!navigation) return;
    // Wait for shared collapsible rows to finish opening before locating the evidence.
    const timer = setTimeout(() => {
      const element = document.getElementById(targetId(navigation.ref));
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element?.focus({ preventScroll: true });
    }, 220);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation]);
  async function artifact(name: string, show: boolean) {
    setFileBusy(true);
    try {
      const response = await api.skillEvaluations.artifact(workspaceId, job.id, caseId, round, name);
      if (!response.ok) { const value = await response.json(); throw new Error(value.error || value.message); }
      const blob = await response.blob();
      if (!mounted.current) return;
      if (show) {
        if (blob.size > 256 * 1024) throw new Error(tr('trace.previewLimit'));
        const text = await blob.text();
        if (mounted.current) setPreview({ name, text });
      } else {
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = name.split('/').pop() || name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setFileBusy(false); }
  }
  const events = report?.evidence.events || [];
  const byId = new Set(events.map((e) => e.id));
  const children = new Map<string, Event[]>();
  for (const event of events) if (event.parent && byId.has(event.parent)) children.set(event.parent, [...(children.get(event.parent) || []), event]);
  const mark = (ref: string) => highlight === ref ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : '';
  const eventType = (event: Event) => event.kind === 'tool_use' || event.kind === 'task_started' ? 'assistant' : event.role;
  function eventView(event: Event, depth = 0, previous?: Event): React.ReactNode {
    if (depth > 8) return null;
    const nested = children.get(event.id) || [];
    const text = event.input || event.text || '';
    const type = eventType(event), grouped = !!previous && eventType(previous) === type;
    const time = event.at ? new Date(event.at).toLocaleTimeString() : undefined;
    const expansion = { expanded: !!expanded[event.id], onExpandedChange: (open: boolean) => setExpanded((current) => ({ ...current, [event.id]: open })) };
    const nestedViews = <div className="space-y-3">{nested.map((e, i) => eventView(e, depth + 1, nested[i - 1]))}</div>;
    return <div key={event.id} id={targetId(event.id)} tabIndex={-1} className={`min-w-0 scroll-m-6 rounded-md outline-none ${mark(event.id)}`}>
      <div className={messageRowClassName(type, grouped)}>
        {event.kind === 'tool_result' || event.kind === 'task_completed' ? <div className="min-w-0">
          <CollapsibleDisplay toolName={event.tool || tr('roles.tool')} title={tr(event.isError ? 'trace.toolError' : 'trace.toolResult')} stickyHeader={false} {...expansion}>
            <TextContent content={text} format="code" />
          </CollapsibleDisplay>
        </div> : event.role === 'user' ? <UserMessageBubble content={text} grouped={grouped} footer={<MessageFooter role="user" content={text} time={time} />} /> : <div className="w-full min-w-0">
          {!grouped && <MessageHeader label={tr('roles.assistant')} />}
          {event.kind === 'task_started' ? <SubagentContainer
            toolId={event.id} toolInput={{ description: text, prompt: text }} {...expansion}
            subagentState={{ childTools: nested.filter((e) => e.kind === 'tool_use').map((e) => ({ toolId: e.id, toolName: e.tool || '', toolInput: { command: e.input || '' }, timestamp: new Date(e.at || report?.startedAt || 0) })), currentToolIndex: -1, isComplete: nested.some((e) => e.kind === 'task_completed') }}
          >{nestedViews}</SubagentContainer> : event.kind === 'tool_use' ? <ToolTraceFrame command={event.tool === 'shell' || event.tool === 'Bash'}>
            <CollapsibleDisplay toolName={event.tool || tr('roles.tool')} title={text.slice(0, 80)} stickyHeader={false} {...expansion}
              badge={running && !nested.some((e) => e.kind === 'tool_result') ? <Loader2 className="h-3 w-3 animate-spin" /> : undefined}>
              <TextContent content={text} format="code" />{nestedViews}
            </CollapsibleDisplay>
          </ToolTraceFrame> : <div className="text-sm text-gray-700 dark:text-gray-300"><MessageBody content={text} /></div>}
          {event.kind !== 'tool_use' && event.kind !== 'task_started' && <MessageFooter content={text} time={time} />}
        </div>}
      </div>
    </div>;
  }
  const elapsed = report?.startedAt ? Math.max(0, Math.floor(((report.completedAt ? Date.parse(report.completedAt) : clock) - Date.parse(report.startedAt)) / 1000)) : null;
  const references = new Set([...events.map((e) => e.id), ...(report?.evidence.artifacts || []).map((a) => `artifact:${a.name}`), ...(report?.testCase.files || []).map((f) => `input:${f}`)]);
  const panel = <div ref={dialog} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-label={embedded ? tr(initial ? 'before' : 'after', { round }) : tr('trace.title')} className={`flex h-full w-full min-w-0 flex-col border-l border-border bg-background text-foreground ${embedded ? '' : 'max-w-3xl shadow-2xl'}`} onKeyDown={(e) => {
      if (!embedded && e.key === 'Tab') {
        const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select, summary, a[href], [tabindex="0"]') || []).filter((el) => el.getClientRects().length);
        const first = elements[0], last = elements.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
      <header className="shrink-0 space-y-3 border-b border-border px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">{embedded ? tr(initial ? 'before' : 'after', { round }) : `${tr('trace.title')} · #${caseId}`} </h2><div className="ml-auto flex shrink-0 gap-2">
          {canCancel && <button type="button" className={button} disabled={busy || job.status === 'cancelling'} onClick={onCancel}><Square className="h-4 w-4" />{tr('trace.stopRun')}</button>}
          {!embedded && <button type="button" className={button} aria-label={tr('close')} onClick={onClose}><X className="h-4 w-4" /></button>}
        </div></div>
        <div className="flex min-h-8 flex-wrap items-center gap-3 text-xs text-muted-foreground"><span role="status" className="inline-flex items-center gap-2">{running && <Loader2 className="h-3 w-3 animate-spin" />}{tr(`states.${status}`)}{running && ` · ${tr(`trace.${report?.phase === 'grading' ? 'grading' : 'executing'}`)}`}</span>{elapsed !== null && <span>{tr('trace.elapsed', { seconds: elapsed })}</span>}
          {!initial && <label className="ml-auto">{tr('round')} <select aria-label={tr('round')} className="min-h-8 max-w-full rounded-md border border-border bg-background py-1 pl-2 pr-8 text-xs" value={round} onChange={(e) => onRound(Number(e.target.value))}>{job.rounds.filter((r) => !embedded || r.round > 0).map((r) => <option key={r.round} value={r.round} disabled={!r.cases.some((c) => c.caseId === caseId && c.status !== 'not_run')}>{r.round === 0 ? tr('before') : tr('after', { round: r.round })}</option>)}</select></label>}
        </div>
      </header>
      {error && <div role="alert" className="shrink-0 border-b border-border bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">{error}</div>}
      <div ref={scroller} className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain" onScroll={() => {
        const el = scroller.current;
        if (el) { const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60; follow.current = atBottom; setFollowing(atBottom); }
      }}>
        <div className="min-w-0 space-y-5 px-4 py-5 sm:px-6">
          {!report ? <p className="py-10 text-center text-sm text-muted-foreground">{!error && tr('loading')}</p> : <>
            {!embedded && <details className="rounded-lg bg-muted/40 p-3 text-sm"><summary className="cursor-pointer font-medium">{tr('expected')}</summary><p className="mt-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{report.testCase.expected_output}</p></details>}
            {(report.testCase.files || []).map((file) => <div key={file} tabIndex={-1} id={targetId(`input:${file}`)} className={`break-all rounded-lg border border-border p-3 text-sm ${mark(`input:${file}`)}`}>{tr('trace.input')} · {file}</div>)}
            {!events.some((e) => e.role === 'user') && eventView({ id: 'scenario', seq: 0, role: 'user', kind: 'text', text: report.testCase.prompt })}
            <div className="space-y-3 sm:space-y-4">{events.filter((e) => !e.parent || !byId.has(e.parent)).map((e, i, siblings) => eventView(e, 0, siblings[i - 1]))}</div>
            {report.reason && <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:bg-red-950/30 dark:text-red-200">{report.reason}</div>}
            {report.evidence.artifacts.length > 0 && <section className="space-y-3"><h3 className="text-sm font-semibold">{tr('trace.artifacts')}</h3>{report.evidence.artifacts.map((a) => <div key={a.name} tabIndex={-1} id={targetId(`artifact:${a.name}`)} className={`flex flex-wrap items-center gap-3 rounded-xl border border-border p-4 ${mark(`artifact:${a.name}`)}`}><FileText className="h-5 w-5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 break-all text-sm">{a.name}</span>{a.supported && <button type="button" className={button} disabled={fileBusy} onClick={() => void artifact(a.name, true)}>{tr('trace.preview')}</button>}<button type="button" className={button} disabled={fileBusy} aria-label={`${tr('download')} ${a.name}`} onClick={() => void artifact(a.name, false)}><Download className="h-4 w-4" /></button></div>)}</section>}
            {preview && <section data-artifact-preview className="rounded-xl border border-border p-4"><div className="mb-4 flex items-center justify-between gap-2"><h3 className="break-all text-sm font-semibold">{preview.name}</h3><button type="button" className={button} onClick={() => setPreview(null)}>{tr('close')}</button></div>{/\.md$/i.test(preview.name) ? <Markdown className={markdown}>{preview.text}</Markdown> : <pre className="overflow-auto whitespace-pre-wrap break-words text-xs leading-5 [overflow-wrap:anywhere]">{preview.text}</pre>}</section>}
            {report.checks.length > 0 && <section className="space-y-3 rounded-xl border border-border p-4"><h3 className="flex items-center gap-2 font-semibold"><CheckCircle2 className="h-4 w-4" />{tr('trace.verdict')}</h3>{report.checks.map((check) => <div key={check.id} className="rounded-lg bg-muted/40 p-3 text-sm"><p className={check.status === 'passed' ? 'font-medium text-green-700 dark:text-green-400' : 'font-medium text-amber-700 dark:text-amber-400'}>{tr(`states.${check.status}`)}</p><p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{check.reason}</p><div className="mt-3 flex flex-wrap gap-2">{check.evidenceRefs.map((ref) => <button type="button" key={ref} disabled={!references.has(ref)} className="max-w-full break-all rounded border border-border px-2 py-1 text-left text-xs text-primary hover:bg-accent disabled:opacity-50" onClick={() => jump(ref)}>{tr('trace.evidence')} · {ref}</button>)}</div></div>)}</section>}
            {running && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{tr(report.phase === 'grading' ? 'trace.grading' : 'trace.waiting')}</p>}
          </>}
          <div ref={bottom} />
        </div>
      </div>
      {!following && <div className="flex shrink-0 justify-center border-t border-border p-2"><button type="button" className={button} onClick={() => { follow.current = true; setFollowing(true); if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }}><ArrowDown className="h-4 w-4" />{tr('trace.latest')}</button></div>}
    </div>;
  return embedded ? panel : createPortal(<div className="fixed inset-0 z-[10050] flex justify-end bg-black/40" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>{panel}</div>, document.body);
}
