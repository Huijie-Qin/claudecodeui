import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSessionSkillLearningService } from './session-skill-learning-service.js';
import * as skills from './workspace-skills.js';

const manifest = (rule = 'Add the input numbers.') => `---\nname: add-numbers\ndescription: Add numbers supplied as text.\n---\n${rule}\n`;
const example = [{ id: 'u1', role: 'user', kind: 'text', content: 'Add 1 and 2.' }, { id: 'a1', role: 'assistant', kind: 'text', content: '3' }];
const scope = { tenantId: 2, userId: 7, workspaceId: 10 };
const passedResult = (overrides = {}) => ({ skillName: 'add-numbers', input: 'Add 1 and 2.', expectedOutput: '3', actualOutput: '3', passed: true,
  skillContent: manifest(), iterations: [{ iteration: 1, actualOutput: '3', passed: true, feedback: '' }],
  testCases: [{ input: 'Add 1 and 2.', expectedOutput: '3' }], ...overrides });

async function setup(t, dependencies = {}) {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'session-skill-learning-'));
  const workspacePath = path.join(testRoot, 'workspace');
  const storageRoot = path.join(testRoot, 'private-learning');
  await fs.mkdir(workspacePath);
  t.after(() => fs.rm(testRoot, { recursive: true, force: true }));
  const service = createSessionSkillLearningService({ storageRoot, learn: async () => passedResult(), ...dependencies });
  const options = { ...scope, workspacePath, provider: 'claude', sessionId: 'session-1', operation: 'generate', skillName: 'add-numbers', messages: example };
  const skillPath = path.join(workspacePath, '.claude', 'skills', 'add-numbers', 'SKILL.md');
  return { service, options, workspacePath, storageRoot, skillPath };
}

async function finish(service, job) {
  for (let attempts = 0; attempts < 1000; attempts += 1) {
    const snapshot = service.getJob({ ...scope, jobId: job.id });
    if (['failed', 'exhausted', 'succeeded'].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Job did not finish');
}

async function savedRecords(storageRoot) {
  const root = storageRoot;
  const [scopeDirectory] = await fs.readdir(root);
  const directory = path.join(root, scopeDirectory, 'add-numbers');
  const files = await fs.readdir(directory);
  return Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => [file, JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'))]));
}

test('generation uses an immutable transcript, saves only a passing skill, and records its source and cases', async (t) => {
  let seen;
  const { service, options, workspacePath, storageRoot, skillPath } = await setup(t, { learn: async (args) => { seen = args; return passedResult(); } });
  const requestMessages = structuredClone(example);
  const job = await service.startJob({ ...options, messages: requestMessages });
  requestMessages[0].content = 'changed after submission';
  assert.equal(job.status, 'queued');
  const result = await finish(service, job);
  assert.equal(result.status, 'succeeded');
  assert.equal(seen.messages[0].content, 'Add 1 and 2.');
  assert.equal(result.result.skillPath, '.claude/skills/add-numbers/SKILL.md');
  assert.equal(await fs.readFile(skillPath, 'utf8'), manifest().trim());
  const records = new Map(await savedRecords(storageRoot));
  assert.equal(records.get(`${job.id}.json`).messages[0].content, 'Add 1 and 2.');
  assert.deepEqual(records.get('latest.json').testCases, passedResult().testCases);
  await assert.rejects(fs.stat(path.join(workspacePath, '.cloudcli', 'session-skill-learning')), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(workspacePath, { recursive: true })).filter((entry) => entry.endsWith('.json')), []);
  assert.equal(JSON.stringify(result).includes(storageRoot), false);
  assert.equal((await fs.stat(storageRoot)).mode & 0o777, 0o700);
});

test('exhausted generation never installs a candidate', async (t) => {
  const { service, options, skillPath } = await setup(t, { learn: async () => passedResult({ passed: false, actualOutput: '4' }) });
  const result = await finish(service, await service.startJob(options));
  assert.equal(result.status, 'exhausted');
  await assert.rejects(fs.stat(skillPath), { code: 'ENOENT' });
});

test('optimization loads the current skill and prior accepted cases; failed optimization preserves old skill', async (t) => {
  let calls = 0;
  let optimization;
  const { service, options, skillPath } = await setup(t, { learn: async (args) => {
    calls += 1;
    if (calls === 1) return passedResult();
    optimization = args;
    return passedResult({ passed: false, skillContent: manifest('Wrong new instructions.') });
  } });
  await finish(service, await service.startJob(options));
  const result = await finish(service, await service.startJob({ ...options, operation: 'optimize', sessionId: 'session-2' }));
  assert.equal(result.status, 'exhausted');
  assert.equal(optimization.currentSkill, manifest().trim());
  assert.deepEqual(optimization.previousCases, passedResult().testCases);
  assert.equal(await fs.readFile(skillPath, 'utf8'), manifest().trim());
});

test('a passing optimization updates the skill and retains the previous version for review', async (t) => {
  const { service, options, workspacePath, storageRoot, skillPath } = await setup(t, { learn: async () => passedResult({ skillContent: manifest('Sum all supplied integers.') }) });
  await skills.createWorkspaceSkill({ workspacePath, name: 'add-numbers', content: manifest() });
  const job = await service.startJob({ ...options, operation: 'optimize' });
  const result = await finish(service, job);
  assert.equal(result.status, 'succeeded');
  assert.equal(await fs.readFile(skillPath, 'utf8'), manifest('Sum all supplied integers.'));
  const records = new Map(await savedRecords(storageRoot));
  assert.equal(records.get(`${job.id}.json`).baseline.currentSkill, manifest().trim());
});

test('manual skill edits during learning are preserved by the revision check', async (t) => {
  const { options, workspacePath, storageRoot, skillPath } = await setup(t);
  await skills.createWorkspaceSkill({ workspacePath, name: 'add-numbers', content: manifest() });
  const manual = manifest('User edited this manually.');
  const service = createSessionSkillLearningService({ storageRoot, learn: async () => {
    await fs.writeFile(skillPath, manual);
    return passedResult();
  } });
  const result = await finish(service, await service.startJob({ ...options, operation: 'optimize' }));
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 409);
  assert.equal(result.result.passed, true);
  assert.equal(await fs.readFile(skillPath, 'utf8'), manual);
});

test('jobs and regression cases do not leak across user scopes', async (t) => {
  let observedCases;
  const { service, options } = await setup(t, { learn: async (args) => {
    observedCases = args.previousCases;
    return passedResult();
  } });
  const job = await service.startJob(options);
  await finish(service, job);
  assert.throws(() => service.getJob({ ...scope, userId: 8, jobId: job.id }), { statusCode: 404 });
  assert.throws(() => service.getJob({ ...scope, tenantId: 3, jobId: job.id }), { statusCode: 404 });
  const other = await service.startJob({ ...options, userId: 8, operation: 'optimize' });
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (service.getJob({ ...scope, userId: 8, jobId: other.id }).status === 'succeeded') break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.deepEqual(observedCases, []);
});

test('same-workspace skill jobs conflict even for different users', async (t) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { service, options } = await setup(t, { learn: async () => { await pending; return passedResult(); } });
  const job = await service.startJob(options);
  await assert.rejects(service.startJob({ ...options, userId: 8 }), { statusCode: 409 });
  release();
  assert.equal((await finish(service, job)).status, 'succeeded');
});

test('timeout aborts the runtime and never saves a late passing result', async (t) => {
  let release;
  let signal;
  const pending = new Promise((resolve) => { release = resolve; });
  const { service, options, skillPath } = await setup(t, {
    timeoutMs: 20,
    complete: async (args) => { signal = args.signal; await pending; return 'result'; },
    learn: async ({ complete }) => { await complete({ phase: 'execute', systemPrompt: 'test', prompt: 'test' }); return passedResult(); },
  });
  const result = await finish(service, await service.startJob(options));
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 504);
  assert.equal(signal.aborted, true);
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(fs.stat(skillPath), { code: 'ENOENT' });
});

test('generation rejects name conflicts and invalid names or iteration limits', async (t) => {
  const { service, options, workspacePath } = await setup(t);
  for (const skillName of ['../escape', 'Capital', '', 'a'.repeat(65)]) {
    await assert.rejects(service.startJob({ ...options, skillName }), { statusCode: 400 });
  }
  await assert.rejects(service.startJob({ ...options, maxIterations: 6 }), { statusCode: 400 });
  await skills.createWorkspaceSkill({ workspacePath, name: 'add-numbers', content: manifest() });
  await assert.rejects(service.startJob(options), { statusCode: 409 });
});

test('optimization rejects auxiliary files and marketplace skills', async (t) => {
  const { service, options, workspacePath, storageRoot, skillPath } = await setup(t);
  await skills.createWorkspaceSkill({ workspacePath, name: 'add-numbers', content: manifest() });
  await fs.writeFile(path.join(path.dirname(skillPath), 'helper.py'), 'print(1)');
  await assert.rejects(service.startJob({ ...options, operation: 'optimize' }), /one text SKILL.md/);
  await fs.rm(path.join(path.dirname(skillPath), 'helper.py'));
  const marketService = createSessionSkillLearningService({ storageRoot, getMarketImports: () => [{ name: 'add-numbers', origin: 'market' }] });
  await assert.rejects(marketService.startJob({ ...options, operation: 'optimize' }), /marketplace or managed/);
});

test('symlinked skill and private storage directories are rejected', async (t) => {
  const { service, options, workspacePath, storageRoot } = await setup(t);
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-learning-outside-'));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  await fs.symlink(external, storageRoot);
  await assert.rejects(service.startJob(options), { statusCode: 403 });
  assert.deepEqual(await fs.readdir(external), []);
  await fs.rm(storageRoot);
  await fs.symlink(external, path.join(workspacePath, '.claude'));
  await assert.rejects(service.startJob(options), { statusCode: 403 });
});


test('server-private learning storage cannot be configured inside the shared workspace', async (t) => {
  const { options, workspacePath } = await setup(t);
  const service = createSessionSkillLearningService({ storageRoot: path.join(workspacePath, 'private-learning') });
  await assert.rejects(service.startJob(options), /cannot be inside a workspace/);
  assert.deepEqual(await fs.readdir(workspacePath), []);
});

test('a server storage parent alias into the workspace is rejected before any record is written', async (t) => {
  const { options, workspacePath, storageRoot } = await setup(t);
  const alias = path.join(path.dirname(storageRoot), 'workspace-alias');
  await fs.symlink(workspacePath, alias);
  const service = createSessionSkillLearningService({ storageRoot: path.join(alias, 'private-learning') });
  await assert.rejects(service.startJob(options), /cannot be inside a workspace/);
  assert.deepEqual(await fs.readdir(workspacePath), []);
});
