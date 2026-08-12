import assert from 'node:assert/strict';
import test from 'node:test';

import { extractAgentResult, formatAgentResult } from './agent-graph-result-extractor.js';

test('Result Extractor normalizes the V1 AgentResult protocol and validates Artifact references', () => {
  const result = extractAgentResult({
    raw: {
      status: 'partial',
      message: 'The query completed with one missing dimension.',
      artifacts: [
        { artifactId: 'dataset-one', type: 'dataset', description: 'July query' },
        { artifactId: 'missing', type: 'file', description: 'Invalid reference' },
      ],
      findings: [{ content: 'July is stable', sourceArtifacts: ['dataset-one', 'missing'], confidence: 1.4 }],
      questions: ['Can we obtain version data?', 'Can we obtain version data?'],
    },
    availableArtifacts: [{ artifactId: 'dataset-one', type: 'dataset', name: 'MCP query result' }],
  });

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.artifacts.map((entry) => entry.artifactId), ['dataset-one']);
  assert.deepEqual(result.findings[0].sourceArtifacts, ['dataset-one']);
  assert.equal(result.findings[0].confidence, 1);
  assert.deepEqual(result.questions, ['Can we obtain version data?']);
  assert.match(formatAgentResult(result), /Artifacts:/);
});

test('Result Extractor supports the previous structured protocol during migration', () => {
  const result = extractAgentResult({
    raw: {
      agent: 'Analyst',
      summary: 'Stable churn',
      type: 'analysis',
      findings: ['No material change'],
      newQuestions: [],
      confidence: 0.9,
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.message, 'Stable churn');
  assert.deepEqual(result.findings, [{ content: 'No material change', sourceArtifacts: [], confidence: 0.9 }]);
});

test('Result Extractor falls back to a partial natural-language result', () => {
  const result = extractAgentResult({ raw: 'plain output' });
  assert.equal(result.status, 'partial');
  assert.equal(result.message, 'plain output');
  assert.equal(result.findings[0].confidence, 0.5);
});
