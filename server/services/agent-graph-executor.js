import crypto from 'node:crypto';

import { agentGraphArtifactWorkspace } from './agent-graph-artifact-workspace.js';
import { agentGraphRunStore } from './agent-graph-run-store.js';
import { buildAgentSpecificContext, executionContextSnapshot } from './agent-graph-context-builder.js';
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
    version: 5,
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
      controllerMaySynthesizeBusinessAnswer: false,
      finalResultSource: 'existing-agent-result',
      requiresUserReadyDeliverable: true,
      skipsIrrelevantAgents: true,
    },
    sessionPolicy: {
      activationController: 'ephemeral',
      completionController: 'ephemeral',
      agentSessionScope: 'executionId+agentId',
      reuseAgentSessionWithinExecution: true,
      reuseAgentSessionAcrossExecutions: false,
    },
    contextPolicy: {
      executionContextStoresFullAgentOutput: false,
      agentResultsStoredSeparately: true,
      findingsStoredSeparately: true,
      artifactsStoredInExecutionWorkspace: true,
      agentInputBuiltPerActivation: true,
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
  return executionContextSnapshot(context);
}

function normalizeAgentResult(response) {
  if (response?.agentResult && typeof response.agentResult === 'object') {
    const raw = response.agentResult;
    const message = String(raw.message ?? raw.summary ?? response.text ?? '').trim();
    return {
      status: ['completed', 'failed', 'partial'].includes(raw.status) ? raw.status : 'completed',
      message,
      artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
      findings: (Array.isArray(raw.findings) ? raw.findings : []).map((finding) => (
        typeof finding === 'string'
          ? { content: finding, sourceArtifacts: [], confidence: Number(raw.confidence) || 0.5 }
          : finding
      )),
      questions: uniqueStrings(raw.questions ?? raw.newQuestions),
    };
  }
  const message = String(response?.text || '').trim();
  return {
    status: message ? 'partial' : 'failed',
    message,
    artifacts: [],
    findings: message ? [{ content: message, sourceArtifacts: [], confidence: 0.5 }] : [],
    questions: [],
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
  for (let index = run.resultStore.length - 1; index >= 0; index -= 1) {
    if (run.resultStore[index].agentId !== agentId) break;
    count += 1;
  }
  return count;
}

function fallbackResult(run, message) {
  const latest = run.resultStore.at(-1);
  return latest?.message || message;
}

function normalizeCurrentNeed(input, goal) {
  if (typeof input === 'string' && input.trim()) return input.trim();
  try {
    const serialized = JSON.stringify(input);
    return serialized && serialized !== '{}' ? serialized : goal;
  } catch {
    return goal;
  }
}

function legacyEvidenceStore(run) {
  return (run.context?.findings || []).map((finding) => ({
    id: finding.id,
    executionId: run.id,
    sourceAgentId: finding.agentId,
    sourceAgent: finding.agentName,
    content: finding.content,
    sourceArtifacts: [],
    confidence: 0.5,
    createdAt: finding.createdAt,
  }));
}

function legacyResultStore(run) {
  return (run.context?.agentResults || []).map((result) => ({
    resultId: result.id,
    executionId: run.id,
    agentId: result.agentId,
    agentName: result.agentName,
    activation: result.activation,
    status: 'completed',
    message: result.summary || result.content || '',
    artifacts: [],
    findings: [],
    questions: result.newQuestions || [],
    createdAt: result.createdAt,
  }));
}

function migrateCurrentResult(result) {
  if (result?.message !== undefined && Array.isArray(result?.artifacts) && Array.isArray(result?.findings)) return result;
  return {
    resultId: result.resultId,
    executionId: result.executionId,
    agentId: result.agentId,
    agentName: result.agentName,
    activation: result.activation,
    status: 'completed',
    message: result.summary || result.content || '',
    artifacts: [],
    findings: [],
    questions: result.newQuestions || [],
    createdAt: result.createdAt,
  };
}

function migrateEvidence(evidence) {
  if (evidence?.id) return evidence;
  return {
    id: evidence.findingId || evidence.evidenceId,
    executionId: evidence.executionId,
    sourceAgentId: evidence.sourceAgentId,
    sourceAgent: evidence.sourceAgent,
    content: evidence.claim,
    sourceArtifacts: [],
    confidence: evidence.confidence,
    createdAt: evidence.createdAt,
  };
}

function normalizePublicRunShape(run) {
  const resultStore = Array.isArray(run.resultStore)
    ? run.resultStore.map(migrateCurrentResult)
    : legacyResultStore(run);
  const findingStore = Array.isArray(run.findingStore)
    ? run.findingStore
    : Array.isArray(run.evidenceStore)
      ? run.evidenceStore.map(migrateEvidence)
      : legacyEvidenceStore(run);
  const artifactRegistry = Array.isArray(run.artifactRegistry) ? run.artifactRegistry : [];
  const legacySessionsByAgent = new Map();
  for (const result of run.context?.agentResults || []) {
    if (!result.providerSessionId) continue;
    legacySessionsByAgent.set(result.agentId, {
      agentId: result.agentId,
      agentName: result.agentName,
      providerSessionId: result.providerSessionId,
      status: 'ended',
      activationCount: result.activation || 1,
      createdAt: result.createdAt,
      lastUsedAt: result.createdAt,
      endedAt: run.completedAt || result.createdAt,
      injectedArtifactIds: [],
      injectedFindingIds: [],
      injectedResultIds: [],
    });
  }
  const context = run.context || {};
  return {
    ...run,
    resultStore,
    artifactRegistry,
    findingStore,
    agentSessions: Array.isArray(run.agentSessions) ? run.agentSessions : [...legacySessionsByAgent.values()],
    context: {
      executionId: context.executionId || run.id,
      goal: context.goal || run.graphSnapshot?.goal || '',
      status: context.status || run.status,
      iteration: Number(context.iteration) || 0,
      currentNeed: context.currentNeed || context.pendingQuestions?.[0] || '',
      artifactIds: Array.isArray(context.artifactIds) ? context.artifactIds : artifactRegistry.map((entry) => entry.artifactId),
      findingIds: Array.isArray(context.findingIds)
        ? context.findingIds
        : Array.isArray(context.evidenceIds)
          ? context.evidenceIds
          : findingStore.map((entry) => entry.id),
      resultIds: Array.isArray(context.resultIds)
        ? context.resultIds
        : resultStore.map((entry) => entry.resultId),
      questions: Array.isArray(context.questions)
        ? context.questions
        : Array.isArray(context.pendingQuestions) ? context.pendingQuestions : [],
    },
  };
}

function toPublicRun(run) {
  const normalized = normalizePublicRunShape(run);
  const { workspacePath, tenantId, userId, workspaceId, evidenceStore, ...safe } = normalized;
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
  artifactWorkspace = agentGraphArtifactWorkspace,
} = {}) {
  const activeRuns = new Map();

  function getOrCreateAgentSession(run, agent) {
    let session = run.agentSessions.find((entry) => entry.agentId === agent.id);
    if (session) return session;
    const createdAt = timestamp(now);
    session = {
      agentId: agent.id,
      agentName: agent.name,
      providerSessionId: null,
      status: 'starting',
      activationCount: 0,
      createdAt,
      lastUsedAt: null,
      endedAt: null,
      injectedArtifactIds: [],
      injectedFindingIds: [],
      injectedResultIds: [],
    };
    run.agentSessions.push(session);
    return session;
  }

  function rememberAgentContext(session, agentContext) {
    session.injectedArtifactIds = uniqueStrings([
      ...(session.injectedArtifactIds || []),
      ...(agentContext.includedArtifactIds || []),
    ]);
    session.injectedFindingIds = uniqueStrings([
      ...(session.injectedFindingIds || session.injectedEvidenceIds || []),
      ...(agentContext.includedFindingIds || []),
    ]);
    session.injectedResultIds = uniqueStrings([
      ...(session.injectedResultIds || []),
      ...(agentContext.includedResultIds || []),
    ]);
  }

  function endAgentSessions(run, status = 'ended') {
    const endedAt = timestamp(now);
    for (const session of run.agentSessions || []) {
      if (session.status === 'failed') continue;
      session.status = status;
      session.endedAt = endedAt;
    }
  }

  function resultById(run, resultId) {
    return run.resultStore.find((entry) => entry.resultId === resultId) || null;
  }

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

  async function persist(run, result = null) {
    run.updatedAt = timestamp(now);
    await store.saveAgentGraphRun({ workspacePath: run.workspacePath, run });
    await artifactWorkspace.syncExecutionWorkspace({ workspacePath: run.workspacePath, run, result });
  }

  async function markInterruptedRuns(workspacePath, graphId) {
    const runs = await store.listAgentGraphRuns({ workspacePath, graphId, limit: 100 });
    for (const run of runs) {
      if (!ACTIVE_STATUSES.has(run.status) || activeRuns.has(run.id)) continue;
      run.status = 'failed';
      run.context.status = 'failed';
      run.error = 'Agent Graph run was interrupted by a server restart.';
      run.completedAt = timestamp(now);
      run.agentSessions = Array.isArray(run.agentSessions) ? run.agentSessions : [];
      endAgentSessions(run, 'failed');
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
        run.context.currentNeed = decision.task || decision.reason;
        const agentSession = getOrCreateAgentSession(run, agent);
        const resumedSession = Boolean(agentSession.providerSessionId);
        agentSession.status = resumedSession ? 'active' : 'starting';
        agentSession.activationCount += 1;
        const agentContext = buildAgentSpecificContext({ run, agent, agentSession });
        rememberAgentContext(agentSession, agentContext);
        const agentInput = {
          role: {
            id: agent.id,
            name: agent.name,
            topSkill: agent.topSkill,
            skills: agent.skills,
            tools: agent.tools,
          },
          task: decision.task || decision.reason,
          agentContext,
          session: {
            executionId: run.id,
            providerSessionId: agentSession.providerSessionId,
            resumed: resumedSession,
          },
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
          const response = await executeAgent({
            run,
            agent,
            decision,
            agentSession,
            agentContext,
            abortController,
          });
          if (!agentSession.providerSessionId && !response.sessionId) {
            throw createHttpError('Agent Runtime did not return a provider Session ID', 502);
          }
          if (agentSession.providerSessionId && response.sessionId && response.sessionId !== agentSession.providerSessionId) {
            throw createHttpError('Agent Runtime returned a different provider Session while resuming the Agent', 502);
          }
          agentSession.providerSessionId = agentSession.providerSessionId || response.sessionId;
          agentSession.status = 'active';
          agentSession.lastUsedAt = timestamp(now);
          const agentResult = normalizeAgentResult(response);
          const completedAt = timestamp(now);
          const resultId = idFactory();
          run.artifactRegistry = await artifactWorkspace.listArtifacts({
            workspacePath: run.workspacePath,
            executionId: run.id,
          });
          const existingArtifactIds = new Set(run.context.artifactIds);
          const addedArtifacts = run.artifactRegistry.filter((entry) => !existingArtifactIds.has(entry.artifactId));
          const knownFindingsByContent = new Map((run.findingStore || []).map((finding) => [
            String(finding.content || '').trim().toLowerCase(),
            finding,
          ]));
          const resultFindings = [];
          const addedFindings = [];
          for (const extractedFinding of Array.isArray(agentResult.findings) ? agentResult.findings : []) {
            const content = String(extractedFinding?.content || '').trim();
            if (!content) continue;
            const normalizedContent = content.toLowerCase();
            const existing = knownFindingsByContent.get(normalizedContent);
            if (existing) {
              existing.sourceArtifacts = uniqueStrings([
                ...(existing.sourceArtifacts || []),
                ...(extractedFinding.sourceArtifacts || []),
              ]);
              existing.confidence = Math.max(existing.confidence || 0, Number(extractedFinding.confidence) || 0);
              resultFindings.push({
                id: existing.id,
                content: existing.content,
                sourceArtifacts: existing.sourceArtifacts || [],
                confidence: existing.confidence,
              });
              continue;
            }
            const finding = {
              id: idFactory(),
              executionId: run.id,
              sourceAgentId: agent.id,
              sourceAgent: agent.name,
              content,
              sourceArtifacts: uniqueStrings(extractedFinding.sourceArtifacts),
              confidence: Number.isFinite(Number(extractedFinding.confidence))
                ? Math.max(0, Math.min(1, Number(extractedFinding.confidence)))
                : 0.5,
              metadata: {
                resultId,
                iteration: run.context.iteration,
                activation: agentState.activationCount,
              },
              createdAt: completedAt,
            };
            run.findingStore.push(finding);
            knownFindingsByContent.set(normalizedContent, finding);
            resultFindings.push({
              id: finding.id,
              content: finding.content,
              sourceArtifacts: finding.sourceArtifacts,
              confidence: finding.confidence,
            });
            addedFindings.push(finding);
          }
          const result = {
            resultId,
            executionId: run.id,
            agentId: agent.id,
            agentName: agent.name,
            activation: agentState.activationCount,
            status: agentResult.status,
            message: agentResult.message,
            artifacts: Array.isArray(agentResult.artifacts) ? agentResult.artifacts : [],
            findings: resultFindings,
            questions: uniqueStrings(agentResult.questions),
            createdAt: completedAt,
          };
          for (const interaction of Array.isArray(response.toolInteractions) ? response.toolInteractions : []) {
            addTrace(run, 'agent_tool_completed', {
              iteration: run.context.iteration,
              agentId: agent.id,
              agentName: agent.name,
              message: `${agent.name} called ${interaction.toolName}; the output was stored as Artifact ${interaction.artifact?.artifactId}.`,
              input: {
                toolName: interaction.toolName,
                toolUseId: interaction.toolUseId,
                parameters: interaction.input,
              },
              output: {
                artifact: interaction.artifact,
                originalSizeBytes: interaction.originalSizeBytes,
                truncatedForClaude: interaction.truncatedForClaude,
              },
            });
          }
          run.resultStore.push(result);
          run.context.resultIds.push(result.resultId);
          run.context.artifactIds = uniqueStrings([
            ...run.context.artifactIds,
            ...run.artifactRegistry.map((entry) => entry.artifactId),
          ]);
          run.context.findingIds = uniqueStrings([
            ...run.context.findingIds,
            ...addedFindings.map((entry) => entry.id),
          ]);
          agentSession.injectedResultIds = uniqueStrings([...agentSession.injectedResultIds, result.resultId]);
          agentSession.injectedArtifactIds = uniqueStrings([
            ...agentSession.injectedArtifactIds,
            ...result.artifacts.map((entry) => entry.artifactId),
          ]);
          agentSession.injectedFindingIds = uniqueStrings([
            ...agentSession.injectedFindingIds,
            ...resultFindings.map((entry) => entry.id),
          ]);
          agentState.status = 'completed';
          agentState.lastCompletedAt = completedAt;
          agentState.lastResultId = result.resultId;
          addTrace(run, 'agent_completed', {
            iteration: run.context.iteration,
            agentId: agent.id,
            agentName: agent.name,
            message: `${agent.name} completed activation ${agentState.activationCount}.`,
            input: agentInput,
            output: agentResult,
          });

          addTrace(run, resumedSession ? 'agent_session_resumed' : 'agent_session_created', {
            iteration: run.context.iteration,
            agentId: agent.id,
            agentName: agent.name,
            message: resumedSession
              ? `${agent.name} continued its execution-scoped Claude Session.`
              : `${agent.name} created its execution-scoped Claude Session.`,
            output: {
              executionId: run.id,
              agentId: agent.id,
              providerSessionId: agentSession.providerSessionId,
              activationCount: agentSession.activationCount,
              status: agentSession.status,
            },
          });

          const previousContext = {
            artifactCount: run.context.artifactIds.length - addedArtifacts.length,
            findingCount: run.context.findingIds.length - addedFindings.length,
            resultCount: run.context.resultIds.length - 1,
            questions: [...run.context.questions],
            currentNeed: run.context.currentNeed,
            staleIterations: run.staleIterations,
          };
          run.context.questions = result.questions;
          run.context.currentNeed = result.questions[0] || '';
          run.staleIterations = addedFindings.length || addedArtifacts.length ? 0 : run.staleIterations + 1;
          addTrace(run, 'context_updated', {
            iteration: run.context.iteration,
            agentId: agent.id,
            agentName: agent.name,
            message: addedFindings.length || addedArtifacts.length
              ? `${addedFindings.length} Finding(s), ${addedArtifacts.length} Artifact(s), and one Agent Result reference were added to Execution Context.`
              : 'One Agent Result reference was added; no new Finding or Artifact reference was created.',
            input: { previousContext, agentResult },
            output: {
              addedArtifactIds: addedArtifacts.map((entry) => entry.artifactId),
              addedFindingIds: addedFindings.map((entry) => entry.id),
              addedResultId: result.resultId,
              context: contextSnapshot(run.context),
              staleIterations: run.staleIterations,
            },
          });
          await persist(run, result);

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
            const finalAgentResult = resultById(run, completion.finalAgentResultId);
            if (!finalAgentResult) {
              throw createHttpError('Completion Controller did not select an existing Agent Result', 502);
            }
            run.status = 'completed';
            run.context.status = 'completed';
            run.context.currentNeed = '';
            run.finalResultId = finalAgentResult.resultId;
            run.result = finalAgentResult.message;
            run.completedAt = timestamp(now);
            endAgentSessions(run);
            addTrace(run, 'run_completed', {
              iteration: run.context.iteration,
              message: completion.reason,
              output: { finalResultId: run.finalResultId, result: run.result },
            });
            await persist(run);
            return;
          }

          if (run.staleIterations >= MAX_STALE_ITERATIONS) {
            run.status = 'completed';
            run.context.status = 'completed';
            run.context.currentNeed = '';
            run.finalResultId = run.resultStore.at(-1)?.resultId || null;
            run.result = fallbackResult(run, 'The collaboration loop stopped because it found no new information.');
            run.completedAt = timestamp(now);
            endAgentSessions(run);
            addTrace(run, 'loop_stopped_no_new_info', {
              iteration: run.context.iteration,
              message: `The loop stopped after ${run.staleIterations} consecutive iteration(s) without a new finding.`,
              input: { staleIterations: run.staleIterations, questions: run.context.questions },
              output: { result: run.result },
            });
            await persist(run);
            return;
          }
          run.context.currentNeed = run.context.questions[0] || completion.reason;
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
            agentSession.status = abortController.signal.aborted ? 'ended' : 'failed';
            agentSession.endedAt = timestamp(now);
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
      run.context.currentNeed = '';
      run.finalResultId = run.resultStore.at(-1)?.resultId || null;
      run.result = fallbackResult(run, 'The iteration limit was reached without an Agent result.');
      run.completedAt = timestamp(now);
      endAgentSessions(run);
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
      run.context.currentNeed = '';
      run.error = cancelled ? 'Agent Graph run was cancelled.' : error?.message || String(error);
      run.completedAt = timestamp(now);
      endAgentSessions(run, cancelled ? 'ended' : 'failed');
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
    const executionGoal = normalizeCurrentNeed(userInput, graph.goal);
    const iterationLimit = normalizeMaxIterations(maxIterations ?? maxActivations);
    const priorRuns = await markInterruptedRuns(workspacePath, graph.id);
    if (priorRuns.some((run) => ACTIVE_STATUSES.has(run.status) && activeRuns.has(run.id))) {
      throw createHttpError('This Agent Graph already has an active run', 409);
    }

    const createdAt = timestamp(now);
    const runId = idFactory();
    const run = {
      version: 4,
      id: runId,
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
      resultStore: [],
      artifactRegistry: [],
      findingStore: [],
      agentSessions: [],
      context: {
        executionId: runId,
        goal: executionGoal,
        status: 'queued',
        iteration: 0,
        currentNeed: executionGoal,
        artifactIds: [],
        findingIds: [],
        resultIds: [],
        questions: [],
      },
      agentStates: graph.agents.map((agent) => ({
        agentId: agent.id,
        agentName: agent.name,
        status: 'waiting',
        activationCount: 0,
        lastStartedAt: null,
        lastCompletedAt: null,
        lastResultId: null,
        error: null,
      })),
      trace: [],
      finalResultId: null,
      result: null,
      error: null,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
    };
    addTrace(run, 'run_created', { message: 'Execution Context created.', input: userInput });
    const abortController = new AbortController();
    activeRuns.set(run.id, abortController);
    try {
      await artifactWorkspace.initializeExecutionWorkspace({
        workspacePath,
        executionId: run.id,
        context: run.context,
        trace: run.trace,
      });
      await persist(run);
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
    if (Number(run.version) >= 4) {
      run.artifactRegistry = await artifactWorkspace.listArtifacts({ workspacePath, executionId: runId });
    }
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
      run.agentSessions = Array.isArray(run.agentSessions) ? run.agentSessions : [];
      endAgentSessions(run, 'failed');
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

  async function listRunArtifacts({ workspacePath, graphId, runId }) {
    const run = await store.getAgentGraphRun({ workspacePath, runId });
    if (run.graphId !== graphId) throw createHttpError('Agent Graph run not found', 404);
    return artifactWorkspace.listArtifacts({ workspacePath, executionId: runId });
  }

  async function readRunArtifact({ workspacePath, graphId, runId, artifactId, offset, limit }) {
    const run = await store.getAgentGraphRun({ workspacePath, runId });
    if (run.graphId !== graphId) throw createHttpError('Agent Graph run not found', 404);
    return artifactWorkspace.readArtifact({ workspacePath, executionId: runId, artifactId, offset, limit });
  }

  return {
    startRun,
    getRun,
    listRuns,
    cancelRun,
    listRunArtifacts,
    readRunArtifact,
    getConfig: () => getAgentGraphExecutorConfig(),
  };
}

export const agentGraphExecutorService = createAgentGraphExecutorService();
