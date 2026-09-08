import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as workspaceSkills from './workspace-skills.js';
import { learnSessionSkill, extractSessionLearningExample } from './session-skill-learning.js';

const TERMINAL = new Set(['succeeded', 'failed', 'exhausted']);
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const problem = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const clone = (value) => structuredClone(value);

async function defaultComplete(args) {
  const { completeSessionSkillText } = await import('./session-skill-learning-runtime.js');
  return completeSessionSkillText(args);
}

// Reject every symlink below the supplied filesystem boundary.
async function safeDirectory(boundaryRoot, segments, create = false) {
  let current = await fs.realpath(boundaryRoot);
  for (const segment of segments) {
    current = path.join(current, segment);
    if (create) await fs.mkdir(current, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    let stat;
    try { stat = await fs.lstat(current); } catch (error) {
      if (error.code === 'ENOENT' && !create) return null;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw problem('Skill learning paths must be real directories', 403);
  }
  return current;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function privateRecordDirectory(storageRoot, workspacePath, segments, create = false) {
  try {
    if (!storageRoot || !path.isAbsolute(storageRoot)) throw problem('Private learning storage must be an absolute server path', 500);
    const workspaceRoot = await fs.realpath(workspacePath);
    const requestedRoot = path.resolve(storageRoot);
    if (isWithin(path.resolve(workspacePath), requestedRoot) || isWithin(workspaceRoot, requestedRoot)) {
      throw problem('Private learning storage cannot be inside a workspace', 500);
    }
    // Resolve configured parents before checking containment, so a path alias into
    // the workspace cannot turn private transcripts into workspace files.
    const parent = path.dirname(requestedRoot);
    if (create) await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const canonicalRoot = path.join(await fs.realpath(parent), path.basename(requestedRoot));
    if (isWithin(workspaceRoot, canonicalRoot)) throw problem('Private learning storage cannot be inside a workspace', 500);
    if (create) await fs.mkdir(canonicalRoot, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await fs.lstat(canonicalRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw problem('Private learning storage must be a real server directory', 403);
    if (create) await fs.chmod(canonicalRoot, 0o700);
    return await safeDirectory(canonicalRoot, segments, create);
  } catch (error) {
    if (error.statusCode) throw error;
    throw problem('Private skill learning storage is unavailable', 500);
  }
}

async function readJson(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw problem('Invalid skill learning record path', 403);
    if (stat.size > 8 * 1024 * 1024) throw problem('Skill learning record is too large', 413);
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.statusCode) throw error;
    throw problem('Skill learning record could not be read', 500);
  }
}

async function writeJson(filePath, value) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporaryPath, filePath);
  } catch {
    throw problem('Skill learning record could not be saved', 500);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export function createSessionSkillLearningService({
  skillsService = workspaceSkills,
  learn = learnSessionSkill,
  complete = defaultComplete,
  timeoutMs = 10 * 60 * 1000,
  maxActiveJobs = 4,
  maxStoredJobs = 100,
  getMarketImports = () => [],
  storageRoot = path.join(process.env.CLOUDCLI_DATA_ROOT || path.join(os.homedir(), '.cloudcli'), 'session-skill-learning'),
} = {}) {
  const jobs = new Map();
  const locks = new Set();

  function scopeKey({ tenantId, userId, workspaceId }) {
    if (![tenantId, userId, workspaceId].every((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0)) {
      throw problem('A tenant, user, and workspace are required');
    }
    return [tenantId, userId, workspaceId].map(Number).join(':');
  }

  async function inspectSkill(options) {
    const { workspacePath, skillName, operation, workspaceId } = options;
    await safeDirectory(workspacePath, ['.claude', 'skills']);
    const imports = await getMarketImports(workspaceId);
    const inventory = await skillsService.listWorkspaceSkills(workspacePath, [], imports);
    const existing = inventory.skills.find((skill) => skill.name.toLowerCase() === skillName.toLowerCase());
    if (operation === 'generate') {
      if (existing || imports.some((entry) => entry.name?.toLowerCase() === skillName.toLowerCase())) {
        throw problem(`Skill "${skillName}" already exists; use optimize`, 409);
      }
      return { imports, currentSkill: '', revision: null };
    }
    if (!existing) throw problem('Local skill not found', 404);
    if (existing.name !== skillName || existing.origin !== 'local' || existing.kind === 'system'
      || existing.kind === 'managed' || existing.imported || existing.published
      || imports.some((entry) => entry.name?.toLowerCase() === skillName.toLowerCase())) {
      throw problem('POC only optimizes local skills without a marketplace or managed binding', 422);
    }
    const root = await safeDirectory(workspacePath, ['.claude', 'skills', skillName]);
    if (!root) throw problem('Local skill directory not found', 404);
    const entries = await fs.readdir(root, { withFileTypes: true });
    if (entries.length !== 1 || entries[0].name !== 'SKILL.md' || !entries[0].isFile()) {
      throw problem('POC only supports one text SKILL.md; skills with auxiliary files are not supported', 422);
    }
    const file = await skillsService.readWorkspaceSkillFile({ workspacePath, name: skillName, filePath: 'SKILL.md', marketImports: imports });
    if (file.isBinary || typeof file.content !== 'string' || !file.revision) throw problem('A readable text SKILL.md with revision is required', 422);
    return { imports, currentSkill: file.content, revision: file.revision };
  }

  async function startJob(options) {
    const { tenantId, userId, workspaceId, workspacePath, sessionId, provider, operation, skillName } = options;
    const scope = scopeKey(options);
    if (!NAME_PATTERN.test(skillName || '') || skillName.length > 63) throw problem('Skill name must use lowercase letters, digits and single hyphens (max 63 characters)');
    if (!['generate', 'optimize'].includes(operation)) throw problem('operation must be generate or optimize');
    const maxIterations = options.maxIterations ?? 3;
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 5) throw problem('maxIterations must be an integer between 1 and 5');
    if (!workspacePath || !path.isAbsolute(workspacePath)) throw problem('An absolute workspace path is required');
    const messages = clone(options.messages);
    extractSessionLearningExample(messages);
    if (JSON.stringify(messages).length > 2_000_000) throw problem('Session snapshot is too large for this POC', 413);
    const lockKey = `${tenantId}:${workspaceId}:${skillName}`;
    if (locks.has(lockKey)) throw problem('A learning job is already running for this skill', 409);
    if (locks.size >= maxActiveJobs) throw problem('Too many skill learning jobs are running; retry later', 429);
    locks.add(lockKey);
    try {
      const baseline = await inspectSkill(options);
      const segments = [hash(scope), skillName];
      const recordRoot = await privateRecordDirectory(storageRoot, workspacePath, segments, true);
      const latest = operation === 'optimize' ? await readJson(path.join(recordRoot, 'latest.json')) : null;
      if (latest && (latest.scope !== scope || latest.skillName !== skillName)) throw problem('Skill learning record scope mismatch', 403);
      // Human edits may be useful; keep the regression cases while revision-guarding
      // the actual version loaded for this run.
      const previousCases = Array.isArray(latest?.testCases) ? latest.testCases : [];
      for (const [id, job] of jobs) {
        if (jobs.size < maxStoredJobs) break;
        if (TERMINAL.has(job.status)) jobs.delete(id);
      }
      if (jobs.size >= maxStoredJobs) throw problem('Skill learning job capacity reached; retry later', 429);
      const id = randomUUID();
      const job = {
        id, scope, workspaceId, sessionId, provider, operation, skillName,
        status: 'queued', phase: 'queued', iteration: 0, maxIterations,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), result: null, error: null,
      };
      jobs.set(id, job);
      // Persist the exact transcript before any model call. Later session edits do
      // not alter the training example being evaluated.
      try {
        await writeJson(path.join(recordRoot, `${id}.json`), {
          version: 1, scope, skillName, sessionId, provider, operation,
          createdAt: job.createdAt, messages, baseline,
        });
      } catch (error) {
        jobs.delete(id);
        throw error;
      }
      const response = publicJob(job);
      queueMicrotask(() => runJob({ options, messages, job, baseline, previousCases, recordRoot, segments, lockKey }).catch(() => {}));
      return response;
    } catch (error) {
      locks.delete(lockKey);
      throw error;
    }
  }

  async function runJob({ options, messages, job, baseline, previousCases, recordRoot, segments, lockKey }) {
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    let learnedResult = null;
    const touch = (updates) => Object.assign(job, updates, { updatedAt: new Date().toISOString() });
    const checkActive = () => { if (timedOut) throw problem('Skill learning timed out; the existing skill was not replaced', 504); };
    try {
      touch({ status: 'running', phase: 'summarize' });
      const result = await Promise.race([
        learn({
          skillName: job.skillName, operation: job.operation, messages,
          currentSkill: baseline.currentSkill, previousCases, maxIterations: job.maxIterations,
          complete: async (request) => {
            checkActive();
            const answer = await complete({
              workspacePath: options.workspacePath, tenantId: options.tenantId, userId: options.userId,
              workspaceId: options.workspaceId, ...request, signal: controller.signal,
            });
            checkActive();
            return answer;
          },
          onProgress: ({ phase, iteration }) => {
            if (!timedOut) touch({ phase, ...(iteration !== undefined ? { iteration } : {}) });
          },
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(problem('Skill learning timed out; the existing skill was not replaced', 504));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
      checkActive();
      learnedResult = result;
      clearTimeout(timer);
      // Check scope/path/binding again after the lengthy model run. The file writer
      // also checks this revision immediately before its atomic replacement.
      await privateRecordDirectory(storageRoot, options.workspacePath, segments);
      const nextRecord = { version: 1, scope: job.scope, skillName: job.skillName, sessionId: job.sessionId,
        provider: job.provider, operation: job.operation, createdAt: job.createdAt,
        messages, baseline, result, status: result.passed ? 'validated' : 'exhausted' };
      await writeJson(path.join(recordRoot, `${job.id}.json`), nextRecord);
      if (!result.passed) {
        touch({ status: 'exhausted', phase: 'finished', result });
        return;
      }
      touch({ phase: 'saving' });
      const current = await inspectSkill(options);
      if (job.operation === 'optimize' && current.revision !== baseline.revision) {
        throw problem('Skill changed while learning. Retry with the new version; no update was saved.', 409);
      }
      await safeDirectory(options.workspacePath, ['.claude', 'skills'], true);
      if (job.operation === 'generate') {
        await skillsService.createWorkspaceSkill({ workspacePath: options.workspacePath, name: job.skillName, content: result.skillContent });
      } else {
        await skillsService.updateWorkspaceSkillFile({ workspacePath: options.workspacePath, name: job.skillName,
          filePath: 'SKILL.md', content: result.skillContent, revision: baseline.revision, marketImports: current.imports });
      }
      const finalResult = { ...result, skillPath: `.claude/skills/${job.skillName}/SKILL.md` };
      // The audit snapshot was already written before saving. If this bookkeeping
      // write fails, report the successful skill save explicitly instead of claiming
      // that the old skill is still installed.
      try {
        const savedFile = await skillsService.readWorkspaceSkillFile({ workspacePath: options.workspacePath, name: job.skillName, filePath: 'SKILL.md' });
        await writeJson(path.join(recordRoot, 'latest.json'), {
          version: 1, scope: job.scope, skillName: job.skillName, jobId: job.id,
          revision: savedFile.revision, testCases: result.testCases, updatedAt: job.updatedAt,
        });
        await writeJson(path.join(recordRoot, `${job.id}.json`), { ...nextRecord, status: 'succeeded', result: finalResult });
      } catch (error) {
        finalResult.warning = `Skill saved, but regression record persistence failed: ${error.message}`;
      }
      touch({ status: 'succeeded', phase: 'finished', result: finalResult });
    } catch (error) {
      touch({ status: 'failed', phase: 'finished', error: error.message, errorCode: error.statusCode || 500, result: learnedResult });
    } finally {
      clearTimeout(timer);
      locks.delete(lockKey);
    }
  }

  function publicJob(job) {
    const { scope, ...publicFields } = job;
    return clone(publicFields);
  }

  return {
    startJob,
    getJob({ jobId, ...scope }) {
      const job = jobs.get(jobId);
      if (!job || job.scope !== scopeKey(scope)) throw problem('Skill learning job not found', 404);
      return publicJob(job);
    },
  };
}
