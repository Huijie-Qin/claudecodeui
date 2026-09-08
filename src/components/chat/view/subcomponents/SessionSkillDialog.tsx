import { useEffect, useRef, useState } from 'react';
import { BookOpenCheck, CheckCircle2, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../../auth/context/AuthContext';
import { useTenant } from '../../../../contexts/TenantContext';
import { Button, Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import type { LLMProvider } from '../../../../types/app';
import { api } from '../../../../utils/api';
import { dispatchSlashCommandsChanged } from '../../utils/slashCommandEvents';

type Operation = 'generate' | 'optimize';
type SessionSkillJob = {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'exhausted';
  phase: string;
  iteration: number;
  maxIterations: number;
  operation?: Operation;
  skillName?: string;
  error?: string;
  result?: {
    skillName: string;
    input: string;
    expectedOutput: string;
    actualOutput: string;
    passed: boolean;
    skillPath?: string;
    warning?: string;
    iterations: Array<{
      iteration: number;
      actualOutput: string;
      passed: boolean;
      feedback: string;
    }>;
  };
};

type SessionSkillDialogProps = {
  open: boolean;
  workspaceId: number;
  projectName: string;
  sessionId: string;
  provider: LLMProvider;
  sessionBusy: boolean;
  onClose: () => void;
};

const MAX_ITERATIONS = 3;
const POLL_INTERVAL_MS = 2_000;
const VALID_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function storeJobId(key: string, jobId: string | null) {
  try {
    if (jobId) window.sessionStorage.setItem(key, jobId);
    else window.sessionStorage.removeItem(key);
  } catch {
    // A disabled browser store should not prevent using the feature.
  }
}

function OutputSection({ label, text }: { label: string; text: string }) {
  return (
    <details className="rounded-md border border-border p-3" open>
      <summary className="cursor-pointer text-sm font-medium">{label}</summary>
      <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-muted-foreground">
        {text || '—'}
      </pre>
    </details>
  );
}

export default function SessionSkillDialog({
  open, workspaceId, projectName, sessionId, provider, sessionBusy, onClose,
}: SessionSkillDialogProps) {
  const { t } = useTranslation('chat');
  const { user } = useAuth();
  const { currentTenant } = useTenant();
  const storageKey = `session-skill-job:${user?.id}:${currentTenant?.id}:${workspaceId}:${provider}:${sessionId}`;
  const [operation, setOperation] = useState<Operation>('generate');
  const [skillName, setSkillName] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<SessionSkillJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitInFlightRef = useRef(false);
  const lastNotifiedJobRef = useRef<string | null>(null);
  const busy = submitting || Boolean(jobId && (!job || job.status === 'queued' || job.status === 'running'));

  useEffect(() => {
    setJob(null);
    setError(null);
    setSkillName('');
    setOperation('generate');
    try {
      setJobId(window.sessionStorage.getItem(storageKey));
    } catch {
      setJobId(null);
    }
  }, [storageKey]);

  useEffect(() => {
    if (!jobId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const response = await api.sessionSkillJobs.get(workspaceId, jobId);
        const payload = await response.json();
        if (disposed) return;
        if (!response.ok) {
          if ([401, 403, 404].includes(response.status)) {
            storeJobId(storageKey, null);
            setJobId(null);
          }
          throw new Error(payload?.error || t('sessionSkill.requestFailed'));
        }
        if (!payload.job?.id) throw new Error(t('sessionSkill.requestFailed'));
        const nextJob = payload.job as SessionSkillJob;
        setJob(nextJob);
        setError(null);
        if (nextJob.operation) setOperation(nextJob.operation);
        if (nextJob.skillName || nextJob.result?.skillName) {
          setSkillName(nextJob.skillName || nextJob.result?.skillName || '');
        }
        if (nextJob.status === 'succeeded' && lastNotifiedJobRef.current !== nextJob.id) {
          lastNotifiedJobRef.current = nextJob.id;
          dispatchSlashCommandsChanged({ workspaceId, projectName, reason: 'session-skill' });
        }
        if (nextJob.status !== 'queued' && nextJob.status !== 'running') return;
      } catch (caught) {
        if (disposed) return;
        setError(caught instanceof Error ? caught.message : t('sessionSkill.requestFailed'));
      }
      if (!disposed) timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [jobId, workspaceId, projectName, storageKey, t]);

  const startJob = async () => {
    if (busy || sessionBusy || submitInFlightRef.current) return;
    const name = skillName.trim();
    if (!VALID_SKILL_NAME.test(name) || name.length > 63) {
      setError(t('sessionSkill.invalidName'));
      return;
    }
    submitInFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const response = await api.sessionSkillJobs.create(workspaceId, {
        provider, sessionId, operation, skillName: name, maxIterations: MAX_ITERATIONS,
      });
      const payload = await response.json();
      if (!response.ok || !payload.job?.id) {
        throw new Error(payload?.error || t('sessionSkill.requestFailed'));
      }
      storeJobId(storageKey, payload.job.id);
      setJob(payload.job);
      setJobId(payload.job.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('sessionSkill.requestFailed'));
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const result = job?.result;
  const phase = job?.phase ? t(`sessionSkill.phases.${job.phase}`, { defaultValue: job.phase }) : '';

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden p-0" aria-labelledby="session-skill-title">
        <DialogTitle id="session-skill-title">{t('sessionSkill.title')}</DialogTitle>
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <BookOpenCheck className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-base font-semibold">{t('sessionSkill.title')}</h2>
              <p className="text-xs text-muted-foreground">{t('sessionSkill.subtitle')}</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('sessionSkill.close')}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="max-h-[calc(90vh-160px)] space-y-4 overflow-y-auto px-5 py-4">
          <p className="text-sm leading-relaxed text-muted-foreground">{t('sessionSkill.description')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span>{t('sessionSkill.operation')}</span>
              <select
                value={operation}
                onChange={(event) => setOperation(event.target.value as Operation)}
                disabled={busy}
                className="h-10 w-full rounded-md border border-input bg-background px-3 disabled:opacity-50"
              >
                <option value="generate">{t('sessionSkill.generate')}</option>
                <option value="optimize">{t('sessionSkill.optimize')}</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span>{t(operation === 'optimize' ? 'sessionSkill.existingName' : 'sessionSkill.name')}</span>
              <input
                value={skillName}
                onChange={(event) => setSkillName(event.target.value)}
                disabled={busy}
                maxLength={63}
                placeholder="sales-report"
                spellCheck={false}
                autoComplete="off"
                className="h-10 w-full rounded-md border border-input bg-background px-3 disabled:opacity-50"
              />
            </label>
          </div>
          <p className="rounded-md bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
            {t('sessionSkill.scope', { count: MAX_ITERATIONS })}
          </p>

          {(busy || job) && (
            <div role="status" className="flex items-center gap-2 rounded-md border border-border p-3 text-sm">
              {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : job?.status === 'succeeded' ? <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" /> : null}
              <div>
                <p>{job ? t(`sessionSkill.statuses.${job.status}`) : t('sessionSkill.loading')}</p>
                {busy && <p className="text-xs text-muted-foreground">{phase} · {t('sessionSkill.iteration', { current: job?.iteration || 0, total: job?.maxIterations || MAX_ITERATIONS })}</p>}
                {job?.status === 'succeeded' && <p className="text-xs text-muted-foreground">{t('sessionSkill.saved', { name: result?.skillName || skillName })}</p>}
              </div>
            </div>
          )}
          {(error || job?.error) && <p role="alert" className="text-sm text-destructive">{error || job?.error}</p>}
          {result?.warning && (
            <p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
              {result.warning}
            </p>
          )}
          {result && (
            <div className="space-y-3">
              <OutputSection label={t('sessionSkill.input')} text={result.input} />
              <OutputSection label={t('sessionSkill.expectedOutput')} text={result.expectedOutput} />
              <OutputSection label={t('sessionSkill.actualOutput')} text={result.actualOutput} />
              {result.iterations?.length > 0 && (
                <details className="rounded-md border border-border p-3">
                  <summary className="cursor-pointer text-sm font-medium">{t('sessionSkill.validation')}</summary>
                  <div className="mt-3 space-y-3">
                    {result.iterations.map((iteration) => (
                      <div key={iteration.iteration} className="space-y-1 text-xs">
                        <p className="font-medium">{t('sessionSkill.iteration', { current: iteration.iteration, total: job?.maxIterations || MAX_ITERATIONS })} · {t(iteration.passed ? 'sessionSkill.passed' : 'sessionSkill.notPassed')}</p>
                        <p className="whitespace-pre-wrap text-muted-foreground">{iteration.feedback}</p>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <p className="text-xs text-muted-foreground">{busy ? t('sessionSkill.background') : sessionBusy ? t('sessionSkill.waitForCompletion') : ''}</p>
          <Button onClick={() => void startJob()} disabled={busy || sessionBusy || !skillName.trim()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t(operation === 'generate' ? 'sessionSkill.startGenerate' : 'sessionSkill.startOptimize')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
