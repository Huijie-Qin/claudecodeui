import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';

const DEFAULT_MARKET_API_URL = 'http://127.0.0.1:3101';
const MARKET_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_LIST_PAGE_SIZE = 200;
const MARKET_AUTH_SCHEME = 'CLOUDSOA-HMAC-SHA256';
const MARKET_ENDPOINT_PREFIX = '/data-agent';
const DATA_AGENT_TENANT_HEADER = 'X-Data-Agent-Tenant';
const ACCOUNT_ID_HEADER = 'X-Account-Id';

export function getSkillMarketPaths(workspacePath) {
  return {
    importsPath: path.join(workspacePath, '.cloudcli', 'skills', 'market-imports.json'),
    runtimeRoot: path.join(workspacePath, '.claude', 'skills'),
  };
}

export async function listSkillMarket(options = {}) {
  const normalizedOptions = typeof options === 'string' ? { workspacePath: options } : options;
  const {
    workspacePath,
    searchContent = '',
    page = 1,
    pageSize = DEFAULT_LIST_PAGE_SIZE,
    currentUsername,
    tenantCode,
    accountId,
  } = normalizedOptions;
  const remoteAccountId = accountId ?? currentUsername;
  const remoteSkills = await fetchRemoteSkillList({
    searchContent,
    page,
    pageSize,
    tenantCode,
    accountId: remoteAccountId,
  });

  if (!workspacePath) {
    return remoteSkills;
  }

  const imports = await readMarketImports(workspacePath);
  return Promise.all(
    remoteSkills.map(async (skill) => ({
      ...skill,
      ...toLocalImportState(await getImportStatus(workspacePath, skill.name, imports), skill, currentUsername),
    })),
  );
}

export async function getSkillMarketDetail({ workspacePath, name, currentUsername, tenantCode, accountId }) {
  const remoteAccountId = accountId ?? currentUsername;
  const remoteSkill = await fetchRemoteSkillDetail(name, { tenantCode, accountId: remoteAccountId });
  const preview = await previewRemoteSkill(remoteSkill, undefined, { tenantCode, accountId: remoteAccountId });
  const imports = await readMarketImports(workspacePath);
  const status = await getImportStatus(workspacePath, remoteSkill.name, imports);

  return {
    ...remoteSkill,
    ...toLocalImportState(status, remoteSkill, currentUsername),
    targetPath: path.join('.claude', 'skills', remoteSkill.name).split(path.sep).join('/'),
    directoryTree: preview.directoryTree,
    files: flattenDirectoryTree(preview.directoryTree),
  };
}

export async function viewMarketSkillFile({ name, filePath, tenantCode, accountId }) {
  const remoteSkill = await fetchRemoteSkillDetail(name, { tenantCode, accountId });
  const file = await previewRemoteSkillFile(remoteSkill, filePath, { tenantCode, accountId });

  return {
    skillId: remoteSkill.skillId,
    name: remoteSkill.name,
    file,
  };
}

export async function downloadMarketSkill({
  workspacePath,
  name,
  overwrite = false,
  now = () => new Date(),
  tenantCode,
  accountId,
}) {
  const remoteSkill = await fetchRemoteSkillDetail(name, { tenantCode, accountId });
  const skillName = remoteSkill.name;
  const imports = await readMarketImports(workspacePath);
  const runtimePath = getRuntimeSkillPath(workspacePath, skillName);
  const status = await getImportStatus(workspacePath, skillName, imports);

  if (status.imported && !overwrite) {
    throw createHttpError(`Skill "${skillName}" has already been imported`, 409);
  }
  if (status.runtimeExists && !status.imported) {
    throw createHttpError(`A .claude/skills/${skillName} directory already exists`, 409);
  }

  const files = await downloadRemoteSkillFiles(remoteSkill, { tenantCode, accountId });
  if (overwrite) {
    await fs.rm(runtimePath, { recursive: true, force: true });
  }
  await writeDownloadedFiles(runtimePath, files);

  const timestamp = now().toISOString();
  await writeMarketImports(workspacePath, {
    version: 1,
    imports: {
      ...imports.imports,
      [skillName]: {
        ...imports.imports[skillName],
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

  return getSkillMarketDetail({ workspacePath, name: skillName, tenantCode, accountId });
}

export async function getMarketSkillPublishPreview({ workspacePath, name, currentUsername, tenantCode, accountId }) {
  const remoteAccountId = accountId ?? currentUsername;
  const remoteSkill = await fetchRemoteSkillDetail(name, { tenantCode, accountId: remoteAccountId });
  const imports = await readMarketImports(workspacePath);
  const status = await getImportStatus(workspacePath, remoteSkill.name, imports);
  ensurePublishAllowed(remoteSkill, status, currentUsername);

  const runtimePath = getRuntimeSkillPath(workspacePath, remoteSkill.name);
  const localFiles = await readSkillDirectoryFiles(runtimePath);
  const remoteFiles = await readRemoteSkillFiles(remoteSkill, { tenantCode, accountId: remoteAccountId });
  const changes = compareSkillFiles(remoteFiles, localFiles);

  return {
    skill: {
      name: remoteSkill.name,
      displayName: remoteSkill.displayName,
      version: remoteSkill.version,
    },
    changes,
  };
}

export async function publishMarketSkill({
  workspacePath,
  name,
  currentUsername,
  now = () => new Date(),
  tenantCode,
  accountId,
}) {
  const remoteAccountId = accountId ?? currentUsername;
  const remoteSkill = await fetchRemoteSkillDetail(name, { tenantCode, accountId: remoteAccountId });
  const imports = await readMarketImports(workspacePath);
  const status = await getImportStatus(workspacePath, remoteSkill.name, imports);
  ensurePublishAllowed(remoteSkill, status, currentUsername);

  const runtimePath = getRuntimeSkillPath(workspacePath, remoteSkill.name);
  const files = await readSkillDirectoryFiles(runtimePath);
  const updateForm = await buildSkillUpdateForm(remoteSkill, files);
  await requestMarketForm('/api/skill/update', updateForm, {
    tenantCode,
    accountId: remoteAccountId,
    authBody: {
      data: {
        id: remoteSkill.id,
      },
    },
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
  await writeMarketImports(workspacePath, {
    version: 1,
    imports: {
      ...imports.imports,
      [remoteSkill.name]: {
        ...imports.imports[remoteSkill.name],
        name: remoteSkill.name,
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
      name: remoteSkill.name,
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

export async function removeMarketSkill({ workspacePath, name }) {
  const skillName = normalizeSkillFolderName(name);
  const imports = await readMarketImports(workspacePath);
  if (!imports.imports?.[skillName]) {
    throw createHttpError(`Market skill "${skillName}" has not been imported`, 404);
  }

  await fs.rm(getRuntimeSkillPath(workspacePath, skillName), { recursive: true, force: true });
  const nextImports = { ...imports.imports };
  delete nextImports[skillName];
  await writeMarketImports(workspacePath, {
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
  const payload = await requestMarketJson('/api/skill/skillList', {
    method: 'POST',
    tenantCode,
    accountId,
    body: {
      data: {
        searchContent,
      },
      pageInfo: {
        page: Number(page) || 1,
        pageSize: Number(pageSize) || DEFAULT_LIST_PAGE_SIZE,
      },
    },
  });

  return normalizeSkillListPayload(payload.data)
    .map(normalizeRemoteSkillSummary)
    .filter((skill) => skill.published === true);
}

async function fetchRemoteSkillDetail(skillRef, { tenantCode, accountId } = {}) {
  const normalizedRef = String(skillRef || '').trim().toLowerCase();
  const sanitizedRef = safeNormalizeSkillFolderName(skillRef);
  let skills = await fetchRemoteSkillList({ searchContent: '', tenantCode, accountId });
  let remoteSkill = findRemoteSkill(skills, normalizedRef, sanitizedRef);
  if (!remoteSkill && normalizedRef) {
    skills = await fetchRemoteSkillList({ searchContent: normalizedRef, tenantCode, accountId });
    remoteSkill = findRemoteSkill(skills, normalizedRef, sanitizedRef);
  }

  if (!remoteSkill) {
    throw createHttpError(`Skill "${skillRef}" was not found`, 404);
  }

  return remoteSkill;
}

function findRemoteSkill(skills, normalizedRef, sanitizedRef) {
  return skills.find((skill) => (
    skill.name === sanitizedRef
    || String(skill.id).toLowerCase() === normalizedRef
    || String(skill.skillId).toLowerCase() === normalizedRef
    || String(skill.displayName).trim().toLowerCase() === normalizedRef
  ));
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

async function readRemoteSkillFiles(remoteSkill, { tenantCode, accountId } = {}) {
  const preview = await previewRemoteSkill(remoteSkill, undefined, { tenantCode, accountId });
  const fileEntries = flattenDirectoryTree(preview.directoryTree);
  const files = await Promise.all(
    fileEntries.map((file) => previewRemoteSkillFile(remoteSkill, file.path, { tenantCode, accountId })),
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
    const files = normalizeDownloadedFiles(payload.data?.files ?? payload.data?.skill?.files ?? payload.data);
    if (Object.keys(files).length > 0) {
      return files;
    }
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('zip') || contentType.includes('octet-stream')) {
    const zipBuffer = Buffer.from(await response.arrayBuffer());
    const files = await readZipFiles(zipBuffer);
    if (Object.keys(files).length > 0) {
      return files;
    }
  }

  return Object.fromEntries(
    (await readRemoteSkillFiles(remoteSkill, { tenantCode, accountId })).map((file) => [file.path, file.content]),
  );
}

async function requestMarketJson(endpoint, { method = 'GET', body, tenantCode, accountId } = {}) {
  const { payload } = await requestMarketMaybeJson(endpoint, { method, body, tenantCode, accountId });
  if (!payload) {
    throw createHttpError('Skill market API returned a non-JSON response', 502);
  }
  return payload;
}

async function requestMarketForm(endpoint, formData, { authBody, tenantCode, accountId } = {}) {
  const baseUrl = getMarketApiUrl();
  const marketEndpoint = toMarketEndpoint(endpoint);
  const url = new URL(marketEndpoint, baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MARKET_REQUEST_TIMEOUT_MS);
  const authHeaders = createMarketAuthHeaders({
    endpoint: marketEndpoint,
    method: 'POST',
    payloadText: authBody === undefined ? '' : JSON.stringify(authBody),
  });
  const headers = {
    ...createMarketTenantHeaders(tenantCode),
    ...createMarketAccountHeaders(accountId),
    ...authHeaders,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: formData,
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    assertMarketResponseOk(response, payload);
    return payload;
  } catch (error) {
    throw normalizeMarketRequestError(error, baseUrl);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestMarketMaybeJson(endpoint, { method = 'GET', body, tenantCode, accountId } = {}) {
  const baseUrl = getMarketApiUrl();
  const marketEndpoint = toMarketEndpoint(endpoint);
  const url = new URL(marketEndpoint, baseUrl);
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
      payload = text ? JSON.parse(text) : {};
      assertMarketResponseOk(response, payload);
    } else if (!response.ok) {
      throw createHttpError(`Skill market API returned ${response.status}`, response.status);
    }
    return { response, payload };
  } catch (error) {
    throw normalizeMarketRequestError(error, baseUrl);
  } finally {
    clearTimeout(timeout);
  }
}

function assertMarketResponseOk(response, payload) {
  if (!response.ok) {
    throw createHttpError(payload?.message || payload?.error || `Skill market API returned ${response.status}`, response.status);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'code') && Number(payload.code) !== 0) {
    throw createHttpError(payload?.message || 'Skill market API returned an error', 502);
  }
}

function normalizeMarketRequestError(error, baseUrl) {
  if (error?.statusCode) return error;
  const message = error?.name === 'AbortError'
    ? `Skill market API timed out at ${baseUrl}`
    : `Skill market API is unavailable at ${baseUrl}: ${error?.message || error}`;
  return createHttpError(message, 502);
}

async function readMarketImports(workspacePath) {
  const { importsPath } = getSkillMarketPaths(workspacePath);
  return readJsonOrDefault(importsPath, { version: 1, imports: {} }, normalizeImports);
}

async function writeMarketImports(workspacePath, metadata) {
  const { importsPath } = getSkillMarketPaths(workspacePath);
  await writeJsonAtomic(importsPath, normalizeImports(metadata));
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
  if (!files.some((file) => file.path.toLowerCase() === 'skill.md')) {
    throw createHttpError('Imported skill must include SKILL.md', 400);
  }

  return files.sort(sortFileEntries);
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

async function buildSkillUpdateForm(remoteSkill, files) {
  const zip = new JSZip();
  files.forEach((file) => {
    zip.file(file.path, file.content);
  });
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const formData = new FormData();
  formData.append('data', JSON.stringify({ id: remoteSkill.id }));
  formData.append('id', String(remoteSkill.id));
  formData.append('files', JSON.stringify(files));
  formData.append('file', new Blob([zipBuffer], { type: 'application/zip' }), `${remoteSkill.name}.zip`);
  return formData;
}

async function readZipFiles(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const files = {};
  await Promise.all(
    Object.values(zip.files).map(async (entry) => {
      if (entry.dir) return;
      const normalizedPath = normalizeRelativeFilePath(entry.name);
      files[normalizedPath] = await entry.async('string');
    }),
  );
  return files;
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
  const name = normalizeSkillFolderName(displayName || id);
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

function normalizeDownloadedFiles(files) {
  if (Array.isArray(files)) {
    return Object.fromEntries(
      files
        .filter((file) => file && typeof file === 'object')
        .map((file) => [
          normalizeRelativeFilePath(file.path),
          typeof file.content === 'string' ? file.content : '',
        ]),
    );
  }

  if (isPlainObject(files)) {
    return Object.fromEntries(
      Object.entries(files).map(([filePath, content]) => [
        normalizeRelativeFilePath(filePath),
        typeof content === 'string' ? content : '',
      ]),
    );
  }

  return {};
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
  return path.join(runtimeRoot, normalizeSkillFolderName(name));
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
    throw createHttpError('Skill name must include at least one letter or number', 400);
  }
  return normalized;
}

function safeNormalizeSkillFolderName(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 80);
  return normalized || null;
}

function normalizeVersion(value) {
  const version = Number(value);
  return Number.isFinite(version) && version >= 0 ? version : undefined;
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
  const builder = `${String(method || 'GET').toUpperCase()}&${endpointPath}${payloadText || ''}&appid ${appid}&timestamp${timestamp}`;
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
