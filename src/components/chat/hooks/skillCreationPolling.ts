export const isSkillCreationActive = (job: { status: string }) =>
  ['queued', 'selecting', 'generating', 'saving', 'cancelling'].includes(job.status);

export function startSkillCreationPolling<Job extends { status: string }>({ load, receive, onError, delay,
  schedule = setTimeout, cancel = clearTimeout,
}: {
  load: () => Promise<Job[]>;
  receive: (jobs: Job[]) => void;
  onError: (error: unknown) => void;
  delay: () => number;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
}) {
  let stopped = false, failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll() {
    if (stopped) return;
    let again = false;
    try {
      const jobs = await load();
      if (stopped) return;
      failures = 0;
      receive(jobs);
      again = jobs.some(isSkillCreationActive);
    } catch (error) {
      if (stopped) return;
      onError(error);
      const status = (error as { status?: number })?.status;
      again = ++failures < 3 && (!status || status >= 500 || status === 408 || status === 429);
    }
    if (!stopped && again) timer = schedule(() => { void poll(); }, delay());
  }
  void poll();
  return () => { stopped = true; if (timer !== undefined) cancel(timer); };
}
