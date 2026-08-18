import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';

import { findAppRoot, findServerRoot, getModuleDir } from '../utils/runtime-paths.js';

const BUILTIN_SKILL_ID_PREFIX = 'builtin:';
const MANAGED_SKILL_METADATA_FILE = 'skill.json';
const BUILTIN_HOOK_SKILL_REGISTRY = new Map([
  ['hook-notification', {
    displayName: 'Hook Notification (Mock)',
    version: 1,
  }],
]);
const SERVER_ROOT = findServerRoot(getModuleDir(import.meta.url));
const APP_ROOT = findAppRoot(getModuleDir(import.meta.url));
const DEFAULT_BUILTIN_SKILLS_ROOT = path.join(SERVER_ROOT, 'skills');

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

function parseBuiltinManifest(raw, {
  fallbackName,
  manifestPath,
  registration = null,
  source,
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
    displayName: source === 'packaged' && registration?.displayName
      ? registration.displayName
      : name,
    description,
    version: source === 'packaged' && registration?.version
      ? registration.version
      : Number(parsed.data?.version) || 1,
    source,
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

async function scanSkillRoot(skillsRoot, { source, packagedOnly }) {
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
    const registration = BUILTIN_HOOK_SKILL_REGISTRY.get(entry.name) || null;
    if (packagedOnly && !registration) continue;
    const manifestPath = path.join(skillDirectory, 'SKILL.md');
    try {
      const [directory, file, metadata] = await Promise.all([
        fs.lstat(skillDirectory),
        fs.lstat(manifestPath),
        packagedOnly ? {} : readManagedMetadata(skillDirectory),
      ]);
      if (directory.isSymbolicLink() || !file.isFile() || file.isSymbolicLink()) continue;
      const raw = await fs.readFile(manifestPath, 'utf8');
      const skill = parseBuiltinManifest(raw, {
        fallbackName: packagedOnly ? entry.name : metadata.name || entry.name,
        manifestPath,
        registration,
        source,
      });
      if (skill) skills.push(skill);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return skills;
}

export async function listBuiltinHookSkills({
  skillsRoot = DEFAULT_BUILTIN_SKILLS_ROOT,
  managedSkillsRoot = DEFAULT_MANAGED_BUILTIN_SKILLS_ROOT,
} = {}) {
  const [packaged, uploaded] = await Promise.all([
    scanSkillRoot(skillsRoot, { source: 'packaged', packagedOnly: true }),
    scanSkillRoot(managedSkillsRoot, { source: 'uploaded', packagedOnly: false }),
  ]);
  const skillsById = new Map(packaged.map((skill) => [skill.skillId, skill]));
  uploaded.forEach((skill) => skillsById.set(skill.skillId, skill));
  return [...skillsById.values()]
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export async function loadBuiltinHookSkill({
  skillId,
  skillName,
  skillsRoot = DEFAULT_BUILTIN_SKILLS_ROOT,
  managedSkillsRoot = DEFAULT_MANAGED_BUILTIN_SKILLS_ROOT,
} = {}) {
  const name = normalizeSkillName(skillName);
  if (!name || skillId !== toSkillId(name)) throw new Error('Built-in Hook Skill identity is invalid');
  const skills = await listBuiltinHookSkills({ skillsRoot, managedSkillsRoot });
  const skill = skills.find((candidate) => candidate.skillId === skillId && candidate.name === name);
  if (!skill) throw new Error(`Built-in Hook Skill ${name} is unavailable`);
  return skill;
}

export async function saveManagedBuiltinHookSkill({
  fileName,
  fileBuffer,
  managedSkillsRoot = DEFAULT_MANAGED_BUILTIN_SKILLS_ROOT,
} = {}) {
  if (!Buffer.isBuffer(fileBuffer)) throw createSkillError('Skill file is required');

  const raw = fileBuffer.toString('utf8').replace(/^\uFEFF/, '');
  const name = inferNameFromFile(fileName, raw);
  const directoryKey = `skill-${createHash('sha256').update(name).digest('hex')}`;
  const existingSkills = await scanSkillRoot(managedSkillsRoot, {
    source: 'uploaded',
    packagedOnly: false,
  });
  const existingSkill = existingSkills.find((candidate) => candidate.name === name);
  const skillDirectory = existingSkill
    ? path.dirname(existingSkill.manifestPath)
    : path.join(managedSkillsRoot, directoryKey);
  const manifestPath = path.join(skillDirectory, 'SKILL.md');
  const metadataPath = path.join(skillDirectory, MANAGED_SKILL_METADATA_FILE);
  const skill = parseBuiltinManifest(raw, {
    fallbackName: name,
    manifestPath,
    source: 'uploaded',
  });

  await fs.mkdir(managedSkillsRoot, { recursive: true, mode: 0o700 });
  try {
    const existing = await fs.lstat(skillDirectory);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw createSkillError(`Managed Skill path for ${name} is not a safe directory`, 409);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') await fs.mkdir(skillDirectory, { mode: 0o700 });
    else throw error;
  }

  const temporarySkillPath = path.join(skillDirectory, `.SKILL.${randomUUID()}.tmp`);
  const temporaryMetadataPath = path.join(skillDirectory, `.skill.${randomUUID()}.tmp`);
  try {
    await Promise.all([
      fs.writeFile(temporarySkillPath, fileBuffer, { flag: 'wx', mode: 0o600 }),
      fs.writeFile(temporaryMetadataPath, `${JSON.stringify({ name, fileName: String(fileName || '') })}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      }),
    ]);
    await fs.rename(temporarySkillPath, manifestPath);
    await fs.rename(temporaryMetadataPath, metadataPath);
  } catch (error) {
    await Promise.all([
      fs.unlink(temporarySkillPath).catch(() => {}),
      fs.unlink(temporaryMetadataPath).catch(() => {}),
    ]);
    throw error;
  }
  return skill;
}

export function isBuiltinHookSkillId(value) {
  return String(value || '').startsWith(BUILTIN_SKILL_ID_PREFIX);
}

export {
  BUILTIN_SKILL_ID_PREFIX,
  DEFAULT_BUILTIN_SKILLS_ROOT,
  DEFAULT_MANAGED_BUILTIN_SKILLS_ROOT,
};
