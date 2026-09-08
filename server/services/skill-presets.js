import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { userDb } from '../database/db.js';
import { multitenancyDb } from '../database/multitenancy-db.js';

import {
  downloadRemoteSkillFiles,
  fetchRemoteSkillDetail,
  listSkillMarket,
} from './skill-market.js';
import {
  getWorkspaceSkillsPaths,
  parseSkillManifest,
  readSkillsMetadata,
  writeSkillsMetadata,
} from './workspace-skills.js';
import { applyWorkspaceOwnership } from './workspace-ownership.js';

const SKILL_PREINSTALL_SCOPES = new Set(['none', 'all_workspaces']);

function createHttpError(message, statusCode = 400, code = undefined) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function requirePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw createHttpError(`${name} must be a positive integer`, 400);
  }
  return number;
}

function firstString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ''),
  );
}

function skillSourceId(skill) {
  return firstString(skill?.remoteId || skill?.remote_id || skill?.source?.id)
    || firstString(skill?.skillId || skill?.skill_id || skill?.source?.skillId);
}

function isSameSkillPresetSource(existing, normalized) {
  const existingId = skillSourceId(existing);
  return Boolean(existingId && existingId === skillSourceId(normalized));
}

function disambiguateSkillName(baseName, sourceId, attempt = 1) {
  const suffix = `-${createHash('sha256').update(sourceId).digest('hex').slice(0, 10)}${attempt > 1 ? `-${attempt}` : ''}`;
  return `${baseName.slice(0, 80 - suffix.length)}${suffix}`;
}

function normalizeSkillFolderName(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\s-]+/, '')
    .replace(/[.\s-]+$/, '')
    .slice(0, 80);
  if (!normalized || normalized === '.' || normalized === '..') {
    throw createHttpError('Skill name is required', 400);
  }
  return normalized;
}

function resolveRemoteSkillPresetName(remoteSkill, downloadedSkill = null) {
  return normalizeSkillFolderName(
    firstString(downloadedSkill?.skillName)
    || firstString(remoteSkill.name)
    || firstString(remoteSkill.skillId)
    || firstString(remoteSkill.id)
    || firstString(remoteSkill.displayName),
  );
}

function normalizeEditableStatus(status, fallback = 'draft') {
  const value = status || fallback;
  if (!['draft', 'published', 'disabled'].includes(value)) {
    throw createHttpError('status must be one of: draft, published, disabled', 400);
  }
  return value === 'published' ? 'draft' : value;
}

function normalizePreinstallScope(input = {}) {
  const value = input.preinstallScope ?? (input.preinstall === true ? 'all_workspaces' : 'none');
  if (!SKILL_PREINSTALL_SCOPES.has(value)) {
    throw createHttpError('preinstallScope must be one of: none, all_workspaces', 400);
  }
  return value;
}

function normalizeVersion(value) {
  const version = Number(value ?? 0);
  if (!Number.isInteger(version) || version < 0) {
    throw createHttpError('version must be a non-negative integer', 400);
  }
  return version;
}

function resolveSkillRef(input = {}) {
  const skill = input.skill && typeof input.skill === 'object' ? input.skill : {};
  return firstString(
    input.sourceRef
    || input.remoteId
    || input.remote_id
    || input.skillId
    || input.skill_id
    || input.id
    || skill.id
    || skill.skillId
    || skill.name
    || input.displayName
    || input.name,
  );
}

function normalizeRemotePresetInput(input = {}, remoteSkill, downloadedSkill = null) {
  const skill = input.skill && typeof input.skill === 'object' ? input.skill : {};
  const source = compactObject({
    id: remoteSkill.id,
    skillId: remoteSkill.skillId,
    name: remoteSkill.name,
    displayName: remoteSkill.displayName,
    downloadedSkillName: downloadedSkill?.skillName,
    description: remoteSkill.description,
    nspPath: remoteSkill.nspPath,
    createUserId: remoteSkill.createUserId,
    version: remoteSkill.version,
    sourceType: remoteSkill.sourceType || 'skill-market-api',
  });
  const name = resolveRemoteSkillPresetName(remoteSkill, downloadedSkill);
  const displayName = firstString(remoteSkill.displayName)
    || firstString(remoteSkill.name)
    || firstString(skill.displayName)
    || firstString(skill.name)
    || name;

  return {
    name,
    displayName,
    description: firstString(remoteSkill.description || skill.description),
    sourceType: 'skill-market-api',
    skillId: firstString(remoteSkill.skillId || remoteSkill.id),
    remoteId: firstString(remoteSkill.id || remoteSkill.skillId),
    nspPath: firstString(remoteSkill.nspPath),
    version: normalizeVersion(remoteSkill.version),
    source,
    preinstallScope: normalizePreinstallScope(input),
    status: normalizeEditableStatus(input.status, 'draft'),
  };
}

function toAdminSkillPreset(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    displayName: row.display_name,
    description: row.description || '',
    sourceType: row.source_type || 'skill-market-api',
    skillId: row.skill_id,
    remoteId: row.remote_id,
    nspPath: row.nsp_path || '',
    version: Number(row.version || 0),
    source: row.source || {},
    preinstallScope: row.preinstall_scope || 'none',
    usage: row.preinstall_scope === 'all_workspaces' ? 'tenant' : 'agent_template',
    preinstall: row.preinstall_scope === 'all_workspaces',
    status: row.status,
    lastValidationStatus: row.last_validation_status || null,
    lastValidationError: row.last_validation_error || null,
    lastValidatedAt: row.last_validated_at || null,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isPathInside(rootPath, targetPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeDownloadedFilePath(filePath) {
  const rawPath = String(filePath || '').replace(/\\/g, '/');
  if (!rawPath || rawPath.startsWith('/') || /^[a-zA-Z]:/.test(rawPath)) {
    throw createHttpError('Skill file path is invalid', 400);
  }
  const parts = rawPath.split('/').filter((part) => part && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) {
    throw createHttpError('Skill file path is invalid', 400);
  }
  return parts.join('/');
}

function resolveSkillFilePath(skillDirectory, filePath) {
  const normalized = normalizeDownloadedFilePath(filePath);
  const targetPath = path.resolve(skillDirectory, normalized);
  if (!isPathInside(skillDirectory, targetPath)) {
    throw createHttpError('Skill file path must stay inside the skill directory', 403);
  }
  return targetPath;
}

function normalizeDownloadedSkillPackage(downloadedSkill = {}) {
  const entries = Object.entries(downloadedSkill.files || {}).map(([filePath, content]) => ({
    path: normalizeDownloadedFilePath(filePath),
    content,
  }));
  const rootManifest = entries.find((entry) => entry.path === 'SKILL.md');
  if (!rootManifest) {
    const nestedManifests = entries
      .filter((entry) => entry.path.endsWith('/SKILL.md'))
      .map((entry) => entry.path);
    if (nestedManifests.length > 0) {
      const paths = nestedManifests.map((manifestPath) => `"${manifestPath}"`).join(', ');
      throw createHttpError(
        `Selected skill package is invalid: SKILL.md must be located at the package root; found at ${paths}`,
        400,
      );
    }
    throw createHttpError(
      'Selected skill package is invalid: SKILL.md is required at the package root',
      400,
    );
  }
  return { ...downloadedSkill, files: Object.fromEntries(entries.map((entry) => [entry.path, entry.content])) };
}

async function writeDownloadedFiles(skillDirectory, files) {
  const entries = Object.entries(files || {});
  if (entries.length === 0) {
    throw createHttpError('Skill download did not contain any files', 502);
  }

  await fs.mkdir(skillDirectory, { recursive: true });
  for (const [filePath, content] of entries) {
    const targetPath = resolveSkillFilePath(skillDirectory, filePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, typeof content === 'string' ? content : String(content ?? ''), 'utf8');
  }
}

function requireDownloadedSkillFiles(downloadedSkill) {
  const files = downloadedSkill?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length === 0) {
    throw createHttpError('Skill download did not contain any files', 502);
  }
  // Preset preparation only checks retrieval; files are inspected when installed.
  return downloadedSkill;
}

function assertNoSkillConflict({
  metadata,
  skillName,
  sourcePath,
  runtimePath,
  presetId,
  overwrite,
  allowExistingRuntime = false,
}) {
  const entry = metadata.skills?.[skillName];
  const managedByPreset = entry?.managedBy === 'admin-skill-preset'
    && String(entry?.adminPresetId || '') === String(presetId);
  if (entry && !managedByPreset && !overwrite) {
    throw createHttpError(`Managed skill "${skillName}" already exists`, 409, 'SKILL_PRESET_CONFLICT');
  }
  return Promise.all([
    pathExists(sourcePath),
    pathExists(runtimePath),
  ]).then(([sourceExists, runtimeExists]) => {
    const hasUnexpectedSource = sourceExists && !managedByPreset;
    const hasUnexpectedRuntime = runtimeExists && !managedByPreset && !allowExistingRuntime;
    if (!entry && (hasUnexpectedSource || hasUnexpectedRuntime) && !overwrite) {
      throw createHttpError(`Skill "${skillName}" already exists in the workspace`, 409, 'SKILL_PRESET_CONFLICT');
    }
  });
}

async function removeLegacyPresetSkillSource({
  workspacePath,
  metadata,
  skillName,
  sourcePath,
  presetId,
  overwrite = false,
}) {
  const entry = metadata.skills?.[skillName];
  const managedByPreset = entry?.managedBy === 'admin-skill-preset'
    && String(entry?.adminPresetId || '') === String(presetId);
  if (!managedByPreset && !overwrite) {
    return;
  }

  await fs.rm(sourcePath, { recursive: true, force: true });
  if (!entry) {
    return;
  }

  const nextSkills = { ...metadata.skills };
  delete nextSkills[skillName];
  const { metadataPath } = getWorkspaceSkillsPaths(workspacePath);

  if (Object.keys(nextSkills).length === 0) {
    await fs.rm(metadataPath, { force: true });
    return;
  }
  await writeSkillsMetadata(workspacePath, {
    version: 1,
    skills: nextSkills,
  });
}

async function installDownloadedPresetSkill({
  workspacePath,
  skillName,
  downloadedSkill,
  preset,
  remoteSkill,
  overwrite = false,
  allowExistingRuntime = false,
  now = () => new Date(),
}) {
  const normalizedPackage = normalizeDownloadedSkillPackage(downloadedSkill);
  const metadata = await readSkillsMetadata(workspacePath);
  const { sourceRoot, runtimeRoot } = getWorkspaceSkillsPaths(workspacePath);
  const sourcePath = path.join(sourceRoot, skillName);
  const runtimePath = path.join(runtimeRoot, skillName);
  await assertNoSkillConflict({
    metadata,
    skillName,
    sourcePath,
    runtimePath,
    presetId: preset.id,
    overwrite,
    allowExistingRuntime,
  });

  const operationToken = `${process.pid}.${Date.now()}`;
  const stagePath = path.join(runtimeRoot, `.${skillName}.${operationToken}.stage`);
  const backupPath = path.join(runtimeRoot, `.${skillName}.${operationToken}.backup`);
  await fs.mkdir(runtimeRoot, { recursive: true });
  await fs.rm(stagePath, { recursive: true, force: true });
  await fs.rm(backupPath, { recursive: true, force: true });
  let runtimeBackedUp = false;
  let runtimeInstalled = false;
  try {
    await writeDownloadedFiles(stagePath, normalizedPackage.files);
    const manifest = await parseSkillManifest(stagePath);
    if (manifest.status === 'invalid') {
      throw createHttpError(`Selected skill has an invalid SKILL.md: ${manifest.parseError}`, 400);
    }

    if (await pathExists(runtimePath)) {
      await fs.rename(runtimePath, backupPath);
      runtimeBackedUp = true;
    }
    await fs.rename(stagePath, runtimePath);
    runtimeInstalled = true;
    await applyWorkspaceOwnership({
      workspaceRoot: workspacePath,
      targetPaths: [runtimePath],
      recursive: true,
      reason: 'skill_preset_install',
      context: { presetId: preset.id, skillName },
    });
    await removeLegacyPresetSkillSource({
      workspacePath,
      metadata,
      skillName,
      sourcePath,
      presetId: preset.id,
      overwrite,
    });
    await fs.rm(backupPath, { recursive: true, force: true }).catch((error) => {
      console.warn('[skill-presets] Failed to remove installed skill backup:', error?.message || error);
    });

    return {
      name: skillName,
      displayName: manifest.name || preset.display_name || skillName,
      description: manifest.description || preset.description || '',
      runtimePath,
    };
  } catch (error) {
    await fs.rm(stagePath, { recursive: true, force: true });
    if (runtimeBackedUp) {
      await fs.rm(runtimePath, { recursive: true, force: true });
      await fs.rename(backupPath, runtimePath).catch(() => {});
    } else if (runtimeInstalled) {
      await fs.rm(runtimePath, { recursive: true, force: true });
    }
    throw error;
  }
}

function upsertSkillMarketImport(multitenancy, {
  workspaceId,
  skillName,
  preset,
  remoteSkill,
  now = () => new Date(),
}) {
  if (typeof multitenancy.skillMarketImports?.replaceForWorkspace !== 'function') {
    return [];
  }
  const imports = Object.fromEntries(
    (multitenancy.skillMarketImports.listForWorkspace({ workspaceId }) || [])
      .map((entry) => [entry.name, entry]),
  );
  const existing = imports[skillName] || {};
  const timestamp = now().toISOString();
  imports[skillName] = {
    ...existing,
    name: skillName,
    skillId: preset.skill_id || remoteSkill.skillId || remoteSkill.id,
    id: preset.remote_id || remoteSkill.id || remoteSkill.skillId,
    skillName: preset.display_name || remoteSkill.displayName || remoteSkill.name || skillName,
    nspPath: preset.nsp_path || remoteSkill.nspPath || '',
    createUserId: remoteSkill.createUserId,
    version: Number(remoteSkill.version ?? preset.version ?? 0),
    source: 'skill-market-api',
    importedAt: existing.importedAt || timestamp,
    updatedAt: timestamp,
  };

  return multitenancy.skillMarketImports.replaceForWorkspace({ workspaceId, imports });
}

async function resolveRemoteSkill(input, { tenantCode, accountId, marketService }) {
  const skillRef = resolveSkillRef(input);
  if (!skillRef) {
    throw createHttpError('Skill reference is required', 400);
  }
  const exactId = Boolean(input?.remoteId || input?.remote_id || input?.skill?.id || input?.skill?.skillId);
  return marketService.fetchRemoteSkillDetail(skillRef, { tenantCode, accountId, ...(exactId ? { exactId: true } : {}) });
}

function getUserById(users, userId) {
  return typeof users?.getUserByIdAnyStatus === 'function'
    ? users.getUserByIdAnyStatus(userId)
    : typeof users?.getUserById === 'function'
      ? users.getUserById(userId)
      : null;
}

function summarizeApplyResults(results) {
  return results.reduce((summary, result) => ({
    ...summary,
    [result.action]: summary[result.action] + 1,
  }), {
    total: results.length,
    installed: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  });
}

export function createSkillPresetService({
  multitenancy = multitenancyDb,
  users = userDb,
  marketService = {
    downloadRemoteSkillFiles,
    fetchRemoteSkillDetail,
    listSkillMarket,
  },
} = {}) {
  const getExistingPreset = ({ tenantId, presetId }) => {
    const preset = multitenancy.skillPresets.getPresetById({
      tenantId: requirePositiveInteger(tenantId, 'tenantId'),
      presetId: requirePositiveInteger(presetId, 'presetId'),
    });
    if (!preset) {
      throw createHttpError('Skill preset not found', 404);
    }
    return preset;
  };

  // Display names may repeat. References and internal folder names must not.
  const resolvePresetIdentity = (tenantId, normalized, excludeId = null) => {
    const presets = multitenancy.skillPresets.listPresets({ tenantId, includeDisabled: true });
    const scope = normalized.preinstallScope ?? normalized.preinstall_scope ?? 'none';
    const existing = presets.find((preset) => preset.id !== excludeId
      && preset.preinstall_scope === scope && isSameSkillPresetSource(preset, normalized));
    if (existing) return { existing, name: existing.name };
    const occupied = new Set(presets.filter((preset) => preset.id !== excludeId).map((preset) => preset.name.toLowerCase()));
    let name = normalized.name;
    for (let attempt = 1; occupied.has(name.toLowerCase()); attempt += 1) {
      name = disambiguateSkillName(normalized.name, skillSourceId(normalized), attempt);
    }
    return { existing: null, name };
  };

  const installWorkspaceSkillPreset = async ({
    tenantId,
    workspaceId,
    workspacePath,
    presetId,
    userId,
    tenantCode,
    accountId,
    overwrite = false,
    now = () => new Date(),
  }) => {
    const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
    const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
    const normalizedUserId = requirePositiveInteger(userId, 'userId');
    const preset = getExistingPreset({ tenantId: normalizedTenantId, presetId });
    if (preset.status !== 'published') {
      throw createHttpError('Skill preset is not published', 404);
    }
    const workspaceInstalls = multitenancy.skillPresetInstalls
      ?.listInstallsForWorkspace?.({ workspaceId: normalizedWorkspaceId, includeRemoved: true }) || [];
    const existingPresetInstall = workspaceInstalls.find((install) => Number(install.preset_id) === Number(preset.id));

    let attemptedSkillName = preset.name;
    try {
      const remoteSkill = await marketService.fetchRemoteSkillDetail(
        preset.remote_id || preset.skill_id || preset.name,
        { tenantCode, accountId, ...(skillSourceId(preset) ? { exactId: true } : {}) },
      );
      // Independent configuration records can still refer to the exact same installed
      // package. Do not duplicate or overwrite files when a tenant preset already installed it.
      const reusableInstall = !overwrite && workspaceInstalls.find((install) => install.status === 'installed'
        && Number(install.preset_id) !== Number(preset.id)
        && Number(install.tenant_id) === normalizedTenantId
        && isSameSkillPresetSource(install, preset)
        && Number(install.installed_version) === Number(remoteSkill.version ?? preset.version ?? 0));
      if (reusableInstall && await pathExists(path.join(workspacePath, '.claude', 'skills', reusableInstall.skill_name, 'SKILL.md'))) {
        const install = multitenancy.skillPresetInstalls.upsertInstall({
          workspaceId: normalizedWorkspaceId,
          presetId: preset.id,
          skillName: reusableInstall.skill_name,
          installedByUserId: normalizedUserId,
          installedVersion: reusableInstall.installed_version,
          status: 'installed',
          lastError: null,
        });
        return {
          preset: toAdminSkillPreset(preset),
          installed: { presetId: preset.id, skillName: reusableInstall.skill_name, displayName: preset.display_name,
            version: reusableInstall.installed_version, install, reused: true, appliesOn: 'next_agent_turn' },
        };
      }
      const downloadedSkill = normalizeDownloadedSkillPackage(
        await marketService.downloadRemoteSkillFiles(remoteSkill, { tenantCode, accountId }),
      );
      // Retain the preset's collision-safe name, and the path of legacy installs.
      attemptedSkillName = existingPresetInstall?.skill_name || preset.name;
      const occupiedByOtherPresets = new Set(workspaceInstalls
        .filter((install) => install.status === 'installed' && Number(install.preset_id) !== Number(preset.id))
        .map((install) => install.skill_name.toLowerCase()));
      // A multi-tenant template can include two independently named presets.
      if (occupiedByOtherPresets.has(attemptedSkillName.toLowerCase())) {
        const { runtimeRoot, sourceRoot } = getWorkspaceSkillsPaths(workspacePath);
        let attempt = 0;
        do {
          attemptedSkillName = disambiguateSkillName(preset.name, `${normalizedTenantId}:${skillSourceId(preset)}`, ++attempt);
        } while (occupiedByOtherPresets.has(attemptedSkillName.toLowerCase())
          || await pathExists(path.join(runtimeRoot, attemptedSkillName))
          || await pathExists(path.join(sourceRoot, attemptedSkillName)));
      }
      const skill = await installDownloadedPresetSkill({
        workspacePath,
        skillName: attemptedSkillName,
        downloadedSkill,
        preset,
        remoteSkill,
        overwrite,
        allowExistingRuntime: existingPresetInstall?.status === 'installed'
          && existingPresetInstall?.skill_name === attemptedSkillName,
        now,
      });
      upsertSkillMarketImport(multitenancy, {
        workspaceId: normalizedWorkspaceId,
        skillName: attemptedSkillName,
        preset,
        remoteSkill,
        now,
      });
      const install = multitenancy.skillPresetInstalls?.upsertInstall?.({
        workspaceId: normalizedWorkspaceId,
        presetId: preset.id,
        skillName: attemptedSkillName,
        installedByUserId: normalizedUserId,
        installedVersion: Number(remoteSkill.version ?? preset.version ?? 0),
        status: 'installed',
        lastError: null,
      });

      return {
        preset: toAdminSkillPreset(preset),
        installed: {
          presetId: preset.id,
          skillName: attemptedSkillName,
          displayName: preset.display_name,
          version: Number(remoteSkill.version ?? preset.version ?? 0),
          install,
          skill,
          appliesOn: 'next_agent_turn',
        },
      };
    } catch (error) {
      multitenancy.skillPresetInstalls?.upsertInstall?.({
        workspaceId: normalizedWorkspaceId,
        presetId: preset.id,
        skillName: attemptedSkillName,
        installedByUserId: normalizedUserId,
        installedVersion: Number(preset.version || 0),
        status: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  return {
    searchMarketSkills: async ({
      searchContent = '',
      page = 1,
      pageSize = 20,
      tenantCode,
      accountId,
      completeInventory = false,
    } = {}) => {
      const result = await marketService.listSkillMarket({
        searchContent,
        page,
        pageSize,
        tenantCode,
        accountId,
        includePageInfo: true,
        completeInventory,
      });
      return {
        skills: result.skills || [],
        pageInfo: result.pageInfo,
        openApiRequestBody: result.openApiRequestBody,
      };
    },

    listAdminPresets: ({ tenantId, includeDisabled = true, status = null, preinstallScope = null }) => {
      return multitenancy.skillPresets.listPresets({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        includeDisabled,
        status,
        preinstallScope,
      }).map(toAdminSkillPreset);
    },

    createPreset: async ({ tenantId, userId, input, tenantCode, accountId }) => {
      const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
      const remoteSkill = await resolveRemoteSkill(input, { tenantCode, accountId, marketService });
      const downloadedSkill = requireDownloadedSkillFiles(
        await marketService.downloadRemoteSkillFiles(remoteSkill, { tenantCode, accountId }),
      );
      const normalized = normalizeRemotePresetInput(input, remoteSkill, downloadedSkill);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { existing, name } = resolvePresetIdentity(normalizedTenantId, normalized);
        if (existing) return toAdminSkillPreset(existing);
        try {
          return toAdminSkillPreset(multitenancy.skillPresets.createPreset({
            tenantId: normalizedTenantId,
            ...normalized,
            name,
            createdByUserId: requirePositiveInteger(userId, 'userId'),
          }));
        } catch (error) {
          const isUniqueConstraint = error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
            || error?.code === 'SQLITE_CONSTRAINT';
          if (!isUniqueConstraint || attempt === 2) throw error;
        }
      }
    },

    updatePreset: async ({ tenantId, presetId, userId, input, tenantCode, accountId }) => {
      const existing = getExistingPreset({ tenantId, presetId });
      if ((input?.preinstallScope !== undefined || input?.preinstall !== undefined)
        && normalizePreinstallScope(input) !== existing.preinstall_scope) {
        throw createHttpError('Skill 预置和 Agent 模板的用途不能互相转换，请在对应页面单独配置', 400);
      }
      const remoteSkill = await resolveRemoteSkill(input, { tenantCode, accountId, marketService });
      const downloadedSkill = requireDownloadedSkillFiles(
        await marketService.downloadRemoteSkillFiles(remoteSkill, { tenantCode, accountId }),
      );
      const normalized = normalizeRemotePresetInput({ ...input, preinstallScope: existing.preinstall_scope }, remoteSkill, downloadedSkill);
      const identity = resolvePresetIdentity(requirePositiveInteger(tenantId, 'tenantId'), normalized, existing.id);
      if (identity.existing) {
        throw createHttpError('该技能已存在预置，请使用已有预置', 409, 'SKILL_PRESET_SOURCE_CONFLICT');
      }
      const preset = multitenancy.skillPresets.updatePreset({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
        ...normalized,
        name: isSameSkillPresetSource(existing, normalized) ? existing.name : identity.name,
        status: normalizeEditableStatus(input?.status, existing.status === 'disabled' ? 'disabled' : 'draft'),
        updatedByUserId: requirePositiveInteger(userId, 'userId'),
      });
      return toAdminSkillPreset(preset);
    },

    validatePreset: async ({ tenantId, presetId, userId, tenantCode, accountId }) => {
      const preset = getExistingPreset({ tenantId, presetId });
      try {
        const remoteSkill = await marketService.fetchRemoteSkillDetail(
          preset.remote_id || preset.skill_id || preset.name,
          { tenantCode, accountId, ...(skillSourceId(preset) ? { exactId: true } : {}) },
        );
        requireDownloadedSkillFiles(
          await marketService.downloadRemoteSkillFiles(remoteSkill, { tenantCode, accountId }),
        );
        const validated = multitenancy.skillPresets.recordValidation({
          tenantId: requirePositiveInteger(tenantId, 'tenantId'),
          presetId: requirePositiveInteger(presetId, 'presetId'),
          status: 'healthy',
          error: null,
          updatedByUserId: requirePositiveInteger(userId, 'userId'),
        });
        return {
          preset: toAdminSkillPreset(validated),
          validation: {
            status: 'healthy',
            displayName: remoteSkill.displayName || remoteSkill.name || preset.display_name || preset.name,
            description: remoteSkill.description || preset.description || '',
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to validate skill preset';
        const failed = multitenancy.skillPresets.recordValidation({
          tenantId: requirePositiveInteger(tenantId, 'tenantId'),
          presetId: requirePositiveInteger(presetId, 'presetId'),
          status: 'failed',
          error: message,
          updatedByUserId: requirePositiveInteger(userId, 'userId'),
        });
        return {
          preset: toAdminSkillPreset(failed),
          validation: {
            status: 'failed',
            error: message,
          },
        };
      }
    },

    publishPreset: ({ tenantId, presetId, userId }) => {
      const preset = getExistingPreset({ tenantId, presetId });
      if (preset.last_validation_status !== 'healthy') {
        throw createHttpError('Skill preset requires a successful validation before publish', 400);
      }
      const published = multitenancy.skillPresets.publishPreset({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
        updatedByUserId: requirePositiveInteger(userId, 'userId'),
      });
      return toAdminSkillPreset(published);
    },

    disablePreset: ({ tenantId, presetId, userId }) => {
      getExistingPreset({ tenantId, presetId });
      const disabled = multitenancy.skillPresets.disablePreset({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
        updatedByUserId: requirePositiveInteger(userId, 'userId'),
      });
      return toAdminSkillPreset(disabled);
    },

    deletePreset: ({ tenantId, presetId }) => {
      getExistingPreset({ tenantId, presetId });
      return multitenancy.skillPresets.deletePreset({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
      });
    },

    copyPresetToTenants: ({ tenantId, presetId, targetTenantIds, userId }) => {
      if (!Array.isArray(targetTenantIds)) {
        throw createHttpError('targetTenantIds must be an array', 400);
      }
      const sourceTenantId = requirePositiveInteger(tenantId, 'tenantId');
      const sourcePreset = getExistingPreset({ tenantId: sourceTenantId, presetId });
      const results = [];
      const seen = new Set();
      for (const targetTenantId of targetTenantIds) {
        const normalizedTargetTenantId = requirePositiveInteger(targetTenantId, 'targetTenantId');
        if (seen.has(normalizedTargetTenantId)) continue;
        seen.add(normalizedTargetTenantId);
        if (normalizedTargetTenantId === sourceTenantId) {
          results.push({ tenantId: normalizedTargetTenantId, action: 'skipped', reason: 'source_tenant' });
          continue;
        }

        const targetTenant = multitenancy.tenants?.getTenantById?.(normalizedTargetTenantId);
        if (!targetTenant) {
          results.push({ tenantId: normalizedTargetTenantId, action: 'skipped', reason: 'tenant_not_found' });
          continue;
        }

        try {
          const { existing: existingPreset, name } = resolvePresetIdentity(normalizedTargetTenantId, sourcePreset);
          const status = normalizeEditableStatus(
            sourcePreset.status,
            sourcePreset.status === 'disabled' ? 'disabled' : 'draft',
          );
          const targetPreset = existingPreset
            ? multitenancy.skillPresets.updatePreset({
              tenantId: normalizedTargetTenantId,
              presetId: existingPreset.id,
              name,
              displayName: sourcePreset.display_name,
              description: sourcePreset.description || '',
              sourceType: sourcePreset.source_type || 'skill-market-api',
              skillId: sourcePreset.skill_id,
              remoteId: sourcePreset.remote_id,
              nspPath: sourcePreset.nsp_path || '',
              version: Number(sourcePreset.version || 0),
              source: sourcePreset.source || {},
              preinstallScope: sourcePreset.preinstall_scope || 'none',
              status,
              updatedByUserId: requirePositiveInteger(userId, 'userId'),
            })
            : multitenancy.skillPresets.createPreset({
              tenantId: normalizedTargetTenantId,
              name,
              displayName: sourcePreset.display_name,
              description: sourcePreset.description || '',
              sourceType: sourcePreset.source_type || 'skill-market-api',
              skillId: sourcePreset.skill_id,
              remoteId: sourcePreset.remote_id,
              nspPath: sourcePreset.nsp_path || '',
              version: Number(sourcePreset.version || 0),
              source: sourcePreset.source || {},
              preinstallScope: sourcePreset.preinstall_scope || 'none',
              status,
              createdByUserId: requirePositiveInteger(userId, 'userId'),
            });
          results.push({
            tenantId: normalizedTargetTenantId,
            action: existingPreset ? 'updated' : 'created',
            preset: toAdminSkillPreset(targetPreset),
          });
        } catch (error) {
          results.push({
            tenantId: normalizedTargetTenantId,
            action: 'failed',
            error: error instanceof Error ? error.message : 'Failed to copy skill preset',
          });
        }
      }

      return {
        sourcePreset: toAdminSkillPreset(sourcePreset),
        results,
        summary: results.reduce((summary, result) => ({
          ...summary,
          [result.action]: summary[result.action] + 1,
        }), {
          total: results.length,
          created: 0,
          updated: 0,
          skipped: 0,
          failed: 0,
        }),
      };
    },

    installWorkspaceSkillPreset,

    installPreinstalledSkillPresets: async ({
      tenantId,
      workspaceId,
      workspacePath,
      userId,
      tenantCode,
      accountId,
      preinstallScope = 'all_workspaces',
    }) => {
      if (typeof multitenancy.skillPresets?.listPresets !== 'function') {
        return { installed: [], errors: [] };
      }

      const presets = multitenancy.skillPresets.listPresets({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        status: 'published',
        preinstallScope,
      });
      const installed = [];
      const errors = [];

      for (const preset of presets) {
        try {
          const result = await installWorkspaceSkillPreset({
            tenantId,
            workspaceId,
            workspacePath,
            presetId: preset.id,
            userId,
            tenantCode,
            accountId,
          });
          installed.push(result.installed);
        } catch (error) {
          errors.push({
            presetId: preset.id,
            name: preset.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { installed, errors };
    },

    applyPresetToExistingWorkspaces: async ({
      tenantId,
      presetId,
      userId,
      tenantCode,
      overwrite = false,
    }) => {
      const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
      const preset = getExistingPreset({ tenantId: normalizedTenantId, presetId });
      if (preset.status !== 'published') {
        throw createHttpError('Skill preset must be published before applying to workspaces', 400);
      }
      const workspaces = multitenancy.workspaces?.listActiveForTenant?.({ tenantId: normalizedTenantId }) || [];
      const results = [];
      for (const workspace of workspaces) {
        const owner = getUserById(users, workspace.owner_user_id);
        const accountId = firstString(owner?.username);
        if (!accountId) {
          results.push({
            workspaceId: workspace.id,
            action: 'failed',
            error: 'Workspace owner username is required',
          });
          continue;
        }

        try {
          const previousInstall = multitenancy.skillPresetInstalls
            ?.listInstallsForWorkspace?.({ workspaceId: workspace.id, includeRemoved: true })
            ?.find((install) => Number(install.preset_id) === Number(preset.id));
          const result = await installWorkspaceSkillPreset({
            tenantId: normalizedTenantId,
            workspaceId: workspace.id,
            workspacePath: workspace.path,
            presetId: preset.id,
            userId: workspace.owner_user_id,
            tenantCode,
            accountId,
            overwrite,
          });
          results.push({
            workspaceId: workspace.id,
            workspaceName: workspace.display_name,
            action: previousInstall?.status === 'installed' ? 'updated' : 'installed',
            installed: result.installed,
          });
        } catch (error) {
          results.push({
            workspaceId: workspace.id,
            workspaceName: workspace.display_name,
            action: error?.code === 'SKILL_PRESET_CONFLICT' ? 'skipped' : 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        preset: toAdminSkillPreset(preset),
        results,
        summary: summarizeApplyResults(results),
      };
    },
  };
}

export const skillPresetService = createSkillPresetService();
