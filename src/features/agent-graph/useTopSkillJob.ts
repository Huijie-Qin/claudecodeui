import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  TopSkillJob,
  TopSkillJobInput,
  TopSkillOperation,
  TopSkillResponse,
} from './types';

type UseTopSkillJobOptions = {
  startJob: (operation: TopSkillOperation, input: TopSkillJobInput) => Promise<TopSkillJob>;
  getJob: (jobId: string) => Promise<TopSkillJob>;
  onCompleted: (result: TopSkillResponse, operation: TopSkillOperation) => void;
};

const ACTIVE_STATUSES = new Set<TopSkillJob['status']>(['queued', 'running']);
const POLL_INTERVAL_MS = 1_200;

export function useTopSkillJob({ startJob, getJob, onCompleted }: UseTopSkillJobOptions) {
  const [job, setJob] = useState<TopSkillJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onCompletedRef = useRef(onCompleted);
  const jobId = job?.id;
  const jobStatus = job?.status;

  useEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  useEffect(() => {
    if (!jobId || !jobStatus || !ACTIVE_STATUSES.has(jobStatus)) return undefined;
    let disposed = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const latest = await getJob(jobId);
        if (disposed) return;
        setJob(latest);
        if (ACTIVE_STATUSES.has(latest.status)) {
          timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
          return;
        }
        if (latest.status === 'succeeded' && latest.result) {
          onCompletedRef.current(latest.result, latest.operation);
          return;
        }
        setError(latest.error || 'Top Skill job failed.');
      } catch (pollError) {
        if (disposed) return;
        setError(pollError instanceof Error ? pollError.message : 'Could not read the Top Skill job.');
        setJob((current) => current ? { ...current, status: 'failed' } : current);
      }
    };

    timer = window.setTimeout(() => void poll(), 400);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [getJob, jobId, jobStatus]);

  const start = useCallback(async (operation: TopSkillOperation, input: TopSkillJobInput) => {
    setError(null);
    try {
      const nextJob = await startJob(operation, input);
      setJob(nextJob);
      return nextJob;
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Could not start the Top Skill job.');
      throw startError;
    }
  }, [startJob]);

  const reset = useCallback(() => {
    setJob(null);
    setError(null);
  }, []);

  return {
    job,
    error,
    active: Boolean(job && ACTIVE_STATUSES.has(job.status)),
    start,
    reset,
  };
}
