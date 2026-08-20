import assert from 'node:assert/strict';
import test from 'node:test';

import { createTopSkillJobsService } from './top-skill-jobs.js';

test('Top Skill jobs execute outside the request path and expose completed results', async () => {
  let scheduled;
  const seen = {};
  const jobs = createTopSkillJobsService({
    createId: () => 'job-one',
    now: () => 1_700_000_000_000,
    schedule: (callback) => { scheduled = callback; },
    generator: async (request) => {
      seen.request = request;
      return { topSkill: 'generated', generator: 'skill-creator', source: 'installed' };
    },
  });

  const queued = jobs.startTopSkillJob({
    operation: 'generate',
    workspacePath: '/tmp/workspace',
    tenantId: 2,
    userId: 7,
    workspaceId: 10,
    input: { name: 'Analyst' },
  });
  assert.equal(queued.status, 'queued');
  assert.equal(seen.request, undefined);
  assert.equal(jobs.getActiveJobCount(), 1);

  await scheduled();
  assert.equal(jobs.getActiveJobCount(), 0);
  const completed = jobs.getTopSkillJob({ jobId: 'job-one', tenantId: 2, userId: 7, workspaceId: 10 });
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result.topSkill, 'generated');
  assert.equal(seen.request.workspacePath, '/tmp/workspace');
});

test('Top Skill jobs route optimization and isolate status by tenant, user, and workspace', async () => {
  let scheduled;
  const jobs = createTopSkillJobsService({
    createId: () => 'job-optimize',
    schedule: (callback) => { scheduled = callback; },
    optimizer: async () => { throw new Error('optimization failed'); },
  });
  jobs.startTopSkillJob({
    operation: 'optimize',
    workspacePath: '/tmp/workspace',
    tenantId: 2,
    userId: 7,
    workspaceId: 10,
    input: { optimizationPrompt: 'Be concise' },
  });
  await scheduled();

  const failed = jobs.getTopSkillJob({ jobId: 'job-optimize', tenantId: 2, userId: 7, workspaceId: 10 });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'optimization failed');
  assert.throws(
    () => jobs.getTopSkillJob({ jobId: 'job-optimize', tenantId: 2, userId: 8, workspaceId: 10 }),
    (error) => error.statusCode === 404,
  );
});

test('Top Skill jobs reject unsupported operations before scheduling', () => {
  const jobs = createTopSkillJobsService({ schedule: () => assert.fail('must not schedule') });
  assert.throws(
    () => jobs.startTopSkillJob({ operation: 'delete' }),
    (error) => error.statusCode === 400,
  );
});

test('Top Skill jobs abort queued Claude work during forced shutdown', async () => {
  let scheduled;
  let generatorCalled = false;
  const jobs = createTopSkillJobsService({
    createId: () => 'job-cancelled',
    schedule: (callback) => { scheduled = callback; },
    generator: async () => { generatorCalled = true; },
  });
  jobs.startTopSkillJob({
    operation: 'generate',
    workspacePath: '/tmp/workspace',
    tenantId: 2,
    userId: 7,
    workspaceId: 10,
    input: { name: 'Analyst' },
  });

  assert.equal(jobs.abortAllActiveJobs(), 1);
  await scheduled();
  assert.equal(generatorCalled, false);
  assert.equal(jobs.getActiveJobCount(), 0);
  const cancelled = jobs.getTopSkillJob({
    jobId: 'job-cancelled', tenantId: 2, userId: 7, workspaceId: 10,
  });
  assert.equal(cancelled.status, 'failed');
  assert.match(cancelled.error, /cancelled/);
});

test('Top Skill jobs forward forced shutdown aborts to running Claude work', async () => {
  let scheduled;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const jobs = createTopSkillJobsService({
    createId: () => 'job-running',
    schedule: (callback) => { scheduled = callback; },
    generator: async ({ abortController }) => new Promise((resolve, reject) => {
      markStarted();
      abortController.signal.addEventListener('abort', () => reject(new Error('runner aborted')), { once: true });
    }),
  });
  jobs.startTopSkillJob({
    operation: 'generate',
    workspacePath: '/tmp/workspace',
    tenantId: 2,
    userId: 7,
    workspaceId: 10,
    input: { name: 'Analyst' },
  });

  const running = scheduled();
  await started;
  assert.equal(jobs.getActiveJobCount(), 1);
  assert.equal(jobs.abortAllActiveJobs(), 1);
  await running;
  assert.equal(jobs.getActiveJobCount(), 0);
  const cancelled = jobs.getTopSkillJob({
    jobId: 'job-running', tenantId: 2, userId: 7, workspaceId: 10,
  });
  assert.equal(cancelled.status, 'failed');
  assert.equal(cancelled.error, 'runner aborted');
});
