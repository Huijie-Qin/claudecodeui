import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgentSpecificContext,
  buildControllerContext,
  executionContextSnapshot,
} from './agent-graph-context-builder.js';

function createRun() {
  return {
    id: 'execution-one',
    context: {
      executionId: 'execution-one',
      goal: 'Explain churn',
      status: 'running',
      iteration: 3,
      currentNeed: 'Validate profile differences',
      artifactIds: ['a1'],
      findingIds: ['f1', 'f2', 'f3'],
      resultIds: ['r1', 'r2'],
      questions: ['Which profile differs?'],
    },
    graphSnapshot: {
      relations: [{ sourceAgent: 'reports', targetAgent: 'profile' }],
    },
    artifactRegistry: [
      { artifactId: 'a1', type: 'dataset', name: 'July metrics', producerAgentId: 'reports', metadata: { rowCount: 20 } },
    ],
    findingStore: [
      { id: 'f1', sourceAgentId: 'reports', sourceAgent: 'Report Agent', content: 'July churn was stable', sourceArtifacts: ['a1'], confidence: 0.9 },
      { id: 'f2', sourceAgentId: 'profile', sourceAgent: 'Profile Agent', content: 'Previous profile observation', sourceArtifacts: [], confidence: 0.7 },
      { id: 'f3', sourceAgentId: 'reports', sourceAgent: 'Report Agent', content: 'Young users increased', sourceArtifacts: ['a1'], confidence: 0.8 },
    ],
    resultStore: [
      { resultId: 'r1', agentId: 'reports', agentName: 'Report Agent', status: 'completed', message: 'Metrics summary', artifacts: [{ artifactId: 'a1', type: 'dataset', description: 'Metrics' }], findings: [{ id: 'f1' }, { id: 'f3' }] },
      { resultId: 'r2', agentId: 'profile', agentName: 'Profile Agent', status: 'partial', message: 'Previous own result', artifacts: [], findings: [{ id: 'f2' }] },
    ],
  };
}

test('Execution Context snapshot contains task state and references only', () => {
  const snapshot = executionContextSnapshot({
    ...createRun().context,
    userInput: 'legacy input',
    findings: [{ content: 'legacy full finding' }],
    agentResults: [{ content: 'legacy full result' }],
  });

  assert.deepEqual(Object.keys(snapshot), [
    'executionId', 'goal', 'status', 'iteration', 'currentNeed',
    'artifactIds', 'findingIds', 'resultIds', 'questions',
  ]);
  assert.equal(snapshot.userInput, undefined);
  assert.equal(snapshot.findings, undefined);
  assert.equal(snapshot.agentResults, undefined);
});

test('Agent Context Builder injects relevant reference deltas without repeating resumed Agent history', () => {
  const context = buildAgentSpecificContext({
    run: createRun(),
    agent: { id: 'profile', name: 'Profile Agent', workingDescription: 'Analyze user profiles', businessContext: '' },
    agentSession: {
      providerSessionId: 'session-profile',
      injectedArtifactIds: [],
      injectedFindingIds: ['f1'],
      injectedResultIds: [],
    },
  });

  assert.equal(context.resumedSession, true);
  assert.deepEqual(context.includedFindingIds, ['f3']);
  assert.deepEqual(context.includedResultIds, ['r1']);
  assert.deepEqual(context.includedArtifactIds, ['a1']);
  assert.equal(context.relevantFindings[0].content, 'Young users increased');
  assert.equal(context.relevantArtifacts[0].artifactId, 'a1');
});

test('Controller Context resolves referenced Messages, Findings, and Artifact metadata', () => {
  const context = buildControllerContext(createRun());

  assert.deepEqual(context.agentResults.map((result) => result.resultId), ['r1', 'r2']);
  assert.deepEqual(context.findings.map((finding) => finding.id), ['f1', 'f2', 'f3']);
  assert.deepEqual(context.artifacts.map((artifact) => artifact.artifactId), ['a1']);
  assert.equal(context.agentResults[0].message, 'Metrics summary');
});
