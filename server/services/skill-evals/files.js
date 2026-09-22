import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import matter from 'gray-matter';

import { resolveWorkspaceSkillContext, syncManagedSkillAfterMutation } from '../workspace-skills.js';

import { withSkillLock } from './coordination.js';
import { fail, hash, MAX_FILE_BYTES, MAX_TOTAL_BYTES, parseEvals, relativePath, validateEvals } from './contracts.js';

export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(tmp, file);
}
export async function readTree(root) {
  const files = {};
  let size = 0;
  async function visit(dir, prefix = '') {
    if ((await fs.lstat(dir)).isSymbolicLink()) throw fail('Symbolic links are not allowed', 'EVAL_UNSAFE_PATH');
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = relativePath(prefix + entry.name);
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw fail(`Unsafe file: ${rel}`, 'EVAL_UNSAFE_PATH');
      if (rel.split('/').length > 20) throw fail('File nesting limit exceeded');
      if (entry.isDirectory()) await visit(full, `${rel}/`);
      else {
        const stat = await fs.lstat(full);
        if (stat.size > MAX_FILE_BYTES || size + stat.size > MAX_TOTAL_BYTES || Object.keys(files).length >= 500) throw fail('Skill file size or count limit exceeded', 'EVAL_LIMIT_EXCEEDED', 413);
        const buffer = await fs.readFile(full);
        size += buffer.length;
        if (size > MAX_TOTAL_BYTES) throw fail('Skill grew while reading', 'EVAL_LIMIT_EXCEEDED', 413);
        files[rel] = buffer.toString('base64');
      }
    }
  }
  await visit(root);
  return files;
}
export const treeHash = (files) => hash(JSON.stringify(Object.keys(files).sort().map((p) => [p, files[p]])));
export async function writeTree(root, files) {
  await fs.mkdir(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, relativePath(rel));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(content, 'base64'), { flag: 'wx', mode: 0o600 });
  }
}
export function manifestName(files) {
  if (!files['SKILL.md']) throw fail('Missing SKILL.md');
  const raw = Buffer.from(files['SKILL.md'], 'base64').toString('utf8');
  let data;
  try { matter.clearCache(); data = matter(raw).data; } catch { throw fail('Invalid SKILL.md frontmatter'); }
  if (typeof data.name !== 'string' || !data.name.trim() || typeof data.description !== 'string' || !data.description.trim()) throw fail('SKILL.md requires name and description');
  return data.name;
}
export function validateSnapshot(files) {
  const name = manifestName(files);
  const raw = files['evals/evals.json'];
  const document = raw ? parseEvals(Buffer.from(raw, 'base64').toString('utf8'), name) : { skill_name: name, evals: [] };
  for (const item of document.evals) for (const input of item.files || []) {
    if (!files[input]) throw fail(`Missing input file: ${input}`);
  }
  // Scripts can run only in the isolated container. Config/hooks and credentials are never execution inputs.
  const dangerous = Object.keys(files).find((p) => /(^|\/)(\.env(?:\..*)?|credentials(?:\.json)?|settings(?:\.local)?\.json|\.git)(\/|$)/i.test(p));
  if (dangerous) throw fail(`Remove private configuration from the skill: ${dangerous}`, 'EVAL_UNSAFE_INPUT');
  return document;
}
export async function managedCopyHash(context, workspacePath) {
  if (!context.managedEntry || context.managedEntry.enabled === false) return null;
  const source = path.join(workspacePath, '.cloudcli/skills/sources', context.name);
  const runtime = path.join(workspacePath, '.claude/skills', context.name);
  const other = path.resolve(context.rootPath) === path.resolve(runtime) ? source : runtime;
  try { return treeHash(await readTree(other)); } catch (e) { if (e.code === 'ENOENT') return 'missing'; throw e; }
}
export function createEvalFiles({ repository }) {
  async function load(scope) {
    const context = await resolveWorkspaceSkillContext(scope);
    const workspaceReal = await fs.realpath(scope.workspacePath), skillReal = await fs.realpath(context.rootPath);
    if (!skillReal.startsWith(`${workspaceReal}${path.sep}`)) throw fail('Skill path escapes the workspace', 'EVAL_UNSAFE_PATH', 403);
    const files = await readTree(context.rootPath);
    const name = manifestName(files);
    const raw = files['evals/evals.json'];
    const document = raw ? parseEvals(Buffer.from(raw, 'base64').toString('utf8'), name) : { skill_name: name, evals: [] };
    const meta = repository.meta(scope.workspacePath, context.name);
    const missing = meta.protectedIds.filter((id) => !document.evals.some((c) => c.id === id));
    if (missing.length) throw fail(`Published cases are missing: ${missing.join(', ')}`, 'EVAL_PROTECTED_CASE', 409);
    return { context, files, document, meta, managedHash: await managedCopyHash(context, scope.workspacePath), revision: hash(raw ? Buffer.from(raw, 'base64') : ''), contentHash: treeHash(files) };
  }
  async function mutate(scope, revision, change, source = 'manual') {
    return withSkillLock(scope.workspacePath, scope.name, async () => {
      const current = await load(scope);
      if (revision !== current.revision) throw fail('Cases changed. Reload before saving.', 'EVAL_REVISION_CONFLICT', 409);
      const doc = structuredClone(current.document);
      const nextId = Math.max(current.meta.nextId, ...doc.evals.map((c) => c.id + 1), 1);
      await change(doc, nextId);
      validateEvals(doc, current.document.skill_name);
      for (const id of current.meta.protectedIds) if (!doc.evals.some((c) => c.id === id)) throw fail('Published cases cannot be deleted', 'EVAL_PROTECTED_CASE', 409);
      for (const item of doc.evals) for (const file of item.files || []) if (!current.files[file]) throw fail(`Missing input: ${file}`);
      // Validate parent paths before writing; readTree rejected symlinks throughout the skill.
      const target = path.join(current.context.rootPath, 'evals/evals.json');
      const nextMeta = { ...current.meta, nextId: Math.max(nextId, ...doc.evals.map((c) => c.id + 1)) };
      for (const item of doc.evals) if (!current.document.evals.some((c) => c.id === item.id)) nextMeta.sources[item.id] = source;
      // Reserve IDs before file commit; a failed commit may leave a gap, never reuse an identity.
      repository.saveMeta(scope.workspacePath, current.context.name, nextMeta);
      await atomicJson(target, doc);
      await syncManagedSkillAfterMutation(current.context, scope.workspacePath);
      return load(scope);
    });
  }
  async function snapshot(scope) {
    return withSkillLock(scope.workspacePath, scope.name, async () => {
      const current = await load(scope);
      validateSnapshot(current.files);
      if (treeHash(await readTree(current.context.rootPath)) !== current.contentHash) throw fail('Skill changed during snapshot', 'EVAL_REVISION_CONFLICT', 409);
      return current;
    });
  }
  async function guard(options) {
    const { operation, entryPath, filePath, content, nextName } = options;
    const affected = filePath || entryPath ? relativePath(filePath || entryPath) : '';
    const meta = repository.meta(options.workspacePath, options.name);
    if (operation.startsWith('market-')) {
      const incoming = options.incomingFiles;
      const raw = incoming['evals/evals.json'];
      const name = matter(String(incoming['SKILL.md'] || '')).data.name;
      const document = raw ? parseEvals(String(raw), name) : { evals: [] };
      for (const id of meta.protectedIds) if (!document.evals.some((c) => c.id === id)) throw fail('Market update would delete a published case', 'EVAL_PROTECTED_CASE', 409);
      if (options.nextName && options.nextName !== options.name && meta.protectedIds.length) throw fail('Cannot move protected case identities', 'EVAL_PROTECTED_CASE', 409);
      if (operation === 'market-published') {
        meta.protectedIds = [...new Set([...meta.protectedIds, ...document.evals.map((c) => c.id)])];
        meta.nextId = Math.max(meta.nextId, ...document.evals.map((c) => c.id + 1));
        repository.saveMeta(options.workspacePath, options.name, meta);
      }
      return;
    }
    if (['deleteWorkspaceSkillEntry', 'renameWorkspaceSkillEntry'].includes(operation) && affected.startsWith('evals/files')) {
      const current = await load(options);
      if (current.document.evals.some((c) => c.files?.some((file) => file === affected || file.startsWith(`${affected}/`)))) throw fail('Input is still referenced by a case', 'EVAL_INPUT_IN_USE', 409);
    }
    if (affected === 'evals/evals.json' && ['updateWorkspaceSkillFile', 'createWorkspaceSkillEntry'].includes(operation)) {
      const current = await load(options);
      const doc = parseEvals(String(content ?? ''), current.document.skill_name);
      for (const id of meta.protectedIds) if (!doc.evals.some((c) => c.id === id)) throw fail('Published cases cannot be deleted', 'EVAL_PROTECTED_CASE', 409);
      for (const item of doc.evals) for (const file of item.files || []) if (!current.files[file]) throw fail(`Missing input: ${file}`);
      const added = doc.evals.filter((c) => !current.document.evals.some((old) => old.id === c.id));
      if (added.some((c) => c.id < meta.nextId)) throw fail('Case IDs cannot be reused', 'EVAL_CASE_ID_REUSED', 409);
      meta.nextId = Math.max(meta.nextId, ...doc.evals.map((c) => c.id + 1));
      for (const item of added) meta.sources[item.id] = 'manual';
      repository.saveMeta(options.workspacePath, options.name, meta);
    }
    if (meta.protectedIds.length && (
      ['deleteLocalWorkspaceSkill', 'renameLocalWorkspaceSkillDirectory'].includes(operation)
      || ((affected === 'evals' || affected === 'evals/evals.json') && ['deleteWorkspaceSkillEntry', 'renameWorkspaceSkillEntry'].includes(operation)))) {
      throw fail('This operation would remove published case identities', 'EVAL_PROTECTED_CASE', 409);
    }
    if (nextName && repository.meta(options.workspacePath, nextName).protectedIds.length) throw fail('Target has protected cases', 'EVAL_PROTECTED_CASE', 409);
  }
  async function protectPublished(scope) {
    return withSkillLock(scope.workspacePath, scope.name, async () => {
      const current = await load(scope);
      if (!current.document.evals.length) return;
      const meta = current.meta;
      meta.protectedIds = [...new Set([...meta.protectedIds, ...current.document.evals.map((c) => c.id)])];
      meta.nextId = Math.max(meta.nextId, ...meta.protectedIds.map((id) => id + 1));
      repository.saveMeta(scope.workspacePath, current.context.name, meta);
    });
  }
  return { load, mutate, snapshot, guard, protectPublished };
}

export function assertGenericFileMutation(workspacePath, targets) {
  const workspace = path.resolve(workspacePath);
  const roots = ['.claude/skills', '.cloudcli/skills'];
  for (const target of targets) {
    const full = path.resolve(workspace, target);
    if (roots.some((root) => { const protectedRoot = path.join(workspace, root); return full === protectedRoot || full.startsWith(`${protectedRoot}${path.sep}`) || protectedRoot.startsWith(`${full}${path.sep}`); })) {
      throw fail('Edit skill files through My Skills so cases and managed copies remain consistent', 'SKILL_USE_SKILL_EDITOR', 409);
    }
  }
}
