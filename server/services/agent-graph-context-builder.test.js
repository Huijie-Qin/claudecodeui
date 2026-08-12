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
      evidenceIds: ['e1', 'e2', 'e3'],
      resultIds: ['r1', 'r2'],
      pendingQuestions: ['Which profile differs?'],
    },
    graphSnapshot: {
      relations: [{ sourceAgent: 'reports', targetAgent: 'profile' }],
    },
    evidenceStore: [
      { evidenceId: 'e1', sourceAgentId: 'reports', sourceAgent: 'Report Agent', claim: 'July churn was stable', confidence: 0.9 },
      { evidenceId: 'e2', sourceAgentId: 'profile', sourceAgent: 'Profile Agent', claim: 'Previous profile observation', confidence: 0.7 },
      { evidenceId: 'e3', sourceAgentId: 'reports', sourceAgent: 'Report Agent', claim: 'Young users increased', confidence: 0.8 },
    ],
    resultStore: [
      { resultId: 'r1', agentId: 'reports', agentName: 'Report Agent', type: 'data', summary: 'Metrics summary', content: 'large private output', evidenceIds: ['e1', 'e3'] },
      { resultId: 'r2', agentId: 'profile', agentName: 'Profile Agent', type: 'profile', summary: 'Previous own result', content: 'large own history', evidenceIds: ['e2'] },
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
    'executionId',
    'goal',
    'status',
    'iteration',
    'currentNeed',
    'evidenceIds',
    'resultIds',
    'pendingQuestions',
  ]);
  assert.equal(snapshot.userInput, undefined);
  assert.equal(snapshot.findings, undefined);
  assert.equal(snapshot.agentResults, undefined);
});

test('Agent Context Builder injects relevant deltas without repeating resumed Agent history', () => {
  const run = createRun();
  const context = buildAgentSpecificContext({
    run,
    agent: {
      id: 'profile',
      name: 'Profile Agent',
      workingDescription: 'Analyze user profiles',
      businessContext: '',
    },
    agentSession: {
      providerSessionId: 'session-profile',
      injectedEvidenceIds: ['e1'],
      injectedResultIds: [],
    },
  });

  assert.equal(context.resumedSession, true);
  assert.deepEqual(context.includedEvidenceIds, ['e3']);
  assert.deepEqual(context.includedResultIds, ['r1']);
  assert.equal(context.relevantEvidence[0].claim, 'Young users increased');
  assert.equal(context.relevantResults[0].content, undefined);
  assert.doesNotMatch(JSON.stringify(context), /large private output|large own history/);
});

test('Controller Context resolves referenced summaries without full Agent output', () => {
  const context = buildControllerContext(createRun());

  assert.deepEqual(context.agentResults.map((result) => result.resultId), ['r1', 'r2']);
  assert.deepEqual(context.evidence.map((evidence) => evidence.evidenceId), ['e1', 'e2', 'e3']);
  assert.doesNotMatch(JSON.stringify(context), /large private output|large own history/);
});
