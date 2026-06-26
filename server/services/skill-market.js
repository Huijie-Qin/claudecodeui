import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';

const DEFAULT_MARKET_API_URL = 'http://127.0.0.1:3101';
const MARKET_REQUEST_TIMEOUT_MS = 10000;
const MARKET_RESPONSE_LOG_SNIPPET_CHARS = 500;
const DEFAULT_LIST_PAGE_SIZE = 20;
const MARKET_AUTH_SCHEME = 'CLOUDSOA-HMAC-SHA256';
const MARKET_ENDPOINT_PREFIX = '/data-agent';
const DATA_AGENT_TENANT_HEADER = 'X-Data-Agent-Tenant';
const ACCOUNT_ID_HEADER = 'X-Account-Id';
const MARKET_LOG_LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};
let marketRequestSequence = 0;

export function getSkillMarketPaths(workspacePath) {
  return {
    importsPath: path.join(workspacePath, '.cloudcli', 'skills', 'market-imports.json'),
    runtimeRoot: path.join(workspacePath, '.claude', 'skills'),
  };
}

export async function listSkillMarket(options = {}) {
  const normalizedOptions = typeof options === 'string' ? { workspacePath: options } : options;
  const {
    workspaceId,
    workspacePath,
    searchContent = '',
    page = 1,
    pageSize = DEFAULT_LIST_PAGE_SIZE,
    currentUsername,
    tenantCode,
    accountId,
    includePageInfo = false,
  } = normalizedOptions;
  const normalizedPage = normalizePositiveInteger(page, 1);
  const normalizedPageSize = normalizePositiveInteger(pageSize, DEFAULT_LIST_PAGE_SIZE);
  const remoteAccountId = accountId ?? currentUsername;
  const openApiRequestBody = createSkillListRequestBody({
    searchContent,
    page: normalizedPage,
    pageSize: normalizedPageSize,
  });
  const remoteSkills = await fetchRemoteSkillList({
    searchContent,
    page: normalizedPage,
    pageSize: normalizedPageSize,
    tenantCode,
    accountId: remoteAccountId,
  });

  if (!workspacePath) {
    if (includePageInfo) {
      return {
        skills: remoteSkills,
        pageInfo: createSkillListPageInfo(remoteSkills.length, normalizedPage, normalizedPageSize),
        openApiRequestBody,
      };
    }
    return remoteSkills;
  }

  const imports = await readMarketImports({ workspaceId, workspacePath });
  const enrichedRemoteSkills = await Promise.all(
    remoteSkills.map(async (skill) => {
      const status = await getImportStatusForRemoteSkill(workspacePath, skill, imports);
      return {
        ...skill,
        ...(status.imported ? { name: status.skillName } : {}),
        ...toLocalImportState(status, skill, currentUsername),
      };
    }),
  );
  const importedSkillSummaries = await listImportedSkillSummariesMissingFromRemotePage({
    workspacePath,
    imports,
    remoteSkills: enrichedRemoteSkills,
    currentUsername,
    tenantCode,
    accountId: remoteAccountId,
    searchContent,
  });
  const skills = [...enrichedRemoteSkills, ...importedSkillSummaries];
  if (includePageInfo) {
    return {
      skills,
      pageInfo: createSkillListPageInfo(remoteSkills.length, normalizedPage, normalizedPageSize),
      openApiRequestBody,
    };
  }
  return skills;
}

export async function getSkillMarketDetail({ workspaceId, workspacePath, name, currentUsername, tenantCode, accountId }) {
  const remoteAccountId = accountId ?? currentUsername;
  const imports = await readMarketImports({ workspaceId, workspacePath });
  const requestedSkillName = normalizeRuntimeSkillFolderName(name);
  const requestedStatus = await getImportStatus(workspacePath, requestedSkillName, imports);
  const lookupRef = requestedStatus.imported
    ? getRemoteSkillLookupRef(requestedSkillName, requestedStatus.metadataEntry)
    : name;
  let remoteSkill;
  try {
    remoteSkill = await fetchRemoteSkillDetail(lookupRef, { tenantCode, accountId: remoteAccountId });
  } catch (error) {
    if (isNotFoundError(error)) {
      if (requestedStatus.imported) {
        return getRemoteDeletedSkillDetail({ workspacePath, skillName: requestedSkillName, status: requestedStatus });
      }
    }
    throw error;
  }
  const status = remoteSkill.name === requestedSkillName
    ? requestedStatus
    : await getImportStatusForRemoteSkill(workspacePath, remoteSkill, imports);
  let runtimeSkillName = status.imported ? status.skillName : remoteSkill.name;
  let directoryTree;
  let files;

  if (status.imported) {
    const localFiles = await readSkillDirectoryFiles(getRuntimeSkillPath(workspacePath, runtimeSkillName));
    directoryTree = buildDirectoryTreeFromFiles(localFiles);
    files = summarizeSkillFiles(localFiles);
  } else {
    const preview = await previewRemoteSkill(remoteSkill, undefined, { tenantCode, accountId: remoteAccountId });
    directoryTree = preview.directoryTree;
    files = flattenDirectoryTree(preview.directoryTree);
    runtimeSkillName = inferRuntimeSkillNameFromFileEntries(files) || runtimeSkillName;
  }

  return {
    ...remoteSkill,
    ...(status.imported ? { name: runtimeSkillName } : {}),
    ...toLocalImportState(status, remoteSkill, currentUsername),
    targetPath: path.join('.claude', 'skills', runtimeSkillName).split(path.sep).join('/'),
    directoryTree,
    files,
  };
}

export async function viewMarketSkillFile({ workspaceId, workspacePath, name, filePath, tenantCode, accountId }) {
  const imports = workspacePath
    ? await readMarketImports({ workspaceId, workspacePath })
    : { version: 1, imports: {} };
  const requestedSkillName = normalizeRuntimeSkillFolderName(name);
  const requestedStatus = workspacePath
    ? await getImportStatus(workspacePath, requestedSkillName, imports)
    : { imported: false };
  const lookupRef = requestedStatus.imported
    ? getRemoteSkillLookupRef(requestedSkillName, requestedStatus.metadataEntry)
    : name;
  let remoteSkill;
  try {
    remoteSkill = await fetchRemoteSkillDetail(lookupRef, { tenantCode, accountId });
  } catch (error) {
    if (isNotFoundError(error) && workspacePath) {
      if (requestedStatus.imported) {
        const localFile = await readLocalSkillFile(getRuntimeSkillPath(workspacePath, requestedSkillName), filePath);
        return {
          skillId: requestedStatus.metadataEntry?.skillId || requestedStatus.metadataEntry?.id || requestedSkillName,
          name: requestedSkillName,
          remoteDeleted: true,
          file: localFile,
        };
      }
    }
    throw error;
  }
  const status = workspacePath
    ? remoteSkill.name === requestedSkillName
      ? requestedStatus
      : await getImportStatusForRemoteSkill(workspacePath, remoteSkill, imports)
    : { imported: false };
  const runtimeSkillName = status.imported ? status.skillName : remoteSkill.name;
  const file = status.imported
    ? await readLocalSkillFile(getRuntimeSkillPath(workspacePath, runtimeSkillName), filePath)
    : await previewRemoteSkillFile(remoteSkill, filePath, { tenantCode, accountId });

  return {
    skillId: remoteSkill.skillId,
    name: runtimeSkillName,
    file,
  };
}

export async function downloadMarketSkill({
  workspaceId,
  workspacePath,
  name,
  overwrite = false,
  now = () => new Date(),
  tenantCode,
  accountId,
}) {
  const remoteSkill = await fetchRemoteSkillDetail(name, { tenantCode, accountId });
  const imports = await readMarketImports({ workspaceId, workspacePath });
  const existingImportEntry = getImportEntryForRemoteSkill(remoteSkill, imports);
  const existingStatus = existingImportEntry
    ? await getImportStatus(workspacePath, existingImportEntry.skillName, imports)
    : null;

  if (existingStatus?.imported && !overwrite) {
    throw createHttpError(`Skill "${existingStatus.skillName}" has already been imported`, 409);
  }

  const downloadedSkill = await downloadRemoteSkillFiles(remoteSkill, { tenantCode, accountId });
  const skillName = downloadedSkill.skillName || existingImportEntry?.skillName || remoteSkill.name;
  const previousSkillName = existingImportEntry?.skillName && existingImportEntry.skillName !== skillName
    ? existingImportEntry.skillName
    : null;
  const runtimePath = getRuntimeSkillPath(workspacePath, skillName);
  const status = existingStatus?.skillName === skillName
    ? existingStatus
    : await getImportStatus(workspacePath, skillName, imports);

  if (previousSkillName && existingStatus?.imported && !overwrite) {
    throw createHttpError(`Skill "${previousSkillName}" has already been imported`, 409);
  }
  if (status.imported && !overwrite) {
    throw createHttpError(`Skill "${skillName}" has already been imported`, 409);
  }
  if (status.runtimeExists && !status.imported) {
    throw createHttpError(`A .claude/skills/${skillName} directory already exists`, 409);
  }

  if (overwrite) {
    await fs.rm(runtimePath, { recursive: true, force: true });
    if (previousSkillName && existingStatus?.imported) {
      await fs.rm(getRuntimeSkillPath(workspacePath, previousSkillName), { recursive: true, force: true });
    }
  }
  await writeDownloadedFiles(runtimePath, downloadedSkill.files);

  const timestamp = now().toISOString();
  const nextImports = { ...imports.imports };
  if (previousSkillName) {
    delete nextImports[previousSkillName];
  }
  await writeMarketImports({ workspaceId, workspacePath }, {
    version: 1,
    imports: {
      ...nextImports,
      [skillName]: {
        ...nextImports[skillName],
        name: skillName,
        skillId: remoteSkill.skillId,
        id: remoteSkill.id,
        skillName: remoteSkill.displayName,
        nspPath: remoteSkill.nspPath,
        createUserId: remoteSkill.createUserId,
        version: remoteSkill.version,
        source: 'skill-market-api',
        importedAt: imports.imports[skillName]?.importedAt || timestamp,
        updatedAt: timestamp,
      },
    },
  });

  return getSkillMarketDetail({ workspaceId, workspacePath, name: skillName, tenantCode, accountId });
}

export async function getMarketSkillPublishPreview({ workspaceId, workspacePath, name, currentUsername, tenantCode, accountId }) {
  const remoteAccountId = accountId ?? currentUsername;
  const imports = await readMarketImports({ workspaceId, workspacePath });
  const requestedSkillName = normalizeRuntimeSkillFolderName(name);
  const requestedStatus = await getImportStatus(workspacePath, requestedSkillName, imports);
  const lookupRef = requestedStatus.imported
    ? getRemoteSkillLookupRef(requestedSkillName, requestedStatus.metadataEntry)
    : name;
  let remoteSkill;
  try {
    remoteSkill = await fetchRemoteSkillDetail(lookupRef, { tenantCode, accountId: remoteAccountId });
  } catch (error) {
    if (isNotFoundError(error)) {
      if (requestedStatus.imported) {
        throw createHttpError('Remote skill has been deleted. Upload and publish it again.', 409);
      }
    }
    throw error;
  }
  const status = remoteSkill.name === requestedSkillName
    ? requestedStatus
    : await getImportStatusForRemoteSkill(workspacePath, remoteSkill, imports);
  ensurePublishAllowed(remoteSkill, status, currentUsername);

  const runtimePath = getRuntimeSkillPath(workspacePath, status.skillName);
  const localFiles = await readSkillDirectoryFiles(runtimePath);
  const remoteFiles = await readRemoteSkillFiles(remoteSkill, {
    tenantCode,
    accountId: remoteAccountId,
    skillRootName: status.skillName,
  });
  const changes = compareSkillFiles(remoteFiles, localFiles);

  return {
    skill: {
      name: status.skillName,
      displayName: remoteSkill.displayName,
      version: remoteSkill.version,
    },
    changes,
  };
}

export async function getMarketSkillPublishState({ workspaceId, workspacePath, name, currentUsername, tenantCode, accountId }) {
  const skillName = normalizeRuntimeSkillFolderName(name);
  const imports = await readMarketImports({ workspaceId, workspacePath });
  const status = await getImportStatus(workspacePath, skillName, imports);

  if (!status.runtimeExists) {
    return {
      name: skillName,
      imported: false,
      runtimeExists: false,
      canUploadAndPublish: false,
      canPublish: false,
    };
  }

  if (!status.imported) {
    return {
      name: skillName,
      displayName: skillName,
      imported: false,
      runtimeExists: true,
      conflict: true,
      canUploadAndPublish: true,
      canPublish: false,
    };
  }

  const remoteAccountId = accountId ?? currentUsername;
  let remoteSkill;
  try {
    remoteSkill = await fetchRemoteSkillDetail(getRemoteSkillLookupRef(skillName, status.metadataEntry), {
      tenantCode,
      accountId: remoteAccountId,
    });
  } catch (error) {
    if (isNotFoundError(error)) {
      return toRemoteDeletedLocalImportState(skillName, status);
    }
    throw error;
  }
  return {
    ...remoteSkill,
    name: skillName,
    ...toLocalImportState(status, remoteSkill, currentUsername),
    canUploadAndPublish: false,
  };
}

export async function publishMarketSkill({
  workspaceId,
  workspacePath,
  name,
  currentUsername,
  now = () => new Date(),
  tenantCode,
  accountId,
}) {
  const remoteAccountId = accountId ?? currentUsername;
  const imports = await readMarketImports({ workspaceId, workspacePath });
  const requestedSkillName = normalizeRuntimeSkillFolderName(name);
  const requestedStatus = await getImportStatus(workspacePath, requestedSkillName, imports);
  const lookupRef = requestedStatus.imported
    ? getRemoteSkillLookupRef(requestedSkillName, requestedStatus.metadataEntry)
    : name;
  let remoteSkill;
  try {
    remoteSkill = await fetchRemoteSkillDetail(lookupRef, { tenantCode, accountId: remoteAccountId });
  } catch (error) {
    if (isNotFoundError(error)) {
      if (requestedStatus.imported) {
        throw createHttpError('Remote skill has been deleted. Upload and publish it again.', 409);
      }
    }
    throw error;
  }
  const status = remoteSkill.name === requestedSkillName
    ? requestedStatus
    : await getImportStatusForRemoteSkill(workspacePath, remoteSkill, imports);
  ensurePublishAllowed(remoteSkill, status, currentUsername);

  const importSkillName = status.skillName || remoteSkill.name;
  const runtimePath = getRuntimeSkillPath(workspacePath, importSkillName);
  const files = await readSkillDirectoryFiles(runtimePath);
  const updateForm = await buildSkillUpdateForm(remoteSkill, files, importSkillName);
  await requestMarketForm('/api/skill/update', updateForm, {
    tenantCode,
    accountId: remoteAccountId,
  });

  const publishPayload = await requestMarketJson('/api/skill/publish', {
    method: 'POST',
    tenantCode,
    accountId: remoteAccountId,
    body: {
      data: {
        id: remoteSkill.id,
      },
    },
  });

  const publishedAt = now().toISOString();
  const publishedVersion = normalizeVersion(publishPayload.data?.version) ?? (remoteSkill.version + 1);
  await writeMarketImports({ workspaceId, workspacePath }, {
    version: 1,
    imports: {
      ...imports.imports,
      [importSkillName]: {
        ...imports.imports[importSkillName],
        name: importSkillName,
        skillId: remoteSkill.skillId,
        id: remoteSkill.id,
        skillName: remoteSkill.displayName,
        nspPath: remoteSkill.nspPath,
        createUserId: remoteSkill.createUserId,
        version: publishedVersion,
        source: 'skill-market-api',
        updatedAt: publishedAt,
      },
    },
  });

  return {
    skill: await getSkillMarketDetail({
      workspacePath,
      workspaceId,
      name: importSkillName,
      currentUsername,
      tenantCode,
      accountId: remoteAccountId,
    }),
    publishedAt,
    publishedVersion,
    submittedFileCount: files.length,
  };
}

export const submitMarketSkill = publishMarketSkill;

export async function uploadAndPublishLocalSkill({
  workspaceId,
  workspacePath,
  name,
  currentUsername,
  now = () => new Date(),
  tenantCode,
  accountId,
}) {
  const skillName = normalizeRuntimeSkillFolderName(name);
  const remoteAccountId = accountId ?? currentUsername;
  const imports = await readMarketImports({ workspaceId, workspacePath });
  const status = await getImportStatus(workspacePath, skillName, imports);

  if (!status.runtimeExists) {
    throw createHttpError(`Local skill "${skillName}" was not found`, 404);
  }
  if (status.imported) {
    const remoteDeleted = await isRemoteSkillDeleted(getRemoteSkillLookupRef(skillName, status.metadataEntry), {
      tenantCode,
      accountId: remoteAccountId,
    });
    if (!remoteDeleted) {
      throw createHttpError(`Market skill "${skillName}" has already been imported`, 409);
    }
  }

  const runtimePath = getRuntimeSkillPath(workspacePath, skillName);
  const files = await readSkillDirectoryFiles(runtimePath);
  const savePayload = await requestMarketForm('/api/skill/save', await buildSkillSaveForm(skillName, files), {
    tenantCode,
    accountId: remoteAccountId,
  });
  const savedSkillId = extractSavedSkillId(savePayload);

  const publishPayload = await requestMarketJson('/api/skill/publish', {
    method: 'POST',
    tenantCode,
    accountId: remoteAccountId,
    body: {
      data: {
        id: savedSkillId,
      },
    },
  });

  const publishedAt = now().toISOString();
  const savedSkill = normalizeSavedSkillPayload(savePayload, {
    id: savedSkillId,
    name: skillName,
    currentUsername,
  });
  const publishedVersion = normalizeVersion(publishPayload.data?.version)
    ?? normalizeVersion(savedSkill.version)
    ?? 1;

  await writeMarketImports({ workspaceId, workspacePath }, {
    version: 1,
    imports: {
      ...imports.imports,
      [skillName]: {
        name: skillName,
        skillId: savedSkillId,
        id: savedSkillId,
        skillName: savedSkill.displayName,
        nspPath: savedSkill.nspPath,
        createUserId: savedSkill.createUserId,
        version: publishedVersion,
        source: 'skill-market-api',
        importedAt: imports.imports[skillName]?.importedAt || publishedAt,
        updatedAt: publishedAt,
      },
    },
  });

  return {
    skill: {
      ...savedSkill,
      name: skillName,
      imported: true,
      runtimeExists: true,
      importedVersion: publishedVersion,
      version: publishedVersion,
      canPublish: true,
      canUploadAndPublish: false,
      updatedAt: publishedAt,
    },
    publishedAt,
    publishedVersion,
    submittedFileCount: files.length,
  };
}

export async function removeMarketSkill({ workspaceId, workspacePath, name }) {
  const skillName = normalizeRuntimeSkillFolderName(name);
  const imports = await readMarketImports({ workspaceId, workspacePath });
  if (!imports.imports?.[skillName]) {
    throw createHttpError(`Market skill "${skillName}" has not been imported`, 404);
  }

  await fs.rm(getRuntimeSkillPath(workspacePath, skillName), { recursive: true, force: true });
  const nextImports = { ...imports.imports };
  delete nextImports[skillName];
  await writeMarketImports({ workspaceId, workspacePath }, {
    version: 1,
    imports: nextImports,
  });

  return {
    removed: skillName,
  };
}

export const importMarketSkill = downloadMarketSkill;

async function fetchRemoteSkillList({
  searchContent = '',
  page = 1,
  pageSize = DEFAULT_LIST_PAGE_SIZE,
  tenantCode,
  accountId,
} = {}) {
  const body = createSkillListRequestBody({ searchContent, page, pageSize });
  const payload = await requestMarketJson('/api/skill/skillList', {
    method: 'POST',
    tenantCode,
    accountId,
    body,
  });

  return normalizeSkillListPayload(payload.data)
    .map(normalizeRemoteSkillSummary);
}

function createSkillListRequestBody({ searchContent = '', page = 1, pageSize = DEFAULT_LIST_PAGE_SIZE } = {}) {
  return {
    data: {
      hasPublishedVersion: true,
      searchContent,
    },
    pageInfo: {
      page: normalizePositiveInteger(page, 1),
      pageSize: normalizePositiveInteger(pageSize, DEFAULT_LIST_PAGE_SIZE),
    },
  };
}

function createSkillListPageInfo(remoteCount, page, pageSize) {
  return {
    page,
    pageSize,
    hasNextPage: remoteCount >= pageSize,
  };
}

async function fetchRemoteSkillDetail(skillRef, { tenantCode, accountId } = {}) {
  const searchContent = String(skillRef || '').trim();
  if (!searchContent) {
    throw createHttpError('Skill name is required', 400);
  }
  const normalizedRef = searchContent.toLowerCase();
  const sanitizedRef = safeNormalizeSkillFolderName(searchContent);
  const skills = await fetchRemoteSkillList({ searchContent, tenantCode, accountId });
  const remoteSkill = findRemoteSkill(skills, normalizedRef, sanitizedRef);

  if (!remoteSkill) {
    throw createHttpError(`Skill "${skillRef}" was not found`, 404);
  }

  return remoteSkill;
}

async function listImportedSkillSummariesMissingFromRemotePage({
  workspacePath,
  imports,
  remoteSkills,
  currentUsername,
  tenantCode,
  accountId,
  searchContent,
}) {
  const summaries = [];

  for (const [skillName, metadataEntry] of Object.entries(imports.imports || {})) {
    const remoteMatch = remoteSkills.some((remoteSkill) => (
      remoteSkill.name === skillName
      || getImportEntryForRemoteSkill(remoteSkill, imports)?.skillName === skillName
    ));
    if (remoteMatch) continue;

    const status = await getImportStatus(workspacePath, skillName, imports);
    if (!status.imported) continue;

    const remoteSkill = await fetchRemoteSkillDetailOrNull(
      getRemoteSkillLookupRef(skillName, metadataEntry),
      { tenantCode, accountId },
    );
    if (remoteSkill) {
      if (matchesSkillSearch(remoteSkill, searchContent)) {
        summaries.push({
          ...remoteSkill,
          ...toLocalImportState(status, remoteSkill, currentUsername),
        });
      }
      continue;
    }

    const deletedSummary = toRemoteDeletedLocalImportState(skillName, status);
    if (matchesSkillSearch(deletedSummary, searchContent)) {
      summaries.push(deletedSummary);
    }
  }

  return summaries.sort((left, right) => sortPathNames(left.name, right.name));
}

async function fetchRemoteSkillDetailOrNull(skillRef, { tenantCode, accountId } = {}) {
  const normalizedRef = String(skillRef || '').trim().toLowerCase();
  if (!normalizedRef) return null;
  const sanitizedRef = safeNormalizeSkillFolderName(skillRef);
  const skills = await fetchRemoteSkillList({
    searchContent: String(skillRef || '').trim(),
    tenantCode,
    accountId,
  });
  return findRemoteSkill(skills, normalizedRef, sanitizedRef) || null;
}

async function isRemoteSkillDeleted(skillRef, { tenantCode, accountId } = {}) {
  return (await fetchRemoteSkillDetailOrNull(skillRef, { tenantCode, accountId })) === null;
}

function getRemoteSkillLookupRef(skillName, metadataEntry = {}) {
  return String(metadataEntry?.id || metadataEntry?.skillId || skillName || '').trim();
}

async function getImportStatusForRemoteSkill(workspacePath, remoteSkill, imports) {
  const importEntry = getImportEntryForRemoteSkill(remoteSkill, imports);
  return getImportStatus(workspacePath, importEntry?.skillName || remoteSkill.name, imports);
}

function getImportEntryForRemoteSkill(remoteSkill, imports) {
  const namedEntry = imports.imports?.[remoteSkill.name];
  if (namedEntry) {
    return {
      skillName: remoteSkill.name,
      metadataEntry: namedEntry,
    };
  }

  const remoteIds = new Set(
    [remoteSkill.id, remoteSkill.skillId]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean),
  );
  if (remoteIds.size === 0) return null;

  for (const [skillName, metadataEntry] of Object.entries(imports.imports || {})) {
    const metadataIds = [metadataEntry?.id, metadataEntry?.skillId]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);
    if (metadataIds.some((id) => remoteIds.has(id))) {
      return {
        skillName,
        metadataEntry,
      };
    }
  }

  return null;
}

function matchesSkillSearch(skill, searchContent = '') {
  const query = String(searchContent || '').trim().toLowerCase();
  if (!query) return true;
  return [
    skill.name,
    skill.displayName,
    skill.description,
    skill.createUserId,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(query);
}

function findRemoteSkill(skills, normalizedRef, sanitizedRef) {
  return skills.find((skill) => {
    const normalizedSkillName = String(skill.name || '').trim().toLowerCase();
    const sanitizedSkillName = safeNormalizeSkillFolderName(skill.name);
    return (
      normalizedSkillName === normalizedRef
      || sanitizedSkillName === sanitizedRef
      || String(skill.id).toLowerCase() === normalizedRef
      || String(skill.skillId).toLowerCase() === normalizedRef
      || String(skill.displayName).trim().toLowerCase() === normalizedRef
    );
  });
}

async function previewRemoteSkill(remoteSkill, filePath, { tenantCode, accountId } = {}) {
  const data = {
    id: remoteSkill.id,
    nspPath: remoteSkill.nspPath,
    queryVersion: remoteSkill.version,
  };
  if (filePath) {
    data.filePath = normalizeRelativeFilePath(filePath);
  }

  const payload = await requestMarketJson('/api/skill/preview', {
    method: 'POST',
    tenantCode,
    accountId,
    body: { data },
  });
  return normalizePreviewPayload(payload.data);
}

async function previewRemoteSkillFile(remoteSkill, filePath, { tenantCode, accountId } = {}) {
  const normalizedFilePath = normalizeRelativeFilePath(filePath);
  const preview = await previewRemoteSkill(remoteSkill, normalizedFilePath, { tenantCode, accountId });
  const content = typeof preview.fileContent === 'string' ? preview.fileContent : '';
  return {
    path: normalizedFilePath,
    content,
    size: Buffer.byteLength(content, 'utf8'),
  };
}

async function readRemoteSkillFiles(remoteSkill, { tenantCode, accountId, skillRootName } = {}) {
  const preview = await previewRemoteSkill(remoteSkill, undefined, { tenantCode, accountId });
  const fileEntries = flattenDirectoryTree(preview.directoryTree);
  const archiveRoot = inferSkillArchiveRoot(fileEntries, remoteSkill, skillRootName);
  const files = await Promise.all(
    fileEntries.map(async (file) => {
      const remoteFile = await previewRemoteSkillFile(remoteSkill, file.path, { tenantCode, accountId });
      return {
        ...remoteFile,
        path: stripSkillArchiveRoot(remoteFile.path, archiveRoot),
      };
    }),
  );
  return files.sort(sortFileEntries);
}

async function downloadRemoteSkillFiles(remoteSkill, { tenantCode, accountId } = {}) {
  const { response, payload } = await requestMarketMaybeJson('/api/skill/download', {
    method: 'POST',
    tenantCode,
    accountId,
    body: {
      data: {
        id: remoteSkill.id,
        nspPath: remoteSkill.nspPath,
      },
    },
  });

  if (payload) {
    const downloadedSkill = normalizeDownloadedSkillPackage(payload.data?.files ?? payload.data?.skill?.files ?? payload.data, {
      remoteSkill,
    });
    if (Object.keys(downloadedSkill.files).length > 0) {
      return downloadedSkill;
    }
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('zip') || contentType.includes('octet-stream')) {
    const zipBuffer = Buffer.from(await response.arrayBuffer());
    const downloadedSkill = await readZipFiles(zipBuffer, { remoteSkill });
    if (Object.keys(downloadedSkill.files).length > 0) {
      return downloadedSkill;
    }
  }

  return {
    files: Object.fromEntries(
      (await readRemoteSkillFiles(remoteSkill, { tenantCode, accountId })).map((file) => [file.path, file.content]),
    ),
  };
}

async function requestMarketJson(endpoint, { method = 'GET', body, tenantCode, accountId } = {}) {
  const { response, payload, logContext } = await requestMarketMaybeJson(endpoint, { method, body, tenantCode, accountId });
  if (!payload) {
    const contentType = response.headers.get('content-type') || '';
    const responseText = await response.text();
    logMarketEvent('warn', 'non_json_response', {
      ...logContext,
      status: response.status,
      contentType,
      responseSnippet: formatResponseSnippet(responseText),
    });
    throw createHttpError(
      `Skill market API returned a non-JSON response (${response.status} ${contentType || 'unknown content-type'})`,
      502,
    );
  }
  return payload;
}

async function requestMarketForm(endpoint, formData, {
  method = 'POST',
  authBody,
  tenantCode,
  accountId,
} = {}) {
  const baseUrl = getMarketApiUrl();
  const marketEndpoint = toMarketEndpoint(endpoint);
  const url = `${baseUrl}${marketEndpoint}`;
  const requestMethod = String(method || 'POST').toUpperCase();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MARKET_REQUEST_TIMEOUT_MS);
  const authHeaders = createMarketAuthHeaders({
    endpoint: marketEndpoint,
    method: requestMethod,
    payloadText: authBody === undefined ? '' : JSON.stringify(authBody),
  });
  const headers = {
    ...createMarketTenantHeaders(tenantCode),
    ...createMarketAccountHeaders(accountId),
    ...authHeaders,
  };
  const logContext = createMarketLogContext({
    baseUrl,
    endpoint: marketEndpoint,
    method: requestMethod,
    url,
    tenantCode,
    accountId,
    authEnabled: Boolean(authHeaders.Authorization),
    multipart: true,
  });
  logMarketEvent('debug', 'request_start', logContext);
  const startTime = Date.now();

  try {
    const response = await fetch(url, {
      method: requestMethod,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: formData,
      signal: controller.signal,
    });
    const text = await response.text();
    const contentType = response.headers.get('content-type') || '';
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (error) {
      logMarketEvent('warn', 'non_json_response', {
        ...logContext,
        status: response.status,
        contentType,
        elapsedMs: Date.now() - startTime,
        responseSnippet: formatResponseSnippet(text),
      });
      throw createHttpError(
        `Skill market API returned a non-JSON response (${response.status} ${contentType || 'unknown content-type'})`,
        502,
      );
    }
    logMarketEvent('debug', 'request_complete', {
      ...logContext,
      status: response.status,
      contentType,
      elapsedMs: Date.now() - startTime,
      responseCode: payload?.code,
      responseMessage: payload?.message,
    });
    assertMarketResponseOk(response, payload, logContext);
    return payload;
  } catch (error) {
    throw normalizeMarketRequestError(error, baseUrl, logContext);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestMarketMaybeJson(endpoint, { method = 'GET', body, tenantCode, accountId } = {}) {
  const baseUrl = getMarketApiUrl();
  const marketEndpoint = toMarketEndpoint(endpoint);
  const url = `${baseUrl}${marketEndpoint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MARKET_REQUEST_TIMEOUT_MS);
  const payloadText = body === undefined ? '' : JSON.stringify(body);
  const headers = {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...createMarketTenantHeaders(tenantCode),
    ...createMarketAccountHeaders(accountId),
    ...createMarketAuthHeaders({
      endpoint: marketEndpoint,
      method,
      payloadText,
    }),
  };
  const logContext = createMarketLogContext({
    baseUrl,
    endpoint: marketEndpoint,
    method,
    url,
    tenantCode,
    accountId,
    authEnabled: Boolean(headers.Authorization),
    payloadBytes: Buffer.byteLength(payloadText, 'utf8'),
  });
  logMarketEvent('debug', 'request_start', logContext);
  const startTime = Date.now();

  try {
    const response = await fetch(url, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body === undefined ? undefined : payloadText,
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') || '';
    let payload = null;
    if (contentType.includes('application/json')) {
      const text = await response.text();
      try {
        payload = text ? JSON.parse(text) : {};
      } catch (error) {
        logMarketEvent('warn', 'invalid_json_response', {
          ...logContext,
          status: response.status,
          contentType,
          elapsedMs: Date.now() - startTime,
          responseSnippet: formatResponseSnippet(text),
        });
        throw createHttpError('Skill market API returned invalid JSON', 502);
      }
      logMarketEvent('debug', 'request_complete', {
        ...logContext,
        status: response.status,
        contentType,
        elapsedMs: Date.now() - startTime,
        responseCode: payload?.code,
        responseMessage: payload?.message,
      });
      assertMarketResponseOk(response, payload, logContext);
    } else if (!response.ok) {
      const text = await response.text();
      logMarketEvent('warn', 'http_error_non_json_response', {
        ...logContext,
        status: response.status,
        contentType,
        elapsedMs: Date.now() - startTime,
        responseSnippet: formatResponseSnippet(text),
      });
      throw createHttpError(`Skill market API returned ${response.status}`, response.status);
    } else {
      logMarketEvent('debug', 'request_complete', {
        ...logContext,
        status: response.status,
        contentType,
        elapsedMs: Date.now() - startTime,
        responseType: 'non-json',
      });
    }
    return { response, payload, logContext };
  } catch (error) {
    throw normalizeMarketRequestError(error, baseUrl, logContext);
  } finally {
    clearTimeout(timeout);
  }
}

function assertMarketResponseOk(response, payload, logContext = {}) {
  if (!response.ok) {
    logMarketEvent('warn', 'http_error_response', {
      ...logContext,
      status: response.status,
      responseCode: payload?.code,
      responseMessage: payload?.message || payload?.error,
    });
    throw createHttpError(payload?.message || payload?.error || `Skill market API returned ${response.status}`, response.status);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'code') && Number(payload.code) !== 0) {
    logMarketEvent('warn', 'api_error_response', {
      ...logContext,
      status: response.status,
      responseCode: payload?.code,
      responseMessage: payload?.message,
    });
    throw createHttpError(payload?.message || 'Skill market API returned an error', 502);
  }
}

function normalizeMarketRequestError(error, baseUrl, logContext = {}) {
  if (error?.statusCode) return error;
  logMarketEvent('error', 'request_failed', {
    ...logContext,
    errorName: error?.name,
    errorMessage: error?.message || String(error),
  });
  const message = error?.name === 'AbortError'
    ? `Skill market API timed out at ${baseUrl}`
    : `Skill market API is unavailable at ${baseUrl}: ${error?.message || error}`;
  return createHttpError(message, 502);
}

function createMarketLogContext({
  baseUrl,
  endpoint,
  method,
  url,
  tenantCode,
  accountId,
  authEnabled,
  payloadBytes,
  multipart,
}) {
  marketRequestSequence += 1;
  return pruneUndefined({
    requestId: `skill-market-${process.pid}-${marketRequestSequence}`,
    method: String(method || 'GET').toUpperCase(),
    endpoint,
    url: sanitizeLogUrl(url),
    baseUrl: sanitizeLogUrl(baseUrl),
    tenant: tenantCode ? 'present' : 'missing',
    accountId: maskIdentifier(accountId),
    auth: authEnabled ? 'enabled' : 'disabled',
    payloadBytes,
    multipart: multipart === true ? true : undefined,
  });
}

function logMarketEvent(level, event, details = {}) {
  if (!shouldLogMarketLevel(level)) return;
  const logger = level === 'debug'
    ? console.debug
    : level === 'info'
      ? console.info
      : level === 'warn'
        ? console.warn
        : console.error;
  logger('[skill-market]', event, pruneUndefined(details));
}

function shouldLogMarketLevel(level) {
  const configuredLevel = String(process.env.SKILL_MARKET_LOG_LEVEL || 'warn').trim().toLowerCase();
  const threshold = MARKET_LOG_LEVELS[configuredLevel] ?? MARKET_LOG_LEVELS.warn;
  return (MARKET_LOG_LEVELS[level] ?? MARKET_LOG_LEVELS.error) <= threshold;
}

function sanitizeLogUrl(value) {
  try {
    const parsedUrl = value instanceof URL ? new URL(value) : new URL(String(value));
    parsedUrl.username = '';
    parsedUrl.password = '';
    return parsedUrl.toString();
  } catch {
    return String(value || '');
  }
}

function maskIdentifier(value) {
  const text = String(value || '').trim();
  if (!text) return 'missing';
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function formatResponseSnippet(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MARKET_RESPONSE_LOG_SNIPPET_CHARS);
}

async function readMarketImports({ workspaceId, workspacePath } = {}) {
  if (workspaceId) {
    const importsDb = await getSkillMarketImportsDb();
    const dbMetadata = importsRowsToMetadata(importsDb.listForWorkspace({ workspaceId }));
    const legacyMetadata = workspacePath
      ? await readLegacyMarketImports(workspacePath)
      : { version: 1, imports: {} };
    const legacyImports = legacyMetadata.imports || {};

    if (Object.keys(legacyImports).length > 0) {
      const mergedMetadata = normalizeImports({
        version: 1,
        imports: {
          ...legacyImports,
          ...dbMetadata.imports,
        },
      });
      importsDb.replaceForWorkspace({ workspaceId, imports: mergedMetadata.imports });
      await removeLegacyMarketImportsFile(workspacePath);
      return mergedMetadata;
    }

    return dbMetadata;
  }

  return workspacePath
    ? readLegacyMarketImports(workspacePath)
    : { version: 1, imports: {} };
}

async function writeMarketImports({ workspaceId, workspacePath } = {}, metadata) {
  const normalizedMetadata = normalizeImports(metadata);
  if (workspaceId) {
    const importsDb = await getSkillMarketImportsDb();
    importsDb.replaceForWorkspace({ workspaceId, imports: normalizedMetadata.imports });
    if (workspacePath) {
      await removeLegacyMarketImportsFile(workspacePath);
    }
    return;
  }

  if (!workspacePath) return;
  const { importsPath } = getSkillMarketPaths(workspacePath);
  await writeJsonAtomic(importsPath, normalizedMetadata);
}

async function getSkillMarketImportsDb() {
  const { multitenancyDb } = await import('../database/multitenancy-db.js');
  return multitenancyDb.skillMarketImports;
}

function importsRowsToMetadata(rows) {
  return normalizeImports({
    version: 1,
    imports: Object.fromEntries((rows || []).map((entry) => [entry.name, entry])),
  });
}

async function readLegacyMarketImports(workspacePath) {
  const { importsPath } = getSkillMarketPaths(workspacePath);
  return readJsonOrDefault(importsPath, { version: 1, imports: {} }, normalizeImports);
}

async function removeLegacyMarketImportsFile(workspacePath) {
  const { importsPath } = getSkillMarketPaths(workspacePath);
  await fs.rm(importsPath, { force: true });
  await removeEmptyDirectory(path.dirname(importsPath));
  await removeEmptyDirectory(path.dirname(path.dirname(importsPath)));
}

async function removeEmptyDirectory(directory) {
  try {
    await fs.rmdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') return;
    throw error;
  }
}

async function readJsonOrDefault(filePath, defaultValue, normalize) {
  try {
    return normalize(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultValue;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

async function getImportStatus(workspacePath, name, metadata) {
  const runtimePath = getRuntimeSkillPath(workspacePath, name);
  const runtimeExists = await pathExists(runtimePath);
  const metadataEntry = metadata.imports?.[name] || null;
  return {
    skillName: name,
    imported: Boolean(metadataEntry && runtimeExists),
    runtimeExists,
    conflict: Boolean(runtimeExists && !metadataEntry),
    importedAt: metadataEntry?.importedAt,
    updatedAt: metadataEntry?.updatedAt,
    metadataEntry,
  };
}

async function writeDownloadedFiles(skillDirectory, files) {
  await fs.mkdir(skillDirectory, { recursive: true });
  for (const [filePath, content] of Object.entries(files)) {
    const targetPath = resolveSkillFilePath(skillDirectory, filePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, 'utf8');
  }
}

async function readSkillDirectoryFiles(skillDirectory) {
  const files = [];
  await collectSkillDirectoryFiles(skillDirectory, skillDirectory, files);

  if (files.length === 0) {
    throw createHttpError('Imported skill directory is empty', 400);
  }

  return files.sort(sortFileEntries);
}

async function readLocalSkillFile(skillDirectory, filePath) {
  const normalizedFilePath = normalizeRelativeFilePath(filePath);
  const targetPath = resolveSkillFilePath(skillDirectory, normalizedFilePath);
  let content;

  try {
    content = await fs.readFile(targetPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw createHttpError('Skill file was not found', 404);
    }
    throw error;
  }

  return {
    path: normalizedFilePath,
    content,
    size: Buffer.byteLength(content, 'utf8'),
  };
}

async function collectSkillDirectoryFiles(rootDirectory, currentDirectory, files) {
  const entries = await fs.readdir(currentDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);
    if (entry.isDirectory()) {
      await collectSkillDirectoryFiles(rootDirectory, absolutePath, files);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const relativePath = normalizeRelativeFilePath(
      path.relative(rootDirectory, absolutePath).split(path.sep).join('/'),
    );
    const content = await fs.readFile(absolutePath, 'utf8');
    files.push({
      path: relativePath,
      content,
      size: Buffer.byteLength(content, 'utf8'),
    });
  }
}

async function buildSkillUpdateForm(remoteSkill, files, skillName = remoteSkill.name) {
  const formData = await buildSkillArchiveForm(skillName, files);
  formData.append('id', String(remoteSkill.id));
  return formData;
}

async function buildSkillSaveForm(skillName, files) {
  return buildSkillArchiveForm(skillName, files);
}

async function buildSkillArchiveForm(skillName, files) {
  const archiveRoot = normalizeRuntimeSkillFolderName(skillName);
  const zip = new JSZip();
  files.forEach((file) => {
    zip.file(`${archiveRoot}/${file.path}`, file.content);
  });
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const formData = new FormData();
  formData.append('file', new Blob([zipBuffer], { type: 'application/zip' }), `${archiveRoot}.zip`);
  return formData;
}

async function readZipFiles(buffer, { remoteSkill, skillRootName } = {}) {
  const zip = await JSZip.loadAsync(buffer);
  const fileEntries = [];
  await Promise.all(
    Object.values(zip.files).map(async (entry) => {
      if (entry.dir) return;
      const normalizedPath = normalizeRelativeFilePath(entry.name);
      fileEntries.push({
        path: normalizedPath,
        content: await entry.async('string'),
      });
    }),
  );
  return normalizeDownloadedSkillEntries(fileEntries, remoteSkill, skillRootName);
}

function normalizeSkillListPayload(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];

  for (const key of ['list', 'records', 'items', 'rows', 'skills']) {
    if (Array.isArray(data[key])) return data[key];
  }

  if (data.id !== undefined || data.skillName !== undefined || data.name !== undefined) {
    return [data];
  }

  return [];
}

function normalizeRemoteSkillSummary(skill) {
  if (!skill || typeof skill !== 'object') {
    throw createHttpError('Skill market API returned an invalid skill payload', 502);
  }

  const id = String(skill.id ?? skill.skillId ?? skill.skillName ?? skill.name ?? '').trim();
  const displayName = String(skill.skillName ?? skill.displayName ?? skill.name ?? id).trim();
  const name = displayName || id;
  if (!name) {
    throw createHttpError('Skill name is required', 400);
  }
  const version = normalizeVersion(skill.version) ?? 0;

  return pruneUndefined({
    id,
    skillId: id || name,
    name,
    displayName: displayName || name,
    description: typeof skill.description === 'string' ? skill.description : '',
    nspPath: typeof skill.nspPath === 'string' ? skill.nspPath : '',
    modifyTimestamp: skill.modifyTimestamp ?? skill.mpdifyTimestamp,
    createUserId: skill.createUserId === undefined || skill.createUserId === null
      ? undefined
      : String(skill.createUserId),
    version,
    published: parseBoolean(skill.published),
    fileCount: Number.isInteger(skill.fileCount) ? skill.fileCount : undefined,
    sourceType: 'skill-market-api',
  });
}

function normalizeSavedSkillPayload(payload, { id, name, currentUsername }) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const skill = data.skill && typeof data.skill === 'object' ? data.skill : data;
  const displayName = String(skill.skillName ?? skill.displayName ?? skill.name ?? name).trim();

  return pruneUndefined({
    id,
    skillId: id,
    name,
    displayName: displayName || name,
    description: typeof skill.description === 'string' ? skill.description : '',
    nspPath: typeof skill.nspPath === 'string' ? skill.nspPath : '',
    createUserId: skill.createUserId === undefined || skill.createUserId === null
      ? currentUsername
      : String(skill.createUserId),
    version: normalizeVersion(skill.version),
    published: parseBoolean(skill.published),
    sourceType: 'skill-market-api',
  });
}

function extractSavedSkillId(payload) {
  const data = payload?.data;
  const skill = data && typeof data === 'object'
    ? (data.skill && typeof data.skill === 'object' ? data.skill : data)
    : {};
  const id = typeof data === 'string' || typeof data === 'number'
    ? data
    : skill.id ?? skill.skillId ?? payload?.id ?? payload?.skillId;
  const normalizedId = String(id ?? '').trim();
  if (!normalizedId) {
    throw createHttpError('Skill market save response did not include a skill id', 502);
  }
  return normalizedId;
}

function normalizePreviewPayload(data) {
  const payload = data && typeof data === 'object' ? data : {};
  return {
    directoryTree: normalizeDirectoryTree(payload.directoryTree),
    fileContent: typeof payload.fileContent === 'string' ? payload.fileContent : undefined,
  };
}

function normalizeDirectoryTree(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.map((node) => {
    const isDirectory = Boolean(node?.isDirectory);
    const name = String(node?.name || '').trim();
    const rawPath = typeof node?.path === 'string' ? node.path : '';
    const nodePath = rawPath
      ? normalizeRelativeFilePath(rawPath)
      : name;
    return pruneUndefined({
      name: name || path.posix.basename(nodePath),
      path: nodePath,
      isDirectory,
      children: isDirectory ? normalizeDirectoryTree(node.children) : undefined,
      size: Number.isInteger(node?.size) ? node.size : undefined,
    });
  });
}

function flattenDirectoryTree(nodes) {
  const files = [];
  const visit = (items) => {
    for (const item of items || []) {
      if (item.isDirectory) {
        visit(item.children);
        continue;
      }
      files.push(pruneUndefined({
        path: normalizeRelativeFilePath(item.path || item.name),
        size: Number.isInteger(item.size) ? item.size : undefined,
      }));
    }
  };
  visit(nodes);
  return files.sort(sortFileEntries);
}

function summarizeSkillFiles(files) {
  return files
    .map((file) => pruneUndefined({
      path: file.path,
      size: Number.isInteger(file.size) ? file.size : undefined,
    }))
    .sort(sortFileEntries);
}

function buildDirectoryTreeFromFiles(files) {
  const root = [];
  const sortedFiles = [...files].sort(sortFileEntries);

  for (const file of sortedFiles) {
    const parts = file.path.split('/').filter(Boolean);
    let children = root;
    let currentPath = '';

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isFile = index === parts.length - 1;

      if (isFile) {
        children.push(pruneUndefined({
          name: part,
          path: currentPath,
          isDirectory: false,
          size: Number.isInteger(file.size) ? file.size : undefined,
        }));
        return;
      }

      let directory = children.find((entry) => entry.isDirectory && entry.path === currentPath);
      if (!directory) {
        directory = {
          name: part,
          path: currentPath,
          isDirectory: true,
          children: [],
        };
        children.push(directory);
      }
      children = directory.children;
    });
  }

  sortDirectoryTree(root);
  return root;
}

function sortDirectoryTree(nodes) {
  nodes.sort(sortDirectoryTreeEntries);
  nodes.forEach((node) => {
    if (node.isDirectory) {
      sortDirectoryTree(node.children);
    }
  });
}

function sortDirectoryTreeEntries(left, right) {
  if (left.isDirectory !== right.isDirectory) {
    return left.isDirectory ? -1 : 1;
  }
  return sortPathNames(left.path, right.path);
}

function normalizeDownloadedSkillPackage(files, { remoteSkill, skillRootName } = {}) {
  let fileEntries = [];

  if (Array.isArray(files)) {
    fileEntries = files
      .filter((file) => file && typeof file === 'object')
      .map((file) => ({
        path: normalizeRelativeFilePath(file.path),
        content: typeof file.content === 'string' ? file.content : '',
      }));
    return normalizeDownloadedSkillEntries(fileEntries, remoteSkill, skillRootName);
  }

  if (isPlainObject(files)) {
    fileEntries = Object.entries(files).map(([filePath, content]) => ({
      path: normalizeRelativeFilePath(filePath),
      content: typeof content === 'string' ? content : '',
    }));
    return normalizeDownloadedSkillEntries(fileEntries, remoteSkill, skillRootName);
  }

  return { files: {} };
}

function normalizeDownloadedSkillEntries(files, remoteSkill, skillRootName) {
  const archiveRoot = inferDownloadedSkillArchiveRoot(files, remoteSkill, skillRootName);
  const normalizedFiles = files.map((file) => ({
    ...file,
    path: stripSkillArchiveRoot(file.path, archiveRoot),
  }));
  return pruneUndefined({
    files: filesToContentMap(normalizedFiles),
    skillName: archiveRoot ? normalizeRuntimeSkillFolderName(archiveRoot) : undefined,
  });
}

function normalizeSkillFilePaths(files, remoteSkill, skillRootName) {
  const archiveRoot = inferSkillArchiveRoot(files, remoteSkill, skillRootName);
  return files.map((file) => ({
    ...file,
    path: stripSkillArchiveRoot(file.path, archiveRoot),
  }));
}

function inferRuntimeSkillNameFromFileEntries(files) {
  const archiveRoot = inferDownloadedSkillArchiveRoot(files);
  return archiveRoot ? normalizeRuntimeSkillFolderName(archiveRoot) : null;
}

function inferDownloadedSkillArchiveRoot(files, remoteSkill, skillRootName) {
  const matchedArchiveRoot = inferSkillArchiveRoot(files, remoteSkill, skillRootName);
  if (matchedArchiveRoot) return matchedArchiveRoot;

  return inferCommonTopLevelDirectory(files);
}

function inferCommonTopLevelDirectory(files) {
  const normalizedFiles = (files || [])
    .map((file) => normalizeRelativeFilePath(file.path))
    .map((filePath) => filePath.split('/').filter(Boolean));
  if (normalizedFiles.length === 0) return null;
  if (normalizedFiles.some((parts) => parts.length < 2)) return null;

  const archiveRoot = normalizedFiles[0][0];
  if (!archiveRoot || normalizedFiles.some((parts) => parts[0] !== archiveRoot)) {
    return null;
  }
  return archiveRoot;
}

function inferSkillArchiveRoot(files, remoteSkill, skillRootName) {
  const normalizedFiles = (files || [])
    .map((file) => normalizeRelativeFilePath(file.path))
    .map((filePath) => filePath.split('/').filter(Boolean));
  if (normalizedFiles.length === 0) return null;
  if (normalizedFiles.some((parts) => parts.length < 2)) return null;

  const archiveRoot = normalizedFiles[0][0];
  if (!archiveRoot || normalizedFiles.some((parts) => parts[0] !== archiveRoot)) {
    return null;
  }

  const normalizedArchiveRoot = safeNormalizeSkillFolderName(archiveRoot);
  if (!normalizedArchiveRoot) return null;

  const candidates = new Set(
    [
      skillRootName,
      remoteSkill?.name,
      remoteSkill?.displayName,
      remoteSkill?.id,
      remoteSkill?.skillId,
    ]
      .map(safeNormalizeSkillFolderName)
      .filter(Boolean),
  );

  return candidates.has(normalizedArchiveRoot) ? archiveRoot : null;
}

function stripSkillArchiveRoot(filePath, archiveRoot) {
  const normalizedFilePath = normalizeRelativeFilePath(filePath);
  if (!archiveRoot) return normalizedFilePath;

  const parts = normalizedFilePath.split('/').filter(Boolean);
  const normalizedArchiveRoot = safeNormalizeSkillFolderName(archiveRoot);
  if (
    parts.length > 1
    && normalizedArchiveRoot
    && safeNormalizeSkillFolderName(parts[0]) === normalizedArchiveRoot
  ) {
    return parts.slice(1).join('/');
  }
  return normalizedFilePath;
}

function filesToContentMap(files) {
  return Object.fromEntries(
    files.map((file) => [
      file.path,
      typeof file.content === 'string' ? file.content : '',
    ]),
  );
}

function compareSkillFiles(remoteFiles, localFiles) {
  const remoteByPath = new Map(remoteFiles.map((file) => [file.path, file]));
  const localByPath = new Map(localFiles.map((file) => [file.path, file]));
  const allPaths = [...new Set([...remoteByPath.keys(), ...localByPath.keys()])].sort(sortPathNames);

  return allPaths.flatMap((filePath) => {
    const remoteFile = remoteByPath.get(filePath);
    const localFile = localByPath.get(filePath);
    if (!remoteFile && localFile) {
      return [{
        path: filePath,
        status: 'added',
        oldContent: '',
        newContent: localFile.content,
      }];
    }
    if (remoteFile && !localFile) {
      return [{
        path: filePath,
        status: 'deleted',
        oldContent: remoteFile.content,
        newContent: '',
      }];
    }
    if (remoteFile.content !== localFile.content) {
      return [{
        path: filePath,
        status: 'modified',
        oldContent: remoteFile.content,
        newContent: localFile.content,
      }];
    }
    return [];
  });
}

function toLocalImportState(status, remoteSkill, currentUsername) {
  const importedVersion = normalizeVersion(status.metadataEntry?.version);
  const updateAvailable = Boolean(status.imported && importedVersion !== undefined && remoteSkill.version > importedVersion);
  const canPublish = Boolean(
    status.imported
    && remoteSkill.createUserId
    && currentUsername
    && String(remoteSkill.createUserId) === String(currentUsername)
  );

  return pruneUndefined({
    imported: status.imported,
    runtimeExists: status.runtimeExists,
    conflict: status.conflict,
    importedAt: status.importedAt,
    updatedAt: status.updatedAt,
    importedVersion,
    updateAvailable,
    canPublish,
  });
}

async function getRemoteDeletedSkillDetail({ workspacePath, skillName, status }) {
  const localFiles = await readSkillDirectoryFiles(getRuntimeSkillPath(workspacePath, skillName));
  return {
    ...toRemoteDeletedLocalImportState(skillName, status),
    targetPath: path.join('.claude', 'skills', skillName).split(path.sep).join('/'),
    directoryTree: buildDirectoryTreeFromFiles(localFiles),
    files: summarizeSkillFiles(localFiles),
  };
}

function toRemoteDeletedLocalImportState(skillName, status) {
  const metadata = status.metadataEntry || {};
  const importedVersion = normalizeVersion(metadata.version);
  return pruneUndefined({
    id: metadata.id || metadata.skillId || skillName,
    skillId: metadata.skillId || metadata.id || skillName,
    name: metadata.name || skillName,
    displayName: metadata.skillName || metadata.displayName || metadata.name || skillName,
    description: '',
    nspPath: metadata.nspPath || '',
    createUserId: metadata.createUserId,
    imported: status.imported,
    runtimeExists: status.runtimeExists,
    conflict: false,
    remoteDeleted: true,
    importedAt: status.importedAt,
    updatedAt: status.updatedAt,
    importedVersion,
    updateAvailable: false,
    canPublish: false,
    canUploadAndPublish: Boolean(status.runtimeExists),
    sourceType: 'skill-market-api',
  });
}

function ensurePublishAllowed(remoteSkill, status, currentUsername) {
  if (!status.imported) {
    throw createHttpError(`Market skill "${remoteSkill.name}" has not been imported`, status.runtimeExists ? 409 : 404);
  }
  if (!remoteSkill.createUserId || String(remoteSkill.createUserId) !== String(currentUsername || '')) {
    throw createHttpError('Only the skill creator can publish updates', 403);
  }
  const importedVersion = normalizeVersion(status.metadataEntry?.version);
  if (importedVersion !== undefined && remoteSkill.version > importedVersion) {
    throw createHttpError('Remote skill has updates. Update the local skill before publishing.', 409);
  }
}

function getRuntimeSkillPath(workspacePath, name) {
  const { runtimeRoot } = getSkillMarketPaths(workspacePath);
  return path.join(runtimeRoot, normalizeRuntimeSkillFolderName(name));
}

function resolveSkillFilePath(skillDirectory, filePath) {
  const normalized = normalizeRelativeFilePath(filePath);
  const targetPath = path.resolve(skillDirectory, normalized);
  if (!isPathInside(skillDirectory, targetPath)) {
    throw createHttpError('File path must stay inside the skill directory', 403);
  }
  return targetPath;
}

function normalizeRelativeFilePath(filePath) {
  const normalized = String(filePath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('/');
  if (!normalized || normalized.startsWith('../') || /^[a-zA-Z]:/.test(normalized) || path.isAbsolute(normalized)) {
    throw createHttpError('Skill file path is invalid', 400);
  }
  return normalized;
}

function normalizeSkillFolderName(value) {
  const normalized = safeNormalizeSkillFolderName(value);
  if (!normalized) {
    throw createHttpError('Skill name is required', 400);
  }
  return normalized;
}

function normalizeRuntimeSkillFolderName(value) {
  const normalized = safeNormalizeSkillFolderName(value, { preserveCase: true });
  if (!normalized) {
    throw createHttpError('Skill name is required', 400);
  }
  return normalized;
}

function safeNormalizeSkillFolderName(value, { preserveCase = false } = {}) {
  const raw = String(value || '')
    .trim();
  const normalized = (preserveCase ? raw : raw.toLowerCase())
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\s-]+/, '')
    .replace(/[.\s-]+$/, '')
    .slice(0, 80);
  if (normalized === '.' || normalized === '..') {
    return null;
  }
  return normalized || null;
}

function normalizeVersion(value) {
  const version = Number(value);
  return Number.isFinite(version) && version >= 0 ? version : undefined;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') return value.toLowerCase() === 'true' || value === '1';
  return false;
}

function normalizeImports(metadata) {
  return {
    version: 1,
    imports: isPlainObject(metadata?.imports) ? metadata.imports : {},
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

function getMarketApiUrl() {
  return (
    process.env.SKILL_MARKET_BASE_URL
    || process.env.SKILL_MARKET_API_URL
    || DEFAULT_MARKET_API_URL
  ).replace(/\/+$/, '/');
}

function toMarketEndpoint(endpoint) {
  const normalizedEndpoint = String(endpoint || '').startsWith('/')
    ? String(endpoint || '')
    : `/${endpoint || ''}`;
  if (normalizedEndpoint === MARKET_ENDPOINT_PREFIX || normalizedEndpoint.startsWith(`${MARKET_ENDPOINT_PREFIX}/`)) {
    return normalizedEndpoint;
  }
  return `${MARKET_ENDPOINT_PREFIX}${normalizedEndpoint}`;
}

function createMarketTenantHeaders(tenantCode) {
  const normalizedTenantCode = String(tenantCode || '').trim();
  return normalizedTenantCode ? { [DATA_AGENT_TENANT_HEADER]: normalizedTenantCode } : {};
}

function createMarketAccountHeaders(accountId) {
  const normalizedAccountId = String(accountId || '').trim();
  return normalizedAccountId ? { [ACCOUNT_ID_HEADER]: normalizedAccountId } : {};
}

function createMarketAuthHeaders({ endpoint, method, payloadText }) {
  const appid = String(process.env.SKILL_MARKET_AUTH_APPID || '').trim();
  const authKey = String(process.env.SKILL_MARKET_AUTH_KEY || '').trim();
  if (!appid && !authKey) {
    return {};
  }
  if (!appid || !authKey) {
    throw createHttpError('Skill market auth requires SKILL_MARKET_AUTH_APPID and SKILL_MARKET_AUTH_KEY', 500);
  }
  if (!/^[a-fA-F0-9]+$/.test(authKey) || authKey.length % 2 !== 0) {
    throw createHttpError('SKILL_MARKET_AUTH_KEY must be a hex string', 500);
  }

  const timestamp = String(Date.now());
  const endpointPath = new URL(endpoint, 'http://skill-market.local').pathname;
  const builder = `${String(method || 'GET').toUpperCase()}&${endpointPath}&&${payloadText || ''}&appid=${appid}&timestamp=${timestamp}`;
  const signature = crypto
    .createHmac('sha256', Buffer.from(authKey, 'hex'))
    .update(builder)
    .digest('base64');

  return {
    Authorization: `${MARKET_AUTH_SCHEME} appid=${appid}, timestamp=${timestamp}, signature="${signature}"`,
  };
}

function isPathInside(rootPath, targetPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pruneUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function sortFileEntries(left, right) {
  if (left.path.toLowerCase() === 'skill.md') return -1;
  if (right.path.toLowerCase() === 'skill.md') return 1;
  return sortPathNames(left.path, right.path);
}

function sortPathNames(left, right) {
  return left.localeCompare(right);
}

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isNotFoundError(error) {
  return Number(error?.statusCode || error?.status) === 404;
}
