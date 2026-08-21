import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';

import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';

const BUILTIN_SKILL_ID_PREFIX = 'builtin:';
const MANAGED_SKILL_METADATA_FILE = 'skill.json';
const APP_ROOT = findAppRoot(getModuleDir(import.meta.url));

function resolveDefaultManagedSkillsRoot(env = process.env) {
  const dataRoot = String(env.CLOUDCLI_DATA_ROOT || '').trim();
  if (dataRoot && path.isAbsolute(dataRoot)) return path.join(dataRoot, 'hook-skills');
  const databasePath = String(env.DATABASE_PATH || '').trim();
  if (databasePath && path.isAbsolute(databasePath)) {
    return path.join(path.dirname(databasePath), 'hook-skills');
  }
  return path.join(APP_ROOT, 'data', 'hook-skills');
}

const DEFAULT_MANAGED_BUILTIN_SKILLS_ROOT = resolveDefaultManagedSkillsRoot();

function createSkillError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeSkillName(value) {
  return String(value ?? '').trim();
}

function toSkillId(name) {
  return `${BUILTIN_SKILL_ID_PREFIX}${name}`;
}

function parseMatterBestEffort(raw) {
  try {
    matter.clearCache();
    return matter(String(raw).replace(/^\uFEFF/, ''));
  } catch {
    return { data: {}, content: raw };
  }
}

function inferNameFromFile(fileName, raw) {
  const parsed = parseMatterBestEffort(raw);
  const declaredName = normalizeSkillName(parsed.data?.name);
  if (declaredName) return declaredName;
  const baseName = path.basename(String(fileName || '').trim());
  const inferredName = normalizeSkillName(path.parse(baseName).name || baseName);
  if (inferredName) return inferredName;
  return `uploaded-${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
}

function normalizeUploadedFolder(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw createSkillError('Skill folder is required');
  }

  const uploaded = files.map((file) => {
    if (!Buffer.isBuffer(file?.buffer)) throw createSkillError('Skill folder contains an invalid file');
    const rawPath = String(file.relativePath || '').replaceAll('\\', '/').replace(/^\.\/+/, '');
    const segments = rawPath.split('/');
    if (
      !rawPath
      || path.posix.isAbsolute(rawPath)
      || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0'))
    ) {
      throw createSkillError('Skill folder contains an invalid path');
    }
    return { segments, buffer: file.buffer };
  });

  const folderName = uploaded[0].segments[0];
  if (uploaded.some((file) => file.segments.length < 2 || file.segments[0] !== folderName)) {
    throw createSkillError('Select exactly one Skill folder');
  }

  const entries = uploaded.map((file) => ({
    relativePath: file.segments.slice(1).join('/'),
    buffer: file.buffer,
  }));
  if (new Set(entries.map((entry) => entry.relativePath)).size !== entries.length) {
    throw createSkillError('Skill folder contains duplicate paths');
  }
  const manifest = entries.find((entry) => entry.relativePath === 'SKILL.md');
  if (!manifest) throw createSkillError('Skill folder root must contain SKILL.md');

  return { folderName, entries, manifest };
}

function parseBuiltinManifest(raw, {
  fallbackName,
  manifestPath,
} = {}) {
  const parsed = parseMatterBestEffort(raw);
  const name = normalizeSkillName(parsed.data?.name) || normalizeSkillName(fallbackName);
  if (!name) return null;
  const description = parsed.data?.description == null
    ? ''
    : String(parsed.data.description).trim();
  const content = String(parsed.content ?? raw).trim();

  return {
    skillId: toSkillId(name),
    name,
    displayName: normalizeSkillName(parsed.data?.displayName) || name,
    description,
    version: Number(parsed.data?.version) || 1,
    source: 'uploaded',
    manifestPath,
    content: content ? `${content}\n` : '',
  };
}

async function readManagedMetadata(skillDirectory) {
  try {
    const raw = await fs.readFile(path.join(skillDirectory, MANAGED_SKILL_METADATA_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function scanSkillRoot(skillsRoot) {
  let entries;
  try {
    entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDirectory = path.join(skillsRoot, entry.name);
    const manifestPath = path.join(skillDirectory, 'SKILL.md');
    try {
      const [directory, file, metadata] = await Promise.all([
        fs.lstat(skillDirectory),
        fs.lstat(manifestPath),
        readManagedMetadata(skillDirectory),
      ]);
      if (directory.isSymbolicLink() || !file.isFile() || file.isSymbolicLink()) continue;
      const raw = await fs.readFile(manifestPath, 'utf8');
      const skill = parseBuiltinManifest(raw, {
        fallbackName: metadata.name || entry.name,
        manifestPath,
      });
      if (skill) skills.push(skill);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return skills;
}

export async function listBuiltinHookSkills({
  managedSkillsRoot = DEFAULT_MANAGED_BUILTIN_SKILLS_ROOT,
} = {}) {
  return (await scanSkillRoot(managedSkillsRoot))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export async function loadBuiltinHookSkill({
  skillId,
  skillName,
  managedSkillsRoot = DEFAULT_MANAGED_BUILTIN_SKILLS_ROOT,
} = {}) {
  const name = normalizeSkillName(skillName);
  if (!name || skillId !== toSkillId(name)) throw new Error('Built-in Hook Skill identity is invalid');
  const skills = await listBuiltinHookSkills({ managedSkillsRoot });
  const skill = skills.find((candidate) => candidate.skillId === skillId && candidate.name === name);
  if (!skill) throw new Error(`Built-in Hook Skill ${name} is unavailable`);
  return skill;
}

export async function saveManagedBuiltinHookSkill({
  files,
  managedSkillsRoot = DEFAULT_MANAGED_BUILTIN_SKILLS_ROOT,
} = {}) {
  const uploadedFolder = normalizeUploadedFolder(files);
  const raw = uploadedFolder.manifest.buffer.toString('utf8').replace(/^\uFEFF/, '');
  const name = inferNameFromFile(uploadedFolder.folderName, raw);
  const directoryKey = `skill-${createHash('sha256').update(name).digest('hex')}`;
  const existingSkills = await scanSkillRoot(managedSkillsRoot);
  const existingSkill = existingSkills.find((candidate) => candidate.name === name);
  const skillDirectory = existingSkill
    ? path.dirname(existingSkill.manifestPath)
    : path.join(managedSkillsRoot, directoryKey);
  const manifestPath = path.join(skillDirectory, 'SKILL.md');
  const skill = parseBuiltinManifest(raw, {
    fallbackName: name,
    manifestPath,
  });

  await fs.mkdir(managedSkillsRoot, { recursive: true, mode: 0o700 });
  const stagingDirectory = path.join(managedSkillsRoot, `.upload-${randomUUID()}`);
  const backupDirectory = path.join(managedSkillsRoot, `.backup-${randomUUID()}`);
  let existingMoved = false;
  await fs.mkdir(stagingDirectory, { mode: 0o700 });

  try {
    for (const entry of uploadedFolder.entries) {
      const destination = path.join(stagingDirectory, ...entry.relativePath.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, entry.buffer, { flag: 'wx', mode: 0o600 });
    }
    await fs.writeFile(
      path.join(stagingDirectory, MANAGED_SKILL_METADATA_FILE),
      `${JSON.stringify({
        name,
        folderName: uploadedFolder.folderName,
        fileCount: uploadedFolder.entries.length,
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );

    try {
      const existing = await fs.lstat(skillDirectory);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw createSkillError(`Managed Skill path for ${name} is not a safe directory`, 409);
      }
      await fs.rename(skillDirectory, backupDirectory);
      existingMoved = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    await fs.rename(stagingDirectory, skillDirectory);
    if (existingMoved) await fs.rm(backupDirectory, { recursive: true, force: true }).catch(() => {});
  } catch (error) {
    await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    if (existingMoved) {
      try {
        await fs.lstat(skillDirectory);
      } catch (targetError) {
        if (targetError?.code === 'ENOENT') await fs.rename(backupDirectory, skillDirectory).catch(() => {});
      }
    }
    throw error;
  }
  return skill;
}

export async function deleteManagedBuiltinHookSkill({
  skillId,
  managedSkillsRoot = DEFAULT_MANAGED_BUILTIN_SKILLS_ROOT,
} = {}) {
  const normalizedSkillId = normalizeSkillName(skillId);
  if (!isBuiltinHookSkillId(normalizedSkillId)) {
    throw createSkillError('Built-in Hook Skill id is invalid');
  }

  const uploadedSkills = await scanSkillRoot(managedSkillsRoot);
  const skill = uploadedSkills.find((candidate) => candidate.skillId === normalizedSkillId);
  if (!skill) throw createSkillError('Uploaded Hook Skill not found', 404);

  const resolvedManagedRoot = path.resolve(managedSkillsRoot);
  const skillDirectory = path.resolve(path.dirname(skill.manifestPath));
  if (path.dirname(skillDirectory) !== resolvedManagedRoot) {
    throw createSkillError('Managed Hook Skill path is invalid', 409);
  }
  const directory = await fs.lstat(skillDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw createSkillError('Managed Hook Skill path is not a safe directory', 409);
  }

  await fs.rm(skillDirectory, { recursive: true });
  return skill;
}

export function isBuiltinHookSkillId(value) {
  return String(value || '').startsWith(BUILTIN_SKILL_ID_PREFIX);
}

export {
  BUILTIN_SKILL_ID_PREFIX,
  DEFAULT_MANAGED_BUILTIN_SKILLS_ROOT,
};
