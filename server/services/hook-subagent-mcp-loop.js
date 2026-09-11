import { setTimeout as delay } from 'node:timers/promises';

import {
  buildMcpLoopReplacement,
  evaluateMcpLoopResult,
  normalizeMcpLoopResult,
  normalizeTerminationScriptOutcome,
} from './mcp-loop-service.js';

const MAX_TIMER_MS = 2_147_483_000;

function awaitWithAbort(run, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return run();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function subagentHookTimeoutSeconds(hook) {
  if (hook.includeSubagents === false || hook.eventName !== 'PostToolUse') return 60;
  const loopBudget = (hook.postActions || []).reduce((total, action) => (
    action.type === 'mcp_loop_run'
      ? total + Math.max(0, Number(action.config?.maxWaitMs) || 2_700_000)
      : total
  ), 0);
  return Math.ceil(Math.min(MAX_TIMER_MS, 60_000 + loopBudget) / 1000);
}

/** Await only the originating subagent's tool; never suspend or resume its parent. */
export async function runSubagentMcpLoop({
  hook,
  action,
  event,
  input,
  signal,
  workspaceRoot,
  env,
  resolveTarget,
  mcpCaller,
  scriptExecutor,
  headersHelperRunner,
  onAttempt = async () => {},
  now = Date.now,
  sleep = (milliseconds, abortSignal) => delay(milliseconds, undefined, { signal: abortSignal }),
}) {
  if (!event?.agent_id || event.hook_event_name !== 'PostToolUse') {
    throw new Error('Inline MCP loops require a subagent PostToolUse event');
  }
  const config = action.config || {};
  const maxWaitMs = Math.min(MAX_TIMER_MS, Math.max(1, Number(config.maxWaitMs) || 2_700_000));
  const pollIntervalMs = Math.max(1, Number(config.pollIntervalMs) || 10_000);
  const perCallTimeoutMs = Math.max(1, Number(config.perCallTimeoutMs) || 15_000);
  const startedAtMs = now();
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal.reason || new Error('Subagent MCP loop cancelled'));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`MCP loop timed out after ${maxWaitMs} ms`));
  }, maxWaitMs);
  const initialResult = normalizeMcpLoopResult(event.tool_response);
  let lastResult = initialResult;
  let attemptCount = 0;
  let consecutiveErrors = 0;
  let outcome = 'running';
  let errorMessage;
  const assertActive = () => {
    if (now() - startedAtMs >= maxWaitMs && !signal?.aborted) {
      timedOut = true;
      controller.abort(new Error(`MCP loop timed out after ${maxWaitMs} ms`));
    }
    controller.signal.throwIfAborted();
  };
  const evaluate = async () => {
    assertActive();
    const scriptInput = {
      result: lastResult,
      initial_result: initialResult,
      inputs: input,
      attempt_count: attemptCount,
      elapsed_ms: Math.max(0, now() - startedAtMs),
      agent_id: event.agent_id,
      agent_type: event.agent_type,
    };
    let scriptOutput;
    const terminationOutcome = typeof config.terminationScript === 'string' && config.terminationScript.trim()
      ? normalizeTerminationScriptOutcome(scriptOutput = await awaitWithAbort(() => scriptExecutor({
        hookId: hook.id,
        language: 'python',
        code: config.terminationScript,
        event: scriptInput,
        env,
        workspaceRoot,
        signal: controller.signal,
        timeoutMs: Math.min(10_000, Math.max(1, maxWaitMs - (now() - startedAtMs))),
      }), controller.signal))
      : evaluateMcpLoopResult(lastResult, config);
    assertActive();
    await onAttempt({ attemptCount, outcome: terminationOutcome, scriptInput, scriptOutput });
    return terminationOutcome;
  };
  try {
    outcome = await evaluate();
    // Resolving a target can involve materialization; skip it for terminal initial results.
    const target = outcome === 'running' ? await awaitWithAbort(resolveTarget, controller.signal) : null;
    while (outcome === 'running') {
      assertActive();
      await sleep(Math.min(pollIntervalMs, maxWaitMs - (now() - startedAtMs)), controller.signal);
      assertActive();
      attemptCount += 1;
      try {
        lastResult = normalizeMcpLoopResult(await awaitWithAbort(() => mcpCaller({
          ...target,
          input,
          cwd: workspaceRoot,
          signal: controller.signal,
          timeoutMs: Math.min(perCallTimeoutMs, Math.max(1, maxWaitMs - (now() - startedAtMs))),
          headersHelperRunner,
        }), controller.signal));
        outcome = await evaluate();
        consecutiveErrors = 0;
      } catch (error) {
        assertActive();
        consecutiveErrors += 1;
        await onAttempt({ attemptCount, error: error?.message || String(error) });
        if (consecutiveErrors >= 3) throw error;
      }
    }
  } catch (error) {
    outcome = timedOut ? 'timed_out' : signal?.aborted ? 'cancelled' : 'failed';
    errorMessage = error?.message || String(error);
  } finally {
    clearTimeout(deadlineTimer);
    signal?.removeEventListener('abort', onAbort);
  }
  const completedAtMs = now();
  const { toolUseResult } = buildMcpLoopReplacement({
    toolUseId: event.tool_use_id,
    status: outcome,
    attemptCount,
    startedAtMs,
    completedAtMs,
    lastResult,
    error: errorMessage,
  }, completedAtMs);
  return {
    scheduled: false,
    deliveredTo: 'subagent',
    agentId: event.agent_id,
    status: outcome,
    attemptCount,
    elapsedMs: Math.max(0, completedAtMs - startedAtMs),
    initialResult,
    lastResult,
    toolUseResult,
    ...(errorMessage ? { error: errorMessage } : {}),
  };
}
