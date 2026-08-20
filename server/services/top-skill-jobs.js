import crypto from 'node:crypto';

import { generateTopSkill, optimizeTopSkill } from './agent-graphs.js';

const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_JOBS = 200;
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const OPERATIONS = new Set(['generate', 'optimize']);

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function publicJob(job) {
  return {
    id: job.id,
    operation: job.operation,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

export function createTopSkillJobsService({
  generator = generateTopSkill,
  optimizer = optimizeTopSkill,
  createId = () => crypto.randomUUID(),
  now = () => Date.now(),
  schedule = (callback) => queueMicrotask(callback),
  jobTtlMs = DEFAULT_JOB_TTL_MS,
  maxJobs = DEFAULT_MAX_JOBS,
} = {}) {
  const jobs = new Map();

  function cleanup() {
    const expiry = now() - jobTtlMs;
    for (const [jobId, job] of jobs) {
      if (!ACTIVE_STATUSES.has(job.status) && job.completedAtMs <= expiry) {
        jobs.delete(jobId);
      }
    }
  }

  async function run(job) {
    job.status = 'running';
    job.startedAtMs = now();
    job.startedAt = new Date(job.startedAtMs).toISOString();
    try {
      if (job.abortController.signal.aborted) throw new Error('Top Skill job was cancelled');
      const runner = job.operation === 'optimize' ? optimizer : generator;
      job.result = await runner({
        ...job.request,
        abortController: job.abortController,
      });
      job.status = 'succeeded';
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Top Skill job failed';
    } finally {
      job.completedAtMs = now();
      job.completedAt = new Date(job.completedAtMs).toISOString();
      delete job.request;
    }
  }

  function startTopSkillJob({ operation = 'generate', workspacePath, tenantId, userId, workspaceId, input }) {
    cleanup();
    if (!OPERATIONS.has(operation)) {
      throw createHttpError('operation must be generate or optimize', 400);
    }
    if (jobs.size >= maxJobs) {
      throw createHttpError('Too many Top Skill jobs are active; try again later', 429);
    }

    const createdAtMs = now();
    const job = {
      id: createId(),
      operation,
      status: 'queued',
      tenantId: Number(tenantId),
      userId: Number(userId),
      workspaceId: Number(workspaceId),
      createdAtMs,
      createdAt: new Date(createdAtMs).toISOString(),
      startedAt: null,
      completedAt: null,
      completedAtMs: null,
      result: null,
      error: null,
      request: { workspacePath, tenantId, userId, workspaceId, input },
      abortController: new AbortController(),
    };
    jobs.set(job.id, job);
    schedule(() => run(job));
    return publicJob(job);
  }

  function getTopSkillJob({ jobId, tenantId, userId, workspaceId }) {
    cleanup();
    const job = jobs.get(String(jobId));
    if (
      !job
      || job.tenantId !== Number(tenantId)
      || job.userId !== Number(userId)
      || job.workspaceId !== Number(workspaceId)
    ) {
      throw createHttpError('Top Skill job not found', 404);
    }
    return publicJob(job);
  }

  function getActiveJobCount() {
    let count = 0;
    for (const job of jobs.values()) {
      if (ACTIVE_STATUSES.has(job.status)) count += 1;
    }
    return count;
  }

  function abortAllActiveJobs() {
    let count = 0;
    for (const job of jobs.values()) {
      if (!ACTIVE_STATUSES.has(job.status)) continue;
      job.abortController.abort();
      count += 1;
    }
    return count;
  }

  return {
    startTopSkillJob,
    getTopSkillJob,
    getActiveJobCount,
    abortAllActiveJobs,
  };
}

export const topSkillJobsService = createTopSkillJobsService();
