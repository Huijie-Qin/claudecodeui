import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getAgentGraphRun,
  listAgentGraphRuns,
  saveAgentGraphRun,
} from './agent-graph-run-store.js';

test('Agent Graph run store persists individual workspace-scoped run files', async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-graph-runs-'));
  const run = {
    id: 'run-one',
    graphId: 'graph-one',
    status: 'queued',
    createdAt: '2026-08-10T00:00:00.000Z',
  };
  await saveAgentGraphRun({ workspacePath, run });

  assert.deepEqual(await getAgentGraphRun({ workspacePath, runId: run.id }), run);
  assert.deepEqual(await listAgentGraphRuns({ workspacePath, graphId: 'graph-one' }), [run]);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(workspacePath, '.ccui', 'agent-graph-runs', 'run-one.json'), 'utf8')).status,
    'queued',
  );
});

test('Agent Graph run store rejects unsafe ids and hides runs from another Graph', async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-graph-runs-safe-'));
  await saveAgentGraphRun({
    workspacePath,
    run: { id: 'run-safe', graphId: 'graph-a', status: 'completed', createdAt: '2026-08-10T00:00:00.000Z' },
  });
  assert.deepEqual(await listAgentGraphRuns({ workspacePath, graphId: 'graph-b' }), []);
  await assert.rejects(
    () => getAgentGraphRun({ workspacePath, runId: '../auth.db' }),
    (error) => error.statusCode === 400,
  );
});
