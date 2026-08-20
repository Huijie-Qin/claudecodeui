function finiteCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

export function getActiveWorkCount(summary = {}) {
  const activeProviderCommands = Object.values(summary.providerCommands || {})
    .reduce((total, count) => total + finiteCount(count), 0);
  const activeProviderSessions = Object.values(summary.providerSessions || {})
    .reduce((total, count) => total + finiteCount(count), 0);

  return Math.max(activeProviderCommands, activeProviderSessions)
    + finiteCount(summary.shell)
    + finiteCount(summary.agentGraph)
    + finiteCount(summary.topSkillJobs);
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

export async function waitForActiveWorkToDrain({
  readSummary,
  timeoutMs,
  pollIntervalMs,
  now = () => Date.now(),
  sleep = defaultSleep,
  onWait = () => {},
}) {
  const startedAt = now();

  while (true) {
    const summary = readSummary();
    const activeCount = getActiveWorkCount(summary);
    if (activeCount === 0) return { drained: true, summary };
    if (now() - startedAt >= timeoutMs) return { drained: false, summary };

    onWait(summary);
    await sleep(pollIntervalMs);
  }
}

export function getRemainingShutdownTime(deadlineMs, now = () => Date.now()) {
  return Math.max(0, deadlineMs - now());
}

export async function waitForPromiseUntilDeadline(promise, {
  deadlineMs,
  now = () => Date.now(),
  sleep = defaultSleep,
}) {
  const remainingMs = getRemainingShutdownTime(deadlineMs, now);
  if (remainingMs === 0) return { completed: false };

  return Promise.race([
    Promise.resolve(promise).then((value) => ({ completed: true, value })),
    sleep(remainingMs).then(() => ({ completed: false })),
  ]);
}
