import { Worker } from 'node:worker_threads';
import path from 'node:path';

import { getAiUsageSchedule, readAiUsageConfig } from './ai-usage-config.js';

export function createAiUsageService({ database, databasePath = database.name, env = process.env,
  now = () => new Date(), logger = console, workerFactory = (options) => new Worker(new URL('./ai-usage-worker.js', import.meta.url), options) }) {
  let config;
  let configurationError = null;
  try { config = readAiUsageConfig(env); } catch (error) {
    configurationError = error.message;
    config = readAiUsageConfig({});
    logger.error(`[AI usage] Statistics disabled: ${configurationError}`);
  }
  let timer = null;
  let worker = null;
  let state = config.enabled ? 'waiting' : 'disabled';
  let nextAttempt = 0;

  function getStatus() {
    return { enabled: config.enabled, runAt: config.runAt, windowEnd: config.windowEnd,
      timeZone: config.timeZone, nextRunAt: config.enabled ? getAiUsageSchedule(config, now()).nextRunAt : null,
      state, configurationError };
  }

  function tick() {
    if (!config.enabled || worker || now().getTime() < nextAttempt) return;
    const schedule = getAiUsageSchedule(config, now());
    if (!schedule.inWindow) return;
    // Only reached inside the idle window. No history API, message directory,
    // or database query is touched by daytime ticks.
    const pending = database.prepare(`SELECT 1 FROM tenants t WHERE t.status='active' AND (
      NOT EXISTS(SELECT 1 FROM ai_usage_batches b WHERE b.tenant_id=t.id AND b.scheduled_for=? AND b.status='published')
      OR EXISTS(SELECT 1 FROM ai_usage_batches b WHERE b.tenant_id=t.id AND b.status IN ('paused','failed','running'))
    ) LIMIT 1`).get(schedule.scheduledFor);
    if (!pending) return;
    worker = workerFactory({ workerData: { databasePath: path.resolve(databasePath), config } });
    state = 'running';
    worker.on('message', (message) => {
      if (message.type === 'error' || message.result?.status === 'partial_failure') {
        state = 'failed'; nextAttempt = now().getTime() + 5 * 60_000;
        logger.error('[AI usage] Nightly statistics failed', message.error || message.result.errors);
      } else if (message.type === 'result') state = message.result.status === 'paused' ? 'paused' : 'waiting';
    });
    worker.on('error', (error) => { state = 'failed'; nextAttempt = now().getTime() + 5 * 60_000; logger.error('[AI usage]', error); });
    worker.on('exit', () => { worker = null; if (state === 'running') state = 'waiting'; });
  }

  return { config, getStatus, tick,
    start() {
      if (timer || !config.enabled) return;
      timer = setInterval(() => { try { tick(); } catch (error) { logger.error('[AI usage] Scheduler check failed', error); } }, config.tickMs);
      timer.unref?.();
      try { tick(); } catch (error) { logger.error('[AI usage] Scheduler check failed', error); }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      worker?.postMessage({ type: 'stop' });
    },
  };
}
