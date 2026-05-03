import { multitenancyDb } from '../database/multitenancy-db.js';
import {
  agentSessionRuntimeManager,
  DockerCliClient,
} from './agent-session-runtime.js';
import { resolveRuntimeMonitorConfig } from './runtime-monitor.js';

const ZERO_RESULT = { inspected: 0, stopped: 0, failed: 0 };

export function createRuntimeSweeper({
  config = resolveRuntimeMonitorConfig(),
  multitenancy = multitenancyDb,
  docker = new DockerCliClient(),
  runtimeManager = agentSessionRuntimeManager,
  logger = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let interval = null;
  let sweepInProgress = false;

  async function sweepOnce() {
    if (!config.enabled || sweepInProgress) {
      return { ...ZERO_RESULT };
    }

    sweepInProgress = true;
    const result = { inspected: 0, stopped: 0, failed: 0 };

    try {
      let candidates;
      try {
        candidates = await multitenancy.runtimes.listExpiredIdleRuntimes({
          olderThanMinutes: config.idleTimeoutMinutes,
          limit: 100,
        });
      } catch (error) {
        result.failed += 1;
        logger?.warn?.('runtime sweeper list failed', { error: error?.message });
        return result;
      }

      for (const runtime of candidates) {
        result.inspected += 1;
        try {
          const inspected = await docker.inspectContainer(runtime.container_name);
          if (!inspected?.running) {
            continue;
          }

          const stillExpiredIdle = await multitenancy.runtimes.findExpiredIdleRuntimeById({
            runtimeId: runtime.runtime_id,
            olderThanMinutes: config.idleTimeoutMinutes,
          });
          if (!stillExpiredIdle) {
            continue;
          }

          await runtimeManager.stopRuntime(runtime.runtime_id);
          result.stopped += 1;
          logger?.info?.('runtime sweeper stopped idle runtime', {
            runtimeId: runtime.runtime_id,
            containerName: runtime.container_name,
          });
        } catch (error) {
          result.failed += 1;
          logger?.warn?.('runtime sweeper failed runtime', {
            runtimeId: runtime.runtime_id,
            containerName: runtime.container_name,
            error: error?.message,
          });
        }
      }

      return result;
    } finally {
      sweepInProgress = false;
    }
  }

  function start() {
    if (!config.enabled || interval) {
      return;
    }

    interval = setIntervalFn(() => {
      void sweepOnce().catch((error) => {
        logger?.warn?.('runtime sweeper interval failed', { error: error?.message });
      });
    }, config.sweeperIntervalSeconds * 1000);
    interval?.unref?.();
  }

  function stop() {
    if (!interval) {
      return;
    }

    clearIntervalFn(interval);
    interval = null;
  }

  return {
    sweepOnce,
    start,
    stop,
  };
}

export const runtimeSweeper = createRuntimeSweeper();
