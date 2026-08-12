const MAX_AGENT_EVIDENCE = 12;
const MAX_AGENT_RESULTS = 8;
const MAX_CONTROLLER_EVIDENCE = 20;
const MAX_CONTROLLER_RESULTS = 12;
const MAX_SUMMARY_LENGTH = 8_000;

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim()))];
}

function truncate(value, maximum = MAX_SUMMARY_LENGTH) {
  const text = String(value || '');
  return text.length > maximum ? `${text.slice(0, maximum)}\n...[truncated]` : text;
}

function indexBy(items, key) {
  return new Map((Array.isArray(items) ? items : []).map((item) => [item?.[key], item]));
}

function entriesReferencedBy(ids, store, key) {
  const byId = indexBy(store, key);
  return uniqueStrings(ids).map((id) => byId.get(id)).filter(Boolean);
}

function keywordTokens(value) {
  return [...new Set(String(value || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2))];
}

function relevanceScore(entry, agent, incomingSourceIds, currentNeed, index, total) {
  let score = Math.max(0, index - Math.max(0, total - 4));
  const sourceAgentId = entry.sourceAgentId || entry.agentId;
  if (incomingSourceIds.has(sourceAgentId)) score += 20;
  if (sourceAgentId === agent.id) score += 5;

  const targetText = [
    agent.name,
    agent.workingDescription,
    agent.businessContext,
    currentNeed,
  ].join(' ').toLowerCase();
  const entryText = [entry.content, entry.claim, entry.message, entry.summary, entry.status].join(' ').toLowerCase();
  for (const token of keywordTokens(targetText)) {
    if (entryText.includes(token)) score += 2;
  }
  return score;
}

function selectRelevant(entries, {
  agent,
  incomingSourceIds,
  currentNeed,
  excludedIds,
  idKey,
  maximum,
}) {
  return entries
    .map((entry, index) => ({
      entry,
      index,
      score: relevanceScore(entry, agent, incomingSourceIds, currentNeed, index, entries.length),
    }))
    .filter(({ entry }) => !excludedIds.has(entry[idKey]))
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, maximum)
    .sort((left, right) => left.index - right.index)
    .map(({ entry }) => entry);
}

export function executionContextSnapshot(context) {
  return structuredClone({
    executionId: context?.executionId || null,
    goal: context?.goal || '',
    status: context?.status || 'queued',
    iteration: Number(context?.iteration) || 0,
    currentNeed: context?.currentNeed || '',
    artifactIds: uniqueStrings(context?.artifactIds),
    findingIds: uniqueStrings(context?.findingIds ?? context?.evidenceIds),
    resultIds: uniqueStrings(context?.resultIds),
    questions: uniqueStrings(context?.questions ?? context?.pendingQuestions),
  });
}

export function buildControllerContext(run) {
  const context = executionContextSnapshot(run.context);
  const findingStore = (run.findingStore ?? run.evidenceStore ?? []).map((entry) => entry.id ? entry : ({
    ...entry,
    id: entry.findingId || entry.evidenceId,
    content: entry.content || entry.claim,
    sourceArtifacts: entry.sourceArtifacts || [],
  }));
  const findings = entriesReferencedBy(context.findingIds, findingStore, 'id')
    .slice(-MAX_CONTROLLER_EVIDENCE)
    .map((entry) => ({
      id: entry.id,
      sourceAgent: entry.sourceAgent,
      content: truncate(entry.content),
      sourceArtifacts: uniqueStrings(entry.sourceArtifacts),
      confidence: entry.confidence,
    }));
  const agentResults = entriesReferencedBy(context.resultIds, run.resultStore, 'resultId')
    .slice(-MAX_CONTROLLER_RESULTS)
    .map((entry) => ({
      resultId: entry.resultId,
      agentId: entry.agentId,
      agentName: entry.agentName,
      status: entry.status,
      message: truncate(entry.message),
      artifacts: Array.isArray(entry.artifacts) ? entry.artifacts : [],
      findings: Array.isArray(entry.findings) ? entry.findings : [],
    }));
  const artifacts = entriesReferencedBy(context.artifactIds, run.artifactRegistry, 'artifactId')
    .slice(-MAX_CONTROLLER_EVIDENCE)
    .map((entry) => ({
      artifactId: entry.artifactId,
      type: entry.type,
      name: entry.name,
      producerAgentId: entry.producerAgentId,
      metadata: entry.metadata || {},
    }));
  return { ...context, artifacts, findings, agentResults };
}

export function buildAgentSpecificContext({ run, agent, agentSession }) {
  const context = executionContextSnapshot(run.context);
  const incomingSourceIds = new Set((run.graphSnapshot?.relations || [])
    .filter((relation) => relation.targetAgent === agent.id)
    .map((relation) => relation.sourceAgent));
  const resumed = Boolean(agentSession?.providerSessionId);
  const injectedFindingIds = new Set(uniqueStrings(agentSession?.injectedFindingIds ?? agentSession?.injectedEvidenceIds));
  const injectedResultIds = new Set(uniqueStrings(agentSession?.injectedResultIds));
  const injectedArtifactIds = new Set(uniqueStrings(agentSession?.injectedArtifactIds));

  const findingStore = (run.findingStore ?? run.evidenceStore ?? []).map((entry) => entry.id ? entry : ({
    ...entry,
    id: entry.findingId || entry.evidenceId,
    content: entry.content || entry.claim,
    sourceArtifacts: entry.sourceArtifacts || [],
  }));
  const findingEntries = entriesReferencedBy(context.findingIds, findingStore, 'id');
  const resultEntries = entriesReferencedBy(context.resultIds, run.resultStore, 'resultId');
  const artifactEntries = entriesReferencedBy(context.artifactIds, run.artifactRegistry, 'artifactId');

  const relevantFindings = selectRelevant(findingEntries, {
    agent,
    incomingSourceIds,
    currentNeed: context.currentNeed,
    excludedIds: injectedFindingIds,
    idKey: 'id',
    maximum: MAX_AGENT_EVIDENCE,
  }).filter((entry) => !(resumed && entry.sourceAgentId === agent.id));

  const relevantResults = selectRelevant(resultEntries, {
    agent,
    incomingSourceIds,
    currentNeed: context.currentNeed,
    excludedIds: injectedResultIds,
    idKey: 'resultId',
    maximum: MAX_AGENT_RESULTS,
  }).filter((entry) => !(resumed && entry.agentId === agent.id));

  const relevantArtifactIds = uniqueStrings([
    ...relevantFindings.flatMap((entry) => entry.sourceArtifacts || []),
    ...relevantResults.flatMap((entry) => (entry.artifacts || []).map((artifact) => artifact.artifactId)),
  ]);
  const relevantArtifacts = artifactEntries
    .filter((entry) => relevantArtifactIds.includes(entry.artifactId) && !injectedArtifactIds.has(entry.artifactId))
    .slice(-MAX_AGENT_EVIDENCE);

  return {
    executionId: context.executionId,
    goal: context.goal,
    iteration: context.iteration,
    currentNeed: context.currentNeed,
    questions: context.questions,
    relevantArtifacts: relevantArtifacts.map((entry) => ({
      artifactId: entry.artifactId,
      type: entry.type,
      name: entry.name,
      producerAgentId: entry.producerAgentId,
      metadata: entry.metadata || {},
    })),
    relevantFindings: relevantFindings.map((entry) => ({
      id: entry.id,
      sourceAgent: entry.sourceAgent,
      content: truncate(entry.content),
      sourceArtifacts: uniqueStrings(entry.sourceArtifacts),
      confidence: entry.confidence,
    })),
    relevantResults: relevantResults.map((entry) => ({
      resultId: entry.resultId,
      agentId: entry.agentId,
      agentName: entry.agentName,
      status: entry.status,
      message: truncate(entry.message),
      artifacts: Array.isArray(entry.artifacts) ? entry.artifacts : [],
      findings: Array.isArray(entry.findings) ? entry.findings : [],
    })),
    includedArtifactIds: relevantArtifacts.map((entry) => entry.artifactId),
    includedFindingIds: relevantFindings.map((entry) => entry.id),
    includedResultIds: relevantResults.map((entry) => entry.resultId),
    resumedSession: resumed,
  };
}
