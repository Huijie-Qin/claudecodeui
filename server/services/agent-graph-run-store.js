import { promises as fs } from 'node:fs';
import path from 'node:path';

import { applyWorkspaceOwnership } from './workspace-ownership.js';

const RUNS_DIRECTORY = path.join('.ccui', 'agent-graph-runs');
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireRunId(runId) {
  const value = typeof runId === 'string' ? runId.trim() : '';
  if (!RUN_ID_PATTERN.test(value)) {
    throw createHttpError('Invalid Agent Graph run id');
  }
  return value;
}

function getRunsDirectory(workspacePath) {
  return path.join(path.resolve(workspacePath), RUNS_DIRECTORY);
}

function getRunPath(workspacePath, runId) {
  return path.join(getRunsDirectory(workspacePath), `${requireRunId(runId)}.json`);
}

function assertRun(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !RUN_ID_PATTERN.test(value.id || '')) {
    throw createHttpError('Agent Graph run store is invalid', 500);
  }
  return value;
}

export async function saveAgentGraphRun({ workspacePath, run }) {
  const normalized = assertRun(run);
  const runsDirectory = getRunsDirectory(workspacePath);
  const runPath = getRunPath(workspacePath, normalized.id);
  await fs.mkdir(runsDirectory, { recursive: true });
  const tempPath = `${runPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, runPath);
  await applyWorkspaceOwnership({
    workspaceRoot: workspacePath,
    targetPaths: [runPath],
    reason: 'agent_graph_run_store',
  });
  return structuredClone(normalized);
}

export async function getAgentGraphRun({ workspacePath, runId }) {
  const runPath = getRunPath(workspacePath, runId);
  try {
    return assertRun(JSON.parse(await fs.readFile(runPath, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw createHttpError('Agent Graph run not found', 404);
    }
    if (error instanceof SyntaxError) {
      throw createHttpError('Agent Graph run store contains invalid JSON', 500);
    }
    throw error;
  }
}

export async function listAgentGraphRuns({ workspacePath, graphId, limit = 20 }) {
  const runsDirectory = getRunsDirectory(workspacePath);
  let entries;
  try {
    entries = await fs.readdir(runsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const runs = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map(async (entry) => {
      try {
        return assertRun(JSON.parse(await fs.readFile(path.join(runsDirectory, entry.name), 'utf8')));
      } catch (error) {
        console.warn(`[agent-graph-runs] Ignoring invalid run file ${entry.name}:`, error?.message || error);
        return null;
      }
    }));

  return runs
    .filter((run) => run && (!graphId || run.graphId === graphId))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
    .map((run) => structuredClone(run));
}

export const agentGraphRunStore = {
  saveAgentGraphRun,
  getAgentGraphRun,
  listAgentGraphRuns,
};
