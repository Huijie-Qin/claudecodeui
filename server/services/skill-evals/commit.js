import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { resolveWorkspaceSkillContext, syncManagedSkillAfterMutation } from '../workspace-skills.js';

import { withSkillLock } from './coordination.js';
import { fail, relativePath, MAX_FILE_BYTES } from './contracts.js';
import { atomicJson, readTree, treeHash, validateSnapshot, writeTree, manifestName, managedCopyHash } from './files.js';

export function applyChanges(files, changes) {
  if (!Array.isArray(changes) || changes.length > 30) throw fail('Invalid optimizer change list', 'EVAL_OPTIMIZER_INVALID');
  const candidate = { ...files }, seen = new Set();
  for (const item of changes) {
    const name = relativePath(item.path);
    if (seen.has(name) || name.startsWith('evals/') || name.split('/').some((s) => s.startsWith('.'))
      || !/^(SKILL\.md|(?:scripts|references|assets)\/)/.test(name)
      || !['write', 'delete'].includes(item.operation)) throw fail(`Optimizer cannot change ${name}`, 'EVAL_OPTIMIZER_INVALID');
    seen.add(name);
    if (item.operation === 'delete') { if (name === 'SKILL.md') throw fail('Cannot delete SKILL.md'); delete candidate[name]; }
    else {
      if (typeof item.content !== 'string' || Buffer.byteLength(item.content) > MAX_FILE_BYTES) throw fail('Invalid optimizer file');
      candidate[name] = Buffer.from(item.content).toString('base64');
    }
  }
  if (manifestName(candidate) !== manifestName(files)) throw fail('Optimizer cannot change the skill name');
  validateSnapshot(candidate);
  return candidate;
}
export async function commitCandidate({ scope, files, expectedHash, journalPath, signal, expectedManagedHash = null }) {
  return withSkillLock(scope.workspacePath, scope.name, async () => {
    if (signal.aborted) throw signal.reason;
    const context = await resolveWorkspaceSkillContext(scope);
    if (await managedCopyHash(context, scope.workspacePath) !== expectedManagedHash || treeHash(await readTree(context.rootPath)) !== expectedHash) return { status: 'conflict' };
    const token = randomUUID(), parent = path.dirname(context.rootPath);
    const staged = path.join(parent, `.eval-${token}.stage`), backup = path.join(parent, `.eval-${token}.backup`);
    const journal = { target: context.rootPath, staged, backup, status: 'prepared', expectedHash, expectedManagedHash, candidateHash: treeHash(files) };
    await writeTree(staged, files);
    await atomicJson(journalPath, journal);
    if (signal.aborted || await managedCopyHash(context, scope.workspacePath) !== expectedManagedHash || treeHash(await readTree(context.rootPath)) !== expectedHash) {
      await fs.rm(staged, { recursive: true, force: true });
      await fs.rm(journalPath, { force: true });
      if (signal.aborted) throw signal.reason;
      return { status: 'conflict' };
    }
    // Commit is bounded and not abortable halfway through. Preserve old files until both copies sync.
    await fs.rename(context.rootPath, backup);
    try {
      await fs.rename(staged, context.rootPath);
      await syncManagedSkillAfterMutation(context, scope.workspacePath);
      await atomicJson(journalPath, { ...journal, status: 'committed' });
      await fs.rm(backup, { recursive: true, force: true });
      return { status: 'written', contentHash: journal.candidateHash, managedHash: await managedCopyHash(context, scope.workspacePath) };
    } catch (error) {
      // Keep the recovery journal and both copies. Never destroy an externally changed target.
      throw Object.assign(fail('File commit needs recovery; further evaluation is blocked', 'EVAL_COMMIT_RECOVERY'), { cause: error });
    }
  });
}

export async function recoverCommit(scope, journalPath) {
  let journal;
  try { journal = JSON.parse(await fs.readFile(journalPath, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  return withSkillLock(scope.workspacePath, scope.name, async () => {
    const exists = (p) => fs.stat(p).then(() => true, (e) => { if (e.code === 'ENOENT') return false; throw e; });
    if (!await exists(journal.target)) {
      if (await exists(journal.staged)) await fs.rename(journal.staged, journal.target);
      else if (await exists(journal.backup)) await fs.rename(journal.backup, journal.target);
      else throw fail('Recovery files are missing', 'EVAL_COMMIT_RECOVERY');
    }
    const actual = treeHash(await readTree(journal.target));
    if (![journal.expectedHash, journal.candidateHash].includes(actual)) throw fail('External changes conflict with recovery; files were preserved', 'EVAL_COMMIT_RECOVERY');
    const context = await resolveWorkspaceSkillContext(scope);
    const managedHash = await managedCopyHash(context, scope.workspacePath);
    if (![(journal.expectedManagedHash ?? null), journal.candidateHash].includes(managedHash)) throw fail('Managed source changed during recovery; copies were preserved', 'EVAL_COMMIT_RECOVERY');
    await syncManagedSkillAfterMutation(context, scope.workspacePath);
    await fs.rm(journal.backup, { recursive: true, force: true });
    await fs.rm(journal.staged, { recursive: true, force: true });
    await fs.rm(journalPath, { force: true });
  });
}
