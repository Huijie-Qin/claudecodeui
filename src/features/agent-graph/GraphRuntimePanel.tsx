import { Activity, CheckCircle2, Clock3, OctagonX, Square, X, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';

import type { AgentGraphRun, AgentGraphRunAgentStatus, AgentGraphRunStatus } from './types';

type GraphRuntimePanelProps = {
  run: AgentGraphRun;
  recentRuns: AgentGraphRun[];
  canManage: boolean;
  onSelectRun: (run: AgentGraphRun) => void;
  onCancel: () => void;
  onClose: () => void;
};

const ACTIVE_STATUSES = new Set<AgentGraphRunStatus>(['queued', 'running', 'cancelling']);

function StatusIcon({ status, className = 'h-4 w-4' }: { status: AgentGraphRunStatus | AgentGraphRunAgentStatus; className?: string }) {
  if (status === 'completed') return <CheckCircle2 className={`${className} text-emerald-500`} />;
  if (status === 'failed') return <XCircle className={`${className} text-destructive`} />;
  if (status === 'cancelled') return <OctagonX className={`${className} text-muted-foreground`} />;
  if (status === 'running') return <Activity className={`${className} text-primary`} />;
  return <Clock3 className={`${className} text-amber-500`} />;
}

function formatTime(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function stringifyPayload(value: unknown) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function TracePayload({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="mt-2 overflow-hidden rounded-md border border-border bg-muted/20">
      <p className="border-b border-border px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words p-2.5 text-[11px] leading-5 text-foreground">{stringifyPayload(value)}</pre>
    </div>
  );
}

export default function GraphRuntimePanel({
  run,
  recentRuns,
  canManage,
  onSelectRun,
  onCancel,
  onClose,
}: GraphRuntimePanelProps) {
  const { t } = useTranslation('agentGraph');
  const trace = [...run.trace];
  const iteration = run.context.iteration || 0;
  const schedulingIterations = [...new Set(trace
    .map((event) => event.iteration)
    .filter((value): value is number => typeof value === 'number' && value > 0))]
    .sort((left, right) => left - right)
    .map((iterationNumber) => {
      const events = trace.filter((event) => event.iteration === iterationNumber);
      return {
        iteration: iterationNumber,
        iterationStarted: events.find((event) => event.type === 'iteration_started'),
        activationDecision: events.find((event) => event.type === 'activation_decision'),
        activationReconsidered: events.filter((event) => event.type === 'activation_reconsidered'),
        agentStarted: events.find((event) => event.type === 'agent_started'),
        contextUpdated: events.find((event) => event.type === 'context_updated'),
        completionDecision: events.find((event) => event.type === 'completion_decision'),
      };
    });

  return (
    <aside className="flex h-full w-full max-w-[520px] shrink-0 flex-col border-l border-border bg-card shadow-xl">
      <div className="flex items-start justify-between border-b border-border px-4 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusIcon status={run.status} />
            <p className="text-xs font-medium uppercase tracking-wider text-primary">{t('runtime.title')}</p>
          </div>
          <h2 className="mt-1 truncate text-base font-semibold text-foreground">{run.graphName}</h2>
          <p className="text-xs text-muted-foreground">
            {t(`runtime.status.${run.status}`)} · {t('runtime.iteration', { count: iteration })} · {formatTime(run.createdAt)}
          </p>
        </div>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="border-b border-border px-4 py-3">
        <label className="block space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('runtime.history')}</span>
          <select
            value={run.id}
            onChange={(event) => {
              const selected = recentRuns.find((entry) => entry.id === event.target.value);
              if (selected) onSelectRun(selected);
            }}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            {recentRuns.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {t(`runtime.status.${entry.status}`)} · {t('runtime.iteration', { count: entry.context.iteration || 0 })} · {formatTime(entry.createdAt)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        {run.error ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{run.error}</p> : null}

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{t('runtime.userInput')}</h3>
          <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">{stringifyPayload(run.input)}</pre>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{t('runtime.agentStatus')}</h3>
          <div className="space-y-2">
            {run.agentStates.map((agent) => (
              <div key={agent.agentId} className="flex items-center gap-3 rounded-lg border border-border p-3">
                <StatusIcon status={agent.status} className="h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{agent.agentName}</p>
                  <p className="text-xs text-muted-foreground">{t(`runtime.agent.${agent.status}`)} · {t('runtime.activationCount', { count: agent.activationCount })}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{t('runtime.scheduling')}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('runtime.schedulingDescription')}</p>
          </div>
          {schedulingIterations.length ? (
            <div className="space-y-3">
              {schedulingIterations.map((round) => {
                const schedulingInput = asRecord(round.iterationStarted?.input);
                const activationOutput = asRecord(round.activationDecision?.output);
                const contextUpdateOutput = asRecord(round.contextUpdated?.output);
                const completionOutput = asRecord(round.completionDecision?.output);
                const selectedAgent = round.agentStarted?.agentName
                  || round.activationDecision?.agentName
                  || String(activationOutput?.selectedAgentId || round.activationDecision?.agentId || '—');
                const task = round.activationDecision?.task || String(activationOutput?.task || '—');

                return (
                  <details
                    key={round.iteration}
                    className="rounded-lg border border-border bg-background"
                    open={round.iteration === iteration}
                  >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5">
                      <span className="text-xs font-semibold text-foreground">{t('runtime.schedulingRound', { count: round.iteration })}</span>
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">{selectedAgent}</span>
                    </summary>
                    <div className="space-y-3 border-t border-border px-3 py-3">
                      <dl className="grid gap-2 text-xs sm:grid-cols-[120px_minmax(0,1fr)]">
                        <dt className="text-muted-foreground">{t('runtime.selectedAgent')}</dt>
                        <dd className="font-medium text-foreground">{selectedAgent}</dd>
                        <dt className="text-muted-foreground">{t('runtime.scheduledTask')}</dt>
                        <dd className="whitespace-pre-wrap text-foreground">{task}</dd>
                        <dt className="text-muted-foreground">{t('runtime.selectionReason')}</dt>
                        <dd className="whitespace-pre-wrap text-foreground">{round.activationDecision?.message || '—'}</dd>
                      </dl>

                      {round.activationReconsidered.length ? (
                        <div className="rounded-md border border-amber-500/25 bg-amber-500/5 p-2.5 text-xs text-foreground">
                          <p className="font-medium">{t('runtime.activationReconsidered')}</p>
                          {round.activationReconsidered.map((event) => (
                            <p key={event.id} className="mt-1 whitespace-pre-wrap text-muted-foreground">{event.message}</p>
                          ))}
                        </div>
                      ) : null}

                      <details className="rounded-md border border-border bg-muted/10" open={round.iteration === iteration}>
                        <summary className="cursor-pointer px-2.5 py-2 text-xs font-medium text-foreground">{t('runtime.sharedContextBefore')}</summary>
                        <div className="border-t border-border p-2.5">
                          <TracePayload label={t('runtime.sharedContext')} value={schedulingInput?.context} />
                          <TracePayload label={t('runtime.availableAgents')} value={schedulingInput?.availableAgents} />
                          <TracePayload label={t('runtime.relations')} value={schedulingInput?.relations} />
                        </div>
                      </details>

                      {round.contextUpdated ? (
                        <details className="rounded-md border border-border bg-muted/10">
                          <summary className="cursor-pointer px-2.5 py-2 text-xs font-medium text-foreground">{t('runtime.contextUpdate')}</summary>
                          <div className="border-t border-border p-2.5">
                            <TracePayload label={t('runtime.outputResult')} value={contextUpdateOutput || round.contextUpdated.output} />
                          </div>
                        </details>
                      ) : null}

                      <div className="rounded-md border border-border bg-muted/10 p-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs font-medium text-foreground">{t('runtime.completionDecision')}</p>
                          <span className="text-[10px] font-medium text-muted-foreground">
                            {round.completionDecision
                              ? t(round.completionDecision.complete ? 'runtime.complete' : 'runtime.continue')
                              : t('runtime.notDecided')}
                          </span>
                        </div>
                        {round.completionDecision?.message ? <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{round.completionDecision.message}</p> : null}
                        <TracePayload label={t('runtime.outputResult')} value={completionOutput || round.completionDecision?.output} />
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
          ) : <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">{t('runtime.noScheduling')}</p>}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{t('runtime.context')}</h3>
          {run.context.findings.length ? (
            <div className="space-y-2">
              {run.context.findings.map((finding) => (
                <div key={finding.id} className="rounded-lg border border-border bg-background p-3">
                  <p className="text-xs font-medium text-primary">{finding.agentName}</p>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-foreground">{finding.content}</p>
                </div>
              ))}
            </div>
          ) : <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">{t('runtime.noFindings')}</p>}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{t('runtime.pendingQuestions')}</h3>
          {run.context.pendingQuestions?.length ? (
            <ul className="space-y-2">
              {run.context.pendingQuestions.map((question, index) => (
                <li key={`${question}-${index}`} className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs leading-5 text-foreground">
                  {question}
                </li>
              ))}
            </ul>
          ) : <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">{t('runtime.noPendingQuestions')}</p>}
        </section>

        {run.result ? (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{t('runtime.result')}</h3>
            <p className="whitespace-pre-wrap rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm leading-6 text-foreground">{run.result}</p>
          </section>
        ) : null}

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{t('runtime.trace')}</h3>
          <div className="space-y-4 border-l border-border pl-4">
            {trace.map((event) => (
              <div key={event.id} className="relative rounded-lg border border-border bg-background p-3">
                <span className="absolute -left-[21px] top-4 h-2.5 w-2.5 rounded-full border-2 border-card bg-primary" />
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-medium text-foreground">{t(`runtime.traceTypes.${event.type}`, { defaultValue: event.type })}</p>
                  {event.iteration ? (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                      {t('runtime.iteration', { count: event.iteration })}
                    </span>
                  ) : null}
                </div>
                {event.agentName ? <p className="mt-1 text-xs text-primary">{event.agentName}</p> : null}
                {event.message ? <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{event.message}</p> : null}
                <TracePayload label={t('runtime.inputParameters')} value={event.input} />
                <TracePayload label={t('runtime.outputResult')} value={event.output} />
                <p className="mt-2 text-[10px] text-muted-foreground">{formatTime(event.timestamp)}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      {canManage && ACTIVE_STATUSES.has(run.status) ? (
        <div className="border-t border-border p-4">
          <Button variant="outline" className="w-full text-destructive hover:bg-destructive/10" onClick={onCancel}>
            <Square className="mr-2 h-4 w-4" />
            {t('actions.stopRun')}
          </Button>
        </div>
      ) : null}
    </aside>
  );
}
