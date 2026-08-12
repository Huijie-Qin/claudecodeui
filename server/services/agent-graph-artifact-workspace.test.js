import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  captureMcpToolResult,
  getArtifactMetadata,
  initializeExecutionWorkspace,
  listArtifacts,
  readArtifact,
  syncExecutionWorkspace,
} from './agent-graph-artifact-workspace.js';

test('Execution Workspace persists Context, Result, Trace and registered MCP data', async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-graph-artifacts-'));
  await initializeExecutionWorkspace({
    workspacePath,
    executionId: 'exec-one',
    context: { executionId: 'exec-one', resultIds: [] },
  });
  const captured = await captureMcpToolResult({
    workspacePath,
    executionId: 'exec-one',
    producerAgentId: 'agent-one',
    artifactId: 'artifact-one',
    toolName: 'mcp__bi__query',
    toolUseId: 'tool-one',
    toolResponse: { rows: [{ month: 'July', rate: 0.2 }] },
    createdAt: '2026-08-12T00:00:00.000Z',
  });

  assert.equal(captured.reference.artifactId, 'artifact-one');
  assert.equal(captured.artifact.metadata.rowCount, 1);
  assert.equal((await listArtifacts({ workspacePath, executionId: 'exec-one' })).length, 1);
  assert.equal((await getArtifactMetadata({ workspacePath, executionId: 'exec-one', artifactId: 'artifact-one' })).producerAgentId, 'agent-one');
  const content = await readArtifact({ workspacePath, executionId: 'exec-one', artifactId: 'artifact-one' });
  assert.equal(content.encoding, 'utf8');
  assert.match(content.content, /July/);

  const result = { resultId: 'result-one', executionId: 'exec-one', message: 'Done' };
  await syncExecutionWorkspace({
    workspacePath,
    run: { id: 'exec-one', context: { executionId: 'exec-one', resultIds: ['result-one'] }, trace: [{ type: 'completed' }] },
    result,
  });
  const root = path.join(workspacePath, '.ccui', 'agent-graph-executions', 'exec-one');
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'results', 'result-one.json'), 'utf8')).message, 'Done');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'trace', 'execution_trace.json'), 'utf8')), [{ type: 'completed' }]);
});

test('large MCP results are replaced by a bounded Artifact preview', async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-graph-large-artifact-'));
  const captured = await captureMcpToolResult({
    workspacePath,
    executionId: 'exec-large',
    producerAgentId: 'agent-one',
    artifactId: 'artifact-large',
    toolName: 'mcp__hive__query',
    toolResponse: { rows: Array.from({ length: 200 }, (_, index) => ({ index, value: 'x'.repeat(50) })) },
    largeResultThreshold: 100,
    previewLimit: 120,
  });

  assert.equal(captured.claudePayload.truncated, true);
  assert.ok(captured.claudePayload.preview.length < 200);
  const full = await readArtifact({ workspacePath, executionId: 'exec-large', artifactId: 'artifact-large', limit: 64_000 });
  assert.ok(full.content.length > captured.claudePayload.preview.length);
});

test('parallel MCP results keep every Artifact Registry entry', async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-graph-parallel-artifacts-'));
  await Promise.all(Array.from({ length: 12 }, (_, index) => captureMcpToolResult({
    workspacePath,
    executionId: 'exec-parallel',
    producerAgentId: 'agent-one',
    artifactId: `artifact-${index}`,
    toolName: 'mcp__bi__query',
    toolResponse: { rows: [{ index }] },
  })));

  const artifacts = await listArtifacts({ workspacePath, executionId: 'exec-parallel' });
  assert.equal(artifacts.length, 12);
  assert.deepEqual(new Set(artifacts.map((entry) => entry.artifactId)).size, 12);
});

test('Artifact Workspace rejects path-like ids', async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-graph-artifact-safe-'));
  await assert.rejects(
    () => readArtifact({ workspacePath, executionId: '../outside', artifactId: 'artifact-one' }),
    (error) => error.statusCode === 400,
  );
});
