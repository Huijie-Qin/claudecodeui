import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import { createSkillEvaluationDb } from '../../database/skill-evaluation-db.js';
import { readWorkspaceSkillFile, updateWorkspaceSkillFile } from '../workspace-skills.js';

import { createSkillEvaluationService } from './service.js';
import { applyChanges, commitCandidate, recoverCommit } from './commit.js';
import { validateStart, parseEvals, inputFileName, relativePath } from './contracts.js';
import { atomicJson, readTree, treeHash } from './files.js';
import { validateGrade } from './grading.js';
import { GENERATE_CASES_PROMPT } from './prompts.js';

const skill = '---\nname: weekly\ndescription: Write a weekly report\n---\nReport results.\n';
const document = { skill_name: 'weekly', evals: [{ id: 1, prompt: 'Report the week', expected_output: 'Report the week without inventing numbers', expectations: ['No invented numbers'], files: [] }] };
async function fixture(t, overrides = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-test-'));
  const workspacePath = path.join(temp, 'workspace'), root = path.join(workspacePath, '.claude/skills/weekly');
  await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, 'SKILL.md'), skill);
  await atomicJson(path.join(root, 'evals/evals.json'), document);
  const db = new Database(':memory:'), repository = createSkillEvaluationDb(db);
  const scope = { tenantId: 1, workspaceId: 2, userId: 3, workspacePath, name: 'weekly' };
  const runtime = {
    preflight: async () => ({ image: 'test-image', model: 'test-model' }),
    cleanupJob: async () => {},
    runCase: async ({ testCase }) => {
      assert.equal(testCase.expected_output, undefined, 'Runner must not receive expected answers');
      assert.equal(testCase.expectations, undefined);
      return { complete: true, finalText: 'Report', events: [{ id: 'message:1', seq: 1, role: 'assistant', kind: 'text', text: 'Report' }], artifacts: {} };
    },
    modelCall: async ({ prompt }) => {
      const data = JSON.parse(prompt);
      return { structured: { checks: data.checks.map((c) => ({ id: c.id, status: 'passed', reason: 'Matches the supplied evidence', evidenceRefs: ['message:1'] })) } };
    },
    ...overrides,
  };
  const service = createSkillEvaluationService({ repository, runtime, storageRoot: path.join(temp, 'reports') });
  t.after(async () => { await service.stopWorker(); db.close(); await fs.rm(temp, { recursive: true, force: true }); });
  const start = async (mode = 'run-all', extra = {}) => {
    const loaded = await service.listCases(scope);
    return service.start(scope, { mode, requestId: randomUUID(), expectedContentHash: loaded.contentHash, expectedEvalsRevision: loaded.revision, ...extra });
  };
  return { temp, root, scope, repository, runtime, service, start };
}

test('schema rejects unknown fields, traversal and invalid iteration limits', () => {
  assert.throws(() => parseEvals(JSON.stringify({ ...document, other: true }), 'weekly'));
  assert.throws(() => parseEvals(JSON.stringify({ ...document, evals: [{ ...document.evals[0], files: ['../answer'] }] }), 'weekly'));
  for (const value of [0, 11, '3', null, 2.5]) assert.throws(() => validateStart({ mode: 'optimize', requestId: randomUUID(), expectedContentHash: '', expectedEvalsRevision: '', maxIterations: value }));
});
test('evaluation isolates answers, persists complete report and gives real latest state', async (t) => {
  const f = await fixture(t); const job = await f.start();
  await f.service.runPendingForTest();
  const latest = await f.service.latest(f.scope);
  assert.equal(latest.id, job.id); assert.equal(latest.outcome, 'passed'); assert.equal(latest.current, true);
  const report = await f.service.report(f.scope, job.id, 0, 1);
  assert.equal(report.checks.length, 2); assert.equal(report.evidence.events.length, 1);
});
test('second accepted run replaces report even when it fails, and deletes old artifacts', async (t) => {
  const f = await fixture(t); const first = await f.start(); await f.service.runPendingForTest();
  f.runtime.runCase = async () => { throw new Error('Tool offline'); };
  const second = await f.start();
  assert.throws(() => f.service.get(f.scope, first.id), (e) => e.statusCode === 410);
  assert.equal((await f.service.latest(f.scope)).id, second.id);
  await f.service.runPendingForTest(); await f.service.cleanReplaced();
  assert.equal((await f.service.latest(f.scope)).outcome, 'error');
  await assert.rejects(fs.stat(path.join(f.temp, 'reports', first.id)), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, 'evals/evals.json'), 'utf8')), document);
});
test('tool limit failure finishes the job and retains case evidence instead of staying running', async t => {
  const event = { id: 'message:1', seq: 1, role: 'assistant', kind: 'text', text: 'Working' };
  const reason = '测试用例的工具调用次数已达到上限（100 次），已停止。可通过 SKILL_EVAL_MAX_TOOL_CALLS 调整。';
  const f = await fixture(t, { runCase: async ({ onEvent }) => {
    onEvent(event);
    throw Object.assign(new Error(reason), { code: 'EVAL_LIMIT_EXCEEDED', evidence: { events: [event], artifacts: {}, complete: false } });
  } });
  const job = await f.start();
  await f.service.runPendingForTest();
  const latest = await f.service.latest(f.scope);
  assert.equal(latest.status, 'failed');
  assert.equal(latest.stopReason, 'EVAL_LIMIT_EXCEEDED');
  assert.equal(latest.rounds[0].cases[0].status, 'error');
  const report = await f.service.report(f.scope, job.id, 0, 1);
  assert.equal(report.status, 'error');
  assert.equal(report.reason, reason);
  assert.equal(report.evidence.events[0].text, event.text);
});
test('rejected start preserves previous report; duplicate requests do not replace it', async (t) => {
  const f = await fixture(t), data = await f.service.listCases(f.scope);
  const request = { mode: 'run-all', requestId: randomUUID(), expectedContentHash: data.contentHash, expectedEvalsRevision: data.revision };
  const one = await f.service.start(f.scope, request);
  const two = await f.service.start(f.scope, request);
  assert.equal(one.id, two.id);
  await assert.rejects(f.start(), (e) => e.code === 'SKILL_JOB_BUSY');
  await f.service.runPendingForTest();
  await assert.rejects(f.service.start(f.scope, { ...request, requestId: randomUUID(), expectedContentHash: 'wrong' }), (e) => e.code === 'EVAL_REVISION_CONFLICT');
  assert.equal((await f.service.latest(f.scope)).id, one.id);
});
test('case revisions and protected IDs prevent lost writes and deletion', async (t) => {
  const f = await fixture(t), current = await f.service.listCases(f.scope);
  await f.service.mutateCases(f.scope, current.revision, (doc, next) => doc.evals.push({ ...document.evals[0], id: next }));
  await assert.rejects(f.service.mutateCases(f.scope, current.revision, (doc) => { doc.evals = []; }), (e) => e.statusCode === 409);
  const latest = await f.service.listCases(f.scope), meta = f.repository.meta(f.scope.workspacePath, 'weekly');
  meta.protectedIds = [1]; f.repository.saveMeta(f.scope.workspacePath, 'weekly', meta);
  await assert.rejects(f.service.mutateCases(f.scope, latest.revision, (doc) => { doc.evals = []; }), (e) => e.code === 'EVAL_PROTECTED_CASE');
});
test('empty tests never pass and symlinks are rejected', async (t) => {
  const f = await fixture(t);
  await atomicJson(path.join(f.root, 'evals/evals.json'), { skill_name: 'weekly', evals: [] });
  await assert.rejects(f.start(), (e) => e.code === 'EVAL_EMPTY_CASES');
  await fs.symlink('/etc/passwd', path.join(f.root, 'escape'));
  await assert.rejects(f.service.listCases(f.scope), (e) => e.code === 'EVAL_UNSAFE_PATH');
});
test('optimization does not change an already passing skill', async (t) => {
  const f = await fixture(t); await f.start('optimize'); await f.service.runPendingForTest();
  const job = await f.service.latest(f.scope);
  assert.equal(job.iteration, 0); assert.equal(job.stopReason, 'all_passed');
  assert.equal(await fs.readFile(path.join(f.root, 'SKILL.md'), 'utf8'), skill);
});
test('optimization runs full before/after and commits allowed changes', async (t) => {
  let executions = 0;
  const f = await fixture(t, { modelCall: async ({ prompt }) => {
    const data = JSON.parse(prompt);
    if (data.reports) return { structured: { reason: 'Add missing guidance', changes: [{ path: 'SKILL.md', operation: 'write', content: skill + '\nNever invent numbers.\n' }] } };
    executions++;
    return { structured: { checks: data.checks.map((c) => ({ id: c.id, status: executions === 1 ? 'failed' : 'passed', reason: 'Evidence comparison', evidenceRefs: ['message:1'] })) } };
  } });
  const job = await f.start('optimize'); await f.service.runPendingForTest();
  const latest = await f.service.latest(f.scope);
  assert.equal(latest.outcome, 'passed'); assert.equal(latest.iteration, 1); assert.equal(latest.rounds.length, 2);
  assert.match(await fs.readFile(path.join(f.root, 'SKILL.md'), 'utf8'), /Never invent/);
  assert.equal((await f.service.diff(f.scope, job.id)).files.length, 1);
});
test('no-op optimizer consumes iterations and never silently succeeds', async (t) => {
  const f = await fixture(t, { modelCall: async ({ prompt }) => {
    const data = JSON.parse(prompt);
    return { structured: data.reports ? { changes: [], reason: 'No changes' } : { checks: data.checks.map((c) => ({ id: c.id, status: 'failed', reason: 'Missing requirement', evidenceRefs: ['message:1'] })) } };
  } });
  await f.start('optimize', { maxIterations: 1 }); await f.service.runPendingForTest();
  const job = await f.service.latest(f.scope);
  assert.equal(job.iteration, 1); assert.equal(job.rounds.length, 2); assert.equal(job.stopReason, 'max_iterations'); assert.equal(job.outcome, 'failed');
});
test('external edit prevents writeback but candidate retesting continues', async (t) => {
  let f, grades = 0;
  f = await fixture(t, { modelCall: async ({ prompt }) => {
    const data = JSON.parse(prompt);
    if (data.reports) {
      await fs.writeFile(path.join(f.root, 'SKILL.md'), skill + '\nUser edit\n');
      return { structured: { changes: [{ path: 'SKILL.md', operation: 'write', content: skill + '\nCandidate edit\n' }] } };
    }
    grades++;
    return { structured: { checks: data.checks.map((c) => ({ id: c.id, status: grades === 1 ? 'failed' : 'passed', reason: 'Evidence comparison', evidenceRefs: ['message:1'] })) } };
  } });
  await f.start('optimize'); await f.service.runPendingForTest();
  const job = await f.service.latest(f.scope);
  assert.equal(job.outcome, 'passed'); assert.equal(job.writebackStatus, 'conflict'); assert.equal(job.current, false);
  assert.match(await fs.readFile(path.join(f.root, 'SKILL.md'), 'utf8'), /User edit/);
});
test('queued cancellation persists and cannot fall back to old run', async (t) => {
  const f = await fixture(t), job = await f.start();
  await f.service.cancel(f.scope, job.id); await f.service.runPendingForTest();
  assert.equal((await f.service.latest(f.scope)).status, 'cancelled');
});
test('restart marks unfinished work interrupted, without replaying tools', async (t) => {
  let executions = 0;
  const f = await fixture(t, { runCase: async () => { executions++; throw new Error('Must not execute'); } });
  const job = await f.start(); const internal = f.repository.get(f.scope, job.id);
  internal.status = 'running'; f.repository.save(internal);
  await f.service.runPendingForTest();
  assert.equal((await f.service.latest(f.scope)).status, 'interrupted'); assert.equal(executions, 0);
});
test('authorization scopes hide another tenant or workspace', async (t) => {
  const f = await fixture(t), job = await f.start();
  assert.throws(() => f.service.get({ ...f.scope, tenantId: 4 }, job.id), (e) => e.statusCode === 404);
  assert.throws(() => f.service.get({ ...f.scope, workspaceId: 4 }, job.id), (e) => e.statusCode === 404);
});
test('reviewer cannot omit checks or invent references; optimizer cannot edit tests', () => {
  assert.throws(() => validateGrade({ checks: [] }, [{ id: 'a' }], new Set()));
  assert.throws(() => validateGrade({ checks: [{ id: 'a', status: 'passed', reason: 'ok', evidenceRefs: ['fake'] }] }, [{ id: 'a' }], new Set()));
  assert.throws(() => applyChanges({}, [{ path: 'evals/evals.json', operation: 'write', content: '{}' }]));
});
test('interrupted file transaction can restore a complete skill', async (t) => {
  const f = await fixture(t), before = await readTree(f.root);
  const journalPath = path.join(f.temp, 'commit.json'), staged = `${f.root}.stage`, backup = `${f.root}.backup`;
  await fs.rename(f.root, backup);
  await atomicJson(journalPath, { target: f.root, staged, backup, expectedHash: treeHash(before), candidateHash: 'unused' });
  await recoverCommit(f.scope, journalPath);
  assert.equal(treeHash(await readTree(f.root)), treeHash(before));
});
test('commit rejects a changed target without deleting user edits', async (t) => {
  const f = await fixture(t), before = await readTree(f.root);
  await fs.writeFile(path.join(f.root, 'SKILL.md'), skill + '\nnew edit');
  const result = await commitCandidate({ scope: f.scope, files: before, expectedHash: treeHash(before), journalPath: path.join(f.temp, 'commit.json'), signal: new AbortController().signal });
  assert.equal(result.status, 'conflict'); assert.match(await fs.readFile(path.join(f.root, 'SKILL.md'), 'utf8'), /new edit/);
});

test('cancelling an executing job survives stale worker saves and prevents optimization', async (t) => {
  let f, started;
  f = await fixture(t, { runCase: async () => {
    await f.service.cancel(f.scope, started.id);
    return { complete: true, finalText: 'Report', events: [{ id: 'message:1', text: 'Report' }], artifacts: {} };
  } });
  started = await f.start('optimize');
  await f.service.runPendingForTest();
  const job = await f.service.latest(f.scope);
  assert.equal(job.status, 'cancelled'); assert.equal(job.iteration, 0);
});
test('worker shutdown is recorded as interrupted execution rather than user cancellation', async t => {
  let f;
  f = await fixture(t, { runCase: async () => {
    await f.service.stopWorker();
    throw new Error('Claude Code process aborted by user');
  } });
  const job = await f.start();
  await f.service.runPendingForTest();
  const latest = await f.service.latest(f.scope);
  assert.equal(latest.status, 'failed');
  assert.equal(latest.stopReason, 'EVAL_SERVER_STOP');
  const report = await f.service.report(f.scope, job.id, 0, 1);
  assert.equal(report.status, 'error');
  assert.equal(report.code, 'EVAL_SERVER_STOP');
  assert.match(report.reason, /服务正在停止或重启/);
});
test('AI generation is durable, mutually exclusive and leaves the latest evaluation intact', async (t) => {
  const f = await fixture(t); const run = await f.start(); await f.service.runPendingForTest();
  let generationCalls = 0;
  f.runtime.modelCall = async ({ systemPrompt, prompt }) => {
    generationCalls++;
    assert.equal(systemPrompt, GENERATE_CASES_PROMPT);
    assert.deepEqual(JSON.parse(prompt), { skill, existing: document.evals, caseCount: 3 });
    return { structured: { cases: [{ prompt: 'Report missing data', expected_output: 'Ask for data', files: [] }] } };
  };
  const current = await f.service.listCases(f.scope), id = randomUUID();
  const generated = await f.service.generateCases(f.scope, current.revision, id);
  assert.equal((await f.service.generateCases(f.scope, current.revision, id)).id, generated.id);
  await assert.rejects(f.start(), (e) => e.code === 'SKILL_JOB_BUSY');
  await f.service.runPendingForTest();
  assert.equal(f.service.get(f.scope, generated.id).status, 'completed');
  const cases = await f.service.listCases(f.scope);
  assert.equal(cases.document.evals.length, 2); assert.equal(cases.sources[2], 'ai');
  assert.deepEqual(cases.document.evals[0], document.evals[0]);
  assert.equal(generationCalls, 1);
  assert.equal((await f.service.latest(f.scope)).id, run.id);
});
test('AI generation rejects a concurrent edit without deleting user cases', async (t) => {
  const f = await fixture(t); const current = await f.service.listCases(f.scope);
  await f.service.generateCases(f.scope, current.revision, randomUUID());
  await f.service.mutateCases(f.scope, current.revision, (doc, next) => doc.evals.push({ ...document.evals[0], id: next }));
  f.runtime.modelCall = async () => ({ structured: { cases: [{ prompt: 'Generated', expected_output: 'Expected', files: [] }] } });
  await f.service.runPendingForTest();
  assert.equal((await f.service.listCases(f.scope)).document.evals.length, 2);
});
async function fillCases(f, count) {
  const current = await f.service.listCases(f.scope);
  await f.service.mutateCases(f.scope, current.revision, doc => {
    doc.evals = Array.from({ length: count }, (_, i) => ({ ...document.evals[0], id: i + 1 }));
  });
  return f.service.listCases(f.scope);
}
test('full collections reject manual additions and AI generation before calling the model', async t => {
  const f = await fixture(t, { modelCall: async () => assert.fail('Must not spend a model call') });
  const full = await fillCases(f, 10);
  await assert.rejects(f.service.mutateCases(f.scope, full.revision, (doc, next) => doc.evals.push({ ...document.evals[0], id: next })), { code: 'EVAL_CASE_LIMIT' });
  await assert.rejects(f.service.generateCases(f.scope, full.revision, randomUUID()), { code: 'EVAL_CASE_LIMIT' });
  assert.equal((await f.service.listCases(f.scope)).revision, full.revision);
  assert.equal((await f.service.listCases(f.scope)).generationJob, null);
  await f.service.mutateCases(f.scope, full.revision, doc => { doc.evals[0].prompt = 'Edited'; });
  assert.equal((await f.service.listCases(f.scope)).document.evals[0].prompt, 'Edited');
});
test('AI fills only the remaining one or two slots', async t => {
  for (const existingCount of [8, 9]) {
    const f = await fixture(t, { modelCall: async ({ prompt }) => {
      const input = JSON.parse(prompt);
      assert.equal(input.caseCount, 10 - existingCount);
      return { structured: { cases: Array.from({ length: input.caseCount }, () => ({ prompt: 'New task', expected_output: 'Expected' })) } };
    } });
    const before = await fillCases(f, existingCount);
    const job = await f.service.generateCases(f.scope, before.revision, randomUUID());
    await f.service.runPendingForTest();
    assert.equal(f.service.get(f.scope, job.id).status, 'completed');
    const after = await f.service.listCases(f.scope);
    assert.equal(after.document.evals.length, 10);
    assert.deepEqual(after.document.evals.slice(0, existingCount), before.document.evals);
  }
});
test('AI returning too many cases fails without partial writes', async t => {
  const f = await fixture(t, { modelCall: async () => ({ structured: { cases: Array.from({ length: 3 }, () => ({ prompt: 'New task', expected_output: 'Expected' })) } }) });
  const before = await fillCases(f, 9);
  const job = await f.service.generateCases(f.scope, before.revision, randomUUID());
  await f.service.runPendingForTest();
  assert.equal(f.service.get(f.scope, job.id).stopReason, 'EVAL_CASE_LIMIT');
  assert.equal((await f.service.listCases(f.scope)).revision, before.revision);
});
test('concurrent manual addition cannot make a queued AI generation exceed ten', async t => {
  const f = await fixture(t, { modelCall: async () => ({ structured: { cases: [{ prompt: 'AI task', expected_output: 'Expected' }] } }) });
  const before = await fillCases(f, 9);
  const job = await f.service.generateCases(f.scope, before.revision, randomUUID());
  await f.service.mutateCases(f.scope, before.revision, (doc, next) => doc.evals.push({ ...document.evals[0], id: next, prompt: 'Manual task' }));
  await f.service.runPendingForTest();
  assert.equal(f.service.get(f.scope, job.id).stopReason, 'EVAL_REVISION_CONFLICT');
  const after = await f.service.listCases(f.scope);
  assert.equal(after.document.evals.length, 10);
  assert.equal(after.document.evals.at(-1).prompt, 'Manual task');
});
test('legacy oversized collections stay readable and can be reduced one case at a time', async t => {
  const f = await fixture(t);
  await atomicJson(path.join(f.root, 'evals/evals.json'), { skill_name: 'weekly', evals: Array.from({ length: 12 }, (_, i) => ({ ...document.evals[0], id: i + 1 })) });
  let current = await f.service.listCases(f.scope);
  assert.equal(current.document.evals.length, 12);
  await assert.rejects(f.start(), { code: 'EVAL_CASE_LIMIT' });
  await assert.rejects(f.service.mutateCases(f.scope, current.revision, (doc, next) => doc.evals.push({ ...document.evals[0], id: next })), { code: 'EVAL_CASE_LIMIT' });
  for (const count of [11, 10]) {
    await f.service.mutateCases(f.scope, current.revision, doc => { doc.evals.pop(); });
    current = await f.service.listCases(f.scope);
    assert.equal(current.document.evals.length, count);
  }
  await f.start();
});
test('published case IDs cannot be removed by market replacement or generic edits', async (t) => {
  const f = await fixture(t), incomingFiles = { 'SKILL.md': skill, 'evals/evals.json': JSON.stringify(document) };
  await f.service.files.guard({ ...f.scope, operation: 'market-published', incomingFiles });
  assert.deepEqual(f.repository.meta(f.scope.workspacePath, 'weekly').protectedIds, [1]);
  await assert.rejects(f.service.files.guard({ ...f.scope, operation: 'market-replace', incomingFiles: { 'SKILL.md': skill } }), (e) => e.code === 'EVAL_PROTECTED_CASE');
  await assert.rejects(f.service.files.guard({ ...f.scope, operation: 'updateWorkspaceSkillFile', filePath: 'evals/evals.json', content: JSON.stringify({ skill_name: 'weekly', evals: [] }) }), (e) => e.code === 'EVAL_PROTECTED_CASE');
});
test('file editor can repair a legacy id=0 without bypassing case identity checks', async (t) => {
  const f = await fixture(t);
  const oldCases = [{ ...document.evals[0], id: 0 }, { ...document.evals[0], id: 3 }];
  await atomicJson(path.join(f.root, 'evals/evals.json'), { skill_name: 'weekly', evals: oldCases });
  const meta = f.repository.meta(f.scope.workspacePath, 'weekly');
  meta.protectedIds = [3];
  meta.nextId = 4;
  f.repository.saveMeta(f.scope.workspacePath, 'weekly', meta);
  const edit = (evals) => ({ ...f.scope, operation: 'updateWorkspaceSkillFile', filePath: 'evals/evals.json', content: JSON.stringify({ skill_name: 'weekly', evals }) });
  await assert.rejects(f.service.listCases(f.scope), { code: 'EVAL_SCHEMA_INVALID' });
  await assert.rejects(f.service.files.guard(edit([{ ...oldCases[0], id: 2 }, oldCases[1]])), { code: 'EVAL_CASE_ID_REUSED' });
  await assert.rejects(f.service.files.guard(edit([{ ...oldCases[0], id: 4 }])), { code: 'EVAL_PROTECTED_CASE' });
  await assert.rejects(f.service.files.guard(edit(oldCases)), { code: 'EVAL_SCHEMA_INVALID' });

  const repaired = edit([{ ...oldCases[0], id: 4 }, oldCases[1]]);
  await f.service.files.guard(repaired);
  const original = await readWorkspaceSkillFile({ ...f.scope, filePath: repaired.filePath });
  await updateWorkspaceSkillFile({ ...repaired, revision: original.revision });
  assert.deepEqual((await f.service.listCases(f.scope)).document.evals.map((item) => item.id), [4, 3]);
});
test('cleanup failure keeps the skill locked until the worker recovers it', async (t) => {
  const f = await fixture(t, { runCase: async () => { throw Object.assign(new Error('cleanup failed'), { cleanupRequired: true }); } });
  await f.start(); await f.service.runPendingForTest();
  assert.equal((await f.service.latest(f.scope)).status, 'cancelling');
  await assert.rejects(f.start(), (e) => e.code === 'SKILL_JOB_BUSY');
  await f.service.runPendingForTest();
  assert.equal((await f.service.latest(f.scope)).status, 'interrupted');
});

test('optimization also detects edits to the managed source copy', async (t) => {
  const f = await fixture(t), source = path.join(f.scope.workspacePath, '.cloudcli/skills/sources/weekly');
  await fs.mkdir(path.dirname(source), { recursive: true }); await fs.cp(f.root, source, { recursive: true });
  await atomicJson(path.join(f.scope.workspacePath, '.cloudcli/skills/metadata.json'), { version: 1, skills: { weekly: { enabled: true } } });
  const current = await f.service.files.load(f.scope);
  // Confirm this test actually loaded a managed skill, rather than silently testing an unmanaged one.
  assert.ok(current.context.managedEntry);
  await fs.writeFile(path.join(source, 'SKILL.md'), skill + '\nIndependent source edit');
  const result = await commitCandidate({ scope: f.scope, files: current.files, expectedHash: current.contentHash,
    expectedManagedHash: current.managedHash, journalPath: path.join(f.temp, 'commit.json'), signal: new AbortController().signal });
  assert.equal(result.status, 'conflict');
  assert.match(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'), /Independent source edit/);
});

test('live reports expose ordered execution and grading progress before the final verdict', async (t) => {
  let finishExecution, finishGrading;
  const execution = new Promise((resolve) => { finishExecution = resolve; });
  const grading = new Promise((resolve) => { finishGrading = resolve; });
  t.after(() => { finishExecution(); finishGrading(); });
  const event = { id: 'message:1', seq: 1, role: 'assistant', kind: 'text', text: 'Working' };
  const f = await fixture(t, { runCase: async ({ onEvent }) => {
    onEvent(event); await execution;
    return { complete: true, events: [event], artifacts: { 'report.txt': Buffer.from('done').toString('base64') } };
  }, modelCall: async ({ prompt }) => {
    await grading;
    return { structured: { checks: JSON.parse(prompt).checks.map((c) => ({ id: c.id, status: 'passed', reason: 'Matches', evidenceRefs: ['message:1'] })) } };
  } });
  const job = await f.start();
  const work = f.service.runPendingForTest();
  async function until(predicate) {
    for (let i = 0; i < 200; i++) {
      try { const report = await f.service.report(f.scope, job.id, 0, 1); if (predicate(report)) return report; }
      catch (e) { if (e.code !== 'EVAL_NOT_READY') throw e; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail('Progress checkpoint was not visible');
  }
  try {
    const live = await until((r) => r.evidence.events.length === 1);
    assert.equal(live.status, 'running'); assert.equal(live.phase, 'executing'); assert.ok(live.startedAt);
    assert.deepEqual(live.checks, []);
    finishExecution();
    const reviewing = await until((r) => r.phase === 'grading');
    assert.deepEqual(reviewing.evidence.artifacts, [{ name: 'report.txt', supported: true }]);
    finishGrading(); await work;
    const final = await f.service.report(f.scope, job.id, 0, 1);
    assert.equal(final.status, 'passed'); assert.ok(final.completedAt); assert.equal(final.evidence.events.length, 1);
    await f.start();
    await assert.rejects(f.service.report(f.scope, job.id, 0, 1), (e) => e.statusCode === 410);
  } finally { finishExecution(); finishGrading(); await work; }
});

test('execution errors preserve already emitted events without a completed runtime result', async (t) => {
  const event = { id: 'message:1', seq: 1, role: 'tool', kind: 'tool_use', tool: 'shell', input: 'test command' };
  const f = await fixture(t, { runCase: async ({ onEvent }) => { onEvent(event); throw new Error('Disconnected'); } });
  const job = await f.start(); await f.service.runPendingForTest();
  const report = await f.service.report(f.scope, job.id, 0, 1);
  assert.equal(report.status, 'error'); assert.equal(report.reason, 'Disconnected');
  assert.deepEqual(report.evidence.events, [event]);
});

test('uploaded input names remain readable, bounded and contained within their unique directory', () => {
  assert.equal(inputFileName('订单.csv'), '订单.csv');
  for (const original of ['../../secret.csv', 'C:\\temp\\data.json', '..', ' .. ', '.env', 'bad:\u0000name.txt', '长'.repeat(300) + '.csv']) {
    const name = inputFileName(original);
    assert.ok(name && !name.includes('/') && !name.includes('\\'));
    assert.ok(Buffer.byteLength(name) <= 180);
    assert.equal(relativePath(`evals/files/unique/${name}`), `evals/files/unique/${name}`);
  }
  assert.ok(inputFileName('长'.repeat(300) + '.csv').endsWith('.csv'));
});
