import crypto from 'node:crypto';

import { agentGraphRunStore } from './agent-graph-run-store.js';
import {
  AGENT_GRAPH_CLAUDE_RUNTIME_CONFIG,
  AGENT_GRAPH_MCP_BINDING_ALIASES,
  evaluateCompletionWithClaude,
  executeAgentWithClaude,
  selectAgentWithClaude,
} from './agent-graph-claude-runtime.js';

const ACTIVE_STATUSES = new Set(['queued', 'running', 'cancelling']);
const DEFAULT_MAX_ITERATIONS = 8;
const MAX_ITERATIONS = 20;
const MAX_CONSECUTIVE_AGENT_ACTIVATIONS = 3;
const MAX_STALE_ITERATIONS = 3;
const MAX_INPUT_BYTES = 50_000;
const MAX_TRACE_EVENTS = 500;
const MAX_TRACE_STRING_LENGTH = 32_000;
const SENSITIVE_FIELD_PATTERN = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)/i;

export function getAgentGraphExecutorConfig(maxIterations = DEFAULT_MAX_ITERATIONS) {
  return structuredClone({
    version: 3,
    executionModel: 'context-driven-collaboration-loop',
    relationSemantics: 'collaboration-and-capability-hints-only',
    communicationModel: 'shared-execution-context',
    activationPolicy: {
      mode: 'dynamic-agent-selection',
      evaluatedEveryIteration: true,
      considers: ['graph-goal', 'shared-context', 'agent-responsibility', 'top-skill', 'relations', 'activation-history'],
      relationIsExecutionEdge: false,
    },
    completionPolicy: {
      evaluatedAfterEveryAgentResult: true,
      controllerMayCallTools: false,
      controllerMaySynthesizeBusinessAnswer: true,
      finalResultSource: 'completion-controller-synthesis',
      requiresUserReadyDeliverable: true,
      skipsIrrelevantAgents: true,
    },
    safetyLimits: {
      maxIterations,
      defaultMaxIterations: DEFAULT_MAX_ITERATIONS,
      maximumConfigurableIterations: MAX_ITERATIONS,
      maxConsecutiveSameAgentActivations: MAX_CONSECUTIVE_AGENT_ACTIVATIONS,
      maxStaleIterations: MAX_STALE_ITERATIONS,
      maxTraceEvents: MAX_TRACE_EVENTS,
      maxInputBytes: MAX_INPUT_BYTES,
    },
    runtime: AGENT_GRAPH_CLAUDE_RUNTIME_CONFIG,
    toolBindingAliases: AGENT_GRAPH_MCP_BINDING_ALIASES,
    tracePolicy: {
      recordsStepInputAndOutput: true,
      redactsSensitiveValues: true,
      capturesAgentInternalReasoning: false,
      capturesGraphControlPlane: true,
    },
  });
}

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function timestamp(now) {
  return new Date(now()).toISOString();
}

function normalizeUserInput(value) {
  if (value === undefined || value === null || value === '') {
    throw createHttpError('input is required');
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw createHttpError('input must be JSON serializable');
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_INPUT_BYTES) {
    throw createHttpError(`input must be at most ${MAX_INPUT_BYTES} bytes`);
  }
  return structuredClone(value);
}

function normalizeMaxIterations(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MAX_ITERATIONS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ITERATIONS) {
    throw createHttpError(`maxIterations must be an integer from 1 to ${MAX_ITERATIONS}`);
  }
  return parsed;
}

function redactSensitiveText(value) {
  return String(value)
    .replace(/((?:authorization\s*:\s*bearer|api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|token|password|secret)=)[^&#\s]+/gi, '$1[REDACTED]');
}

function sanitizeTraceValue(value, key = '', depth = 0, seen = new WeakSet()) {
  if (SENSITIVE_FIELD_PATTERN.test(key)) return '[REDACTED]';
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const sanitized = redactSensitiveText(value);
    return sanitized.length > MAX_TRACE_STRING_LENGTH
      ? `${sanitized.slice(0, MAX_TRACE_STRING_LENGTH)}\n...[truncated]`
      : sanitized;
  }
  if (depth >= 8) return '[max depth reached]';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => sanitizeTraceValue(entry, key, depth + 1, seen));
  }
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([entryKey, entryValue]) => [
    entryKey,
    sanitizeTraceValue(entryValue, entryKey, depth + 1, seen),
  ]));
}

function contextSnapshot(context) {
  return structuredClone({
    executionId: context.executionId,
    goal: context.goal,
    userInput: context.userInput,
    findings: context.findings || [],
    agentResults: context.agentResults || [],
    pendingQuestions: context.pendingQuestions || [],
    iteration: context.iteration || 0,
    status: context.status,
  });
}

function normalizeAgentResult(response, agent) {
  if (response?.agentResult && typeof response.agentResult === 'object') return response.agentResult;
  const summary = String(response?.text || '').trim();
  return {
    agent: agent.name,
    summary,
    findings: summary ? [summary] : [],
    newQuestions: [],
    confidence: 0.5,
  };
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean))];
}

function countConsecutiveAgentResults(run, agentId) {
  let count = 0;
  for (let index = run.context.agentResults.length - 1; index >= 0; index -= 1) {
    if (run.context.agentResults[index].agentId !== agentId) break;
    count += 1;
  }
  return count;
}

function fallbackResult(run, message) {
  const latest = run.context.agentResults.at(-1);
  return latest?.summary || latest?.content || message;
}

function toPublicRun(run) {
  const { workspacePath, tenantId, userId, workspaceId, ...safe } = run;
  safe.context = safe.context || {};
  safe.context.pendingQuestions = Array.isArray(safe.context.pendingQuestions) ? safe.context.pendingQuestions : [];
  safe.context.iteration = Number(safe.context.iteration) || 0;
  safe.maxIterations = safe.maxIterations ?? safe.maxActivations ?? DEFAULT_MAX_ITERATIONS;
  safe.executorConfig = safe.executorConfig || getAgentGraphExecutorConfig(safe.maxIterations);
  return structuredClone(safe);
}

export function createAgentGraphExecutorService({
  store = agentGraphRunStore,
  selectAgent = selectAgentWithClaude,
  executeAgent = executeAgentWithClaude,
  evaluateCompletion = evaluateCompletionWithClaude,
  idFactory = () => crypto.randomUUID(),
  now = () => Date.now(),
  schedule = (callback) => queueMicrotask(callback),
} = {}) {
  const activeRuns = new Map();

  function addTrace(run, type, details = {}) {
    run.trace.push({
      id: idFactory(),
      type,
      timestamp: timestamp(now),
      ...sanitizeTraceValue(details),
    });
    if (run.trace.length > MAX_TRACE_EVENTS) {
      run.trace.splice(0, run.trace.length - MAX_TRACE_EVENTS);
    }
  }

  async function persist(run) {
    run.updatedAt = timestamp(now);
    await store.saveAgentGraphRun({ workspacePath: run.workspacePath, run });
  }

  async function markInterruptedRuns(workspacePath, graphId) {
    const runs = await store.listAgentGraphRuns({ workspacePath, graphId, limit: 100 });
    for (const run of runs) {
      if (!ACTIVE_STATUSES.has(run.status) || activeRuns.has(run.id)) continue;
      run.status = 'failed';
      run.context.status = 'failed';
      run.error = 'Agent Graph run was interrupted by a server restart.';
      run.completedAt = timestamp(now);
      addTrace(run, 'run_failed', { message: run.error });
      await store.saveAgentGraphRun({ workspacePath, run });
    }
    return runs;
  }

  async function executeRun(run, abortController) {
    try {
      run.status = 'running';
      run.context.status = 'running';
      run.startedAt = timestamp(now);
      addTrace(run, 'run_started', { message: 'Graph Executor started the run.' });
      await persist(run);

      for (let iterationIndex = 0; iterationIndex < run.maxIterations; iterationIndex += 1) {
        if (abortController.signal.aborted) throw createHttpError('Agent Graph run was cancelled', 409);
        run.context.iteration = iterationIndex + 1;
        const activationInput = {
          goal: run.context.goal,
          context: contextSnapshot(run.context),
          availableAgents: run.graphSnapshot.agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            workingDescription: agent.workingDescription,
            skills: agent.skills,
            tools: agent.tools,
            activationCount: run.agentStates.find((state) => state.agentId === agent.id)?.activationCount || 0,
          })),
          relations: run.graphSnapshot.relations,
        };
        addTrace(run, 'iteration_started', {
          iteration: run.context.iteration,
          message: `Collaboration iteration ${run.context.iteration} started.`,
          input: activationInput,
        });
        await persist(run);

        let decision = await selectAgent({ run, abortController });
        const consecutiveCount = countConsecutiveAgentResults(run, decision.selectedAgentId);
        if (consecutiveCount >= MAX_CONSECUTIVE_AGENT_ACTIVATIONS) {
          const excludedAgentIds = run.graphSnapshot.agents.length > 1 ? [decision.selectedAgentId] : [];
          const reconsiderationReason = `${decision.selectedAgentId} has already run ${consecutiveCount} consecutive times; reassess the best collaborator.`;
          addTrace(run, 'activation_reconsidered', {
            iteration: run.context.iteration,
            agentId: decision.selectedAgentId,
            message: reconsiderationReason,
            input: activationInput,
            output: decision,
          });
          await persist(run);
          decision = await selectAgent({
            run,
            abortController,
            excludedAgentIds,
            reconsiderationReason,
          });
        }
        addTrace(run, 'activation_decision', {
          iteration: run.context.iteration,
          agentId: decision.selectedAgentId,
          message: decision.reason,
          task: decision.task,
          input: activationInput,
          output: decision,
        });

        const agent = run.graphSnapshot.agents.find((entry) => entry.id === decision.selectedAgentId);
        if (!agent) throw createHttpError('Selected Agent is no longer available in the Graph snapshot', 500);
        const agentState = run.agentStates.find((entry) => entry.agentId === agent.id);
        agentState.status = 'running';
        agentState.activationCount += 1;
        agentState.lastStartedAt = timestamp(now);
        agentState.error = null;
        const agentInput = {
          role: {
            id: agent.id,
            name: agent.name,
            topSkill: agent.topSkill,
            skills: agent.skills,
            tools: agent.tools,
          },
          goal: run.context.goal,
          userInput: run.context.userInput,
          task: decision.task || decision.reason,
          context: contextSnapshot(run.context),
        };
        addTrace(run, 'agent_started', {
          iteration: run.context.iteration,
          agentId: agent.id,
          agentName: agent.name,
          message: decision.reason,
          input: agentInput,
        });
        await persist(run);

        try {
          const response = await executeAgent({ run, agent, decision, abortController });
          const agentResult = normalizeAgentResult(response, agent);
          const completedAt = timestamp(now);
          const result = {
            id: idFactory(),
            agentId: agent.id,
            agentName: agent.name,
            activation: agentState.activationCount,
            summary: agentResult.summary,
            findings: uniqueStrings(agentResult.findings),
            newQuestions: uniqueStrings(agentResult.newQuestions),
            confidence: agentResult.confidence,
            content: response.text || agentResult.summary,
            providerSessionId: response.sessionId || null,
            createdAt: completedAt,
          };
          run.context.agentResults.push(result);
          agentState.status = 'completed';
          agentState.lastCompletedAt = completedAt;
          agentState.lastResult = result.content;
          addTrace(run, 'agent_completed', {
            iteration: run.context.iteration,
            agentId: agent.id,
            agentName: agent.name,
            message: `${agent.name} completed activation ${agentState.activationCount}.`,
            input: agentInput,
            output: agentResult,
          });

          const previousContext = {
            findingCount: run.context.findings.length,
            pendingQuestions: [...run.context.pendingQuestions],
            staleIterations: run.staleIterations,
          };
          const knownFindings = new Set(run.context.findings.map((finding) => finding.content.trim().toLowerCase()));
          const addedFindings = result.findings.filter((finding) => !knownFindings.has(finding.toLowerCase()));
          for (const finding of addedFindings) {
            run.context.findings.push({
              id: idFactory(),
              agentId: agent.id,
              agentName: agent.name,
              content: finding,
              createdAt: completedAt,
            });
          }
          run.context.pendingQuestions = result.newQuestions;
          run.staleIterations = addedFindings.length ? 0 : run.staleIterations + 1;
          addTrace(run, 'context_updated', {
            iteration: run.context.iteration,
            agentId: agent.id,
            agentName: agent.name,
            message: addedFindings.length
              ? `${addedFindings.length} new finding(s) were added to the shared Context.`
              : 'The Agent added no new finding to the shared Context.',
            input: { previousContext, agentResult },
            output: {
              addedFindings,
              pendingQuestions: run.context.pendingQuestions,
              iteration: run.context.iteration,
              staleIterations: run.staleIterations,
            },
          });
          await persist(run);

          const completionInput = {
            goal: run.context.goal,
            context: contextSnapshot(run.context),
            latestAgentResult: result,
          };
          const completion = await evaluateCompletion({ run, abortController });
          addTrace(run, 'completion_decision', {
            iteration: run.context.iteration,
            message: completion.reason,
            complete: completion.completed,
            input: completionInput,
            output: completion,
          });

          if (completion.completed) {
            run.status = 'completed';
            run.context.status = 'completed';
            run.result = completion.finalAnswer || fallbackResult(run, 'Graph goal completed.');
            run.completedAt = timestamp(now);
            addTrace(run, 'run_completed', {
              iteration: run.context.iteration,
              message: completion.reason,
              output: { result: run.result },
            });
            await persist(run);
            return;
          }

          if (run.staleIterations >= MAX_STALE_ITERATIONS) {
            run.status = 'completed';
            run.context.status = 'completed';
            run.result = fallbackResult(run, 'The collaboration loop stopped because it found no new information.');
            run.completedAt = timestamp(now);
            addTrace(run, 'loop_stopped_no_new_info', {
              iteration: run.context.iteration,
              message: `The loop stopped after ${run.staleIterations} consecutive iteration(s) without a new finding.`,
              input: { staleIterations: run.staleIterations, pendingQuestions: run.context.pendingQuestions },
              output: { result: run.result },
            });
            await persist(run);
            return;
          }
          await persist(run);
        } catch (error) {
          const errorMessage = error?.message || String(error);
          if (agentState.status === 'completed') {
            addTrace(run, 'completion_failed', {
              iteration: run.context.iteration,
              agentId: agent.id,
              agentName: agent.name,
              message: errorMessage,
              input: { context: contextSnapshot(run.context) },
              output: { error: errorMessage },
            });
          } else {
            agentState.status = abortController.signal.aborted ? 'cancelled' : 'failed';
            agentState.lastCompletedAt = timestamp(now);
            agentState.error = errorMessage;
            addTrace(run, 'agent_failed', {
              iteration: run.context.iteration,
              agentId: agent.id,
              agentName: agent.name,
              message: agentState.error,
              input: agentInput,
              output: { error: agentState.error },
            });
          }
          throw error;
        }
      }

      run.status = 'completed';
      run.context.status = 'completed';
      run.result = fallbackResult(run, 'The iteration limit was reached without an Agent result.');
      run.completedAt = timestamp(now);
      addTrace(run, 'run_completed', {
        iteration: run.context.iteration,
        message: `The run stopped after reaching the ${run.maxIterations}-iteration safety limit.`,
        limitReached: true,
        output: { result: run.result },
      });
      await persist(run);
    } catch (error) {
      const cancelled = abortController.signal.aborted;
      run.status = cancelled ? 'cancelled' : 'failed';
      run.context.status = run.status;
      run.error = cancelled ? 'Agent Graph run was cancelled.' : error?.message || String(error);
      run.completedAt = timestamp(now);
      addTrace(run, cancelled ? 'run_cancelled' : 'run_failed', { message: run.error });
      await persist(run).catch((persistError) => {
        console.error('[agent-graph-executor] Failed to persist terminal run state:', persistError);
      });
    } finally {
      activeRuns.delete(run.id);
    }
  }

  async function startRun({
    workspacePath,
    tenantId,
    userId,
    workspaceId,
    graph,
    input,
    maxIterations,
    maxActivations,
  }) {
    if (!graph?.agents?.length) {
      throw createHttpError('Add at least one Agent before running this Graph');
    }
    const userInput = normalizeUserInput(input);
    const iterationLimit = normalizeMaxIterations(maxIterations ?? maxActivations);
    const priorRuns = await markInterruptedRuns(workspacePath, graph.id);
    if (priorRuns.some((run) => ACTIVE_STATUSES.has(run.status) && activeRuns.has(run.id))) {
      throw createHttpError('This Agent Graph already has an active run', 409);
    }

    const createdAt = timestamp(now);
    const run = {
      version: 2,
      id: idFactory(),
      graphId: graph.id,
      graphName: graph.name,
      graphSnapshot: structuredClone(graph),
      workspacePath,
      tenantId,
      userId,
      workspaceId,
      status: 'queued',
      input: userInput,
      maxIterations: iterationLimit,
      maxActivations: iterationLimit,
      executorConfig: getAgentGraphExecutorConfig(iterationLimit),
      staleIterations: 0,
      context: {
        executionId: null,
        goal: graph.goal,
        userInput,
        findings: [],
        agentResults: [],
        pendingQuestions: [],
        iteration: 0,
        status: 'queued',
      },
      agentStates: graph.agents.map((agent) => ({
        agentId: agent.id,
        agentName: agent.name,
        status: 'waiting',
        activationCount: 0,
        lastStartedAt: null,
        lastCompletedAt: null,
        lastResult: null,
        error: null,
      })),
      trace: [],
      result: null,
      error: null,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
    };
    run.context.executionId = run.id;
    addTrace(run, 'run_created', { message: 'Execution Context created.', input: userInput });
    const abortController = new AbortController();
    activeRuns.set(run.id, abortController);
    try {
      await store.saveAgentGraphRun({ workspacePath, run });
    } catch (error) {
      activeRuns.delete(run.id);
      throw error;
    }
    schedule(() => executeRun(run, abortController));
    return toPublicRun(run);
  }

  async function getRun({ workspacePath, graphId, runId }) {
    await markInterruptedRuns(workspacePath, graphId);
    const run = await store.getAgentGraphRun({ workspacePath, runId });
    if (run.graphId !== graphId) throw createHttpError('Agent Graph run not found', 404);
    return toPublicRun(run);
  }

  async function listRuns({ workspacePath, graphId, limit }) {
    await markInterruptedRuns(workspacePath, graphId);
    const runs = await store.listAgentGraphRuns({ workspacePath, graphId, limit });
    return runs.map(toPublicRun);
  }

  async function cancelRun({ workspacePath, graphId, runId }) {
    const run = await store.getAgentGraphRun({ workspacePath, runId });
    if (run.graphId !== graphId) throw createHttpError('Agent Graph run not found', 404);
    if (!ACTIVE_STATUSES.has(run.status)) return toPublicRun(run);
    const controller = activeRuns.get(run.id);
    if (!controller) {
      run.status = 'failed';
      run.context.status = 'failed';
      run.error = 'Agent Graph run was interrupted and cannot be cancelled.';
      run.completedAt = timestamp(now);
      addTrace(run, 'run_failed', { message: run.error });
      await store.saveAgentGraphRun({ workspacePath, run });
      return toPublicRun(run);
    }
    run.status = 'cancelling';
    run.context.status = 'cancelling';
    addTrace(run, 'run_cancelling', { message: 'Cancellation requested.' });
    await store.saveAgentGraphRun({ workspacePath, run });
    controller.abort();
    return toPublicRun(run);
  }

  return {
    startRun,
    getRun,
    listRuns,
    cancelRun,
    getConfig: () => getAgentGraphExecutorConfig(),
  };
}

export const agentGraphExecutorService = createAgentGraphExecutorService();
