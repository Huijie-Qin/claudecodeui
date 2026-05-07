import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import matter from 'gray-matter';
import JSZip from 'jszip';

const EMPTY_METADATA = Object.freeze({
  version: 1,
  skills: {},
});

const KIND_ORDER = {
  managed: 0,
  unmanaged: 1,
  system: 2,
};

export function getWorkspaceSkillsPaths(workspacePath) {
  return {
    metadataPath: path.join(workspacePath, '.cloudcli', 'skills', 'metadata.json'),
    previewRoot: path.join(workspacePath, '.cloudcli', 'skills', 'previews'),
    sourceRoot: path.join(workspacePath, '.cloudcli', 'skills', 'sources'),
    runtimeRoot: path.join(workspacePath, '.claude', 'skills'),
  };
}

export async function readSkillsMetadata(workspacePath) {
  const { metadataPath } = getWorkspaceSkillsPaths(workspacePath);
  try {
    const raw = await fs.readFile(metadataPath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeMetadata(parsed);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ...EMPTY_METADATA, skills: {} };
    }
    throw error;
  }
}

export async function writeSkillsMetadata(workspacePath, metadata) {
  const { metadataPath } = getWorkspaceSkillsPaths(workspacePath);
  const normalized = normalizeMetadata(metadata);
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });

  const tempPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(`${tempPath}`, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, metadataPath);
}

export async function parseSkillManifest(skillDirectory) {
  const manifestPath = path.join(skillDirectory, 'SKILL.md');
  const fallbackName = path.basename(skillDirectory);

  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    matter.clearCache();
    const parsed = matter(raw);
    const content = parsed.content || '';
    const name = firstString(parsed.data?.name) || readFirstHeading(content) || fallbackName;
    const description = firstString(parsed.data?.description) || readFirstParagraph(content);

    return {
      name,
      description,
      manifestPath,
      status: 'valid',
    };
  } catch (error) {
    return {
      name: fallbackName,
      description: '',
      manifestPath,
      status: 'invalid',
      parseError: error?.message || 'Failed to parse SKILL.md',
    };
  }
}

export async function listManagedSkills(workspacePath) {
  const metadata = await readSkillsMetadata(workspacePath);
  const { sourceRoot, runtimeRoot } = getWorkspaceSkillsPaths(workspacePath);

  const skills = await Promise.all(
    Object.entries(metadata.skills).map(async ([key, entry]) => {
      const name = firstString(entry?.name) || key;
      const sourcePath = path.join(sourceRoot, name);
      const runtimePath = path.join(runtimeRoot, name);
      const manifest = await parseSkillManifest(sourcePath);
      const enabled = entry?.enabled !== false;
      const status = manifest.status === 'invalid' ? 'invalid' : enabled ? 'enabled' : 'disabled';

      return pruneUndefined({
        name,
        displayName: manifest.status === 'valid' ? manifest.name : name,
        description: manifest.description || firstString(entry?.description) || '',
        kind: 'managed',
        status,
        enabled,
        manageable: true,
        sourceType: firstString(entry?.sourceType) || 'github',
        sourceUrl: firstString(entry?.sourceUrl),
        resolvedCommit: firstString(entry?.resolvedCommit),
        sourceSubdir: firstString(entry?.sourceSubdir),
        sourceFileName: firstString(entry?.sourceFileName),
        installedAt: firstString(entry?.installedAt),
        updatedAt: firstString(entry?.updatedAt),
        managedBy: firstString(entry?.managedBy) || 'cloudcli',
        sourcePath,
        runtimePath,
        manifestPath: manifest.manifestPath,
        parseError: manifest.status === 'invalid' ? manifest.parseError : undefined,
      });
    }),
  );

  return sortSkills(skills);
}

export async function listUnmanagedRuntimeSkills(workspacePath) {
  const metadata = await readSkillsMetadata(workspacePath);
  const managedNames = new Set(Object.keys(metadata.skills));
  const { runtimeRoot } = getWorkspaceSkillsPaths(workspacePath);
  const directories = await listDirectories(runtimeRoot);

  const skills = await Promise.all(
    directories
      .filter((directory) => !managedNames.has(directory.name))
      .map(async (directory) => {
        const manifest = await parseSkillManifest(directory.path);
        const invalid = manifest.status === 'invalid';
        return pruneUndefined({
          name: directory.name,
          displayName: invalid ? directory.name : manifest.name,
          description: invalid ? '' : manifest.description,
          kind: 'unmanaged',
          status: invalid ? 'invalid' : 'available',
          enabled: true,
          manageable: false,
          sourceType: 'workspace-runtime',
          runtimePath: directory.path,
          manifestPath: manifest.manifestPath,
          parseError: invalid ? manifest.parseError : undefined,
        });
      }),
  );

  return sortSkills(skills);
}

export async function listWorkspaceSkills(workspacePath, availableSystemSkills = []) {
  const [managed, unmanaged] = await Promise.all([
    listManagedSkills(workspacePath),
    listUnmanagedRuntimeSkills(workspacePath),
  ]);
  const system = normalizeSystemSkills(availableSystemSkills);
  const skills = sortSkills([...managed, ...unmanaged, ...system]);

  return {
    skills,
    summary: summarizeSkills(skills),
  };
}

export async function previewGithubSkillInstall({
  url,
  workspacePath,
  resolveCommit = resolveGithubCommit,
  downloadArchive = downloadGithubArchive,
  now = () => new Date(),
  idFactory = randomUUID,
}) {
  const parsed = parseGithubSkillUrl(url);
  const resolvedCommit = await resolveCommit(parsed);
  const archiveBuffer = await downloadArchive({ ...parsed, resolvedCommit });
  const previewId = idFactory();
  const { previewRoot } = getWorkspaceSkillsPaths(workspacePath);
  const previewDirectory = path.join(previewRoot, previewId);
  const archiveDirectory = path.join(previewDirectory, 'archive');
  const selectedDirectory = path.join(previewDirectory, 'skill');

  try {
    await fs.mkdir(archiveDirectory, { recursive: true });
    await extractGithubArchive(archiveBuffer, archiveDirectory);

    const extractedRoot = await resolveSingleExtractedRoot(archiveDirectory);
    const skillDirectory = parsed.sourceSubdir
      ? path.join(extractedRoot, parsed.sourceSubdir)
      : await resolveOnlySkillDirectory(extractedRoot);
    await assertDirectoryExists(skillDirectory, 'Selected GitHub path does not contain a skill directory');

    const manifest = await parseSkillManifest(skillDirectory);
    if (manifest.status === 'invalid') {
      throw createHttpError(`Selected skill has an invalid SKILL.md: ${manifest.parseError}`, 400);
    }

    const skillName = sanitizeSkillName(manifest.name);
    await ensureValidSkillName(skillName);
    const conflict = await getSkillInstallConflict(workspacePath, skillName);
    const files = await listRelativeFiles(skillDirectory);
    await fs.cp(skillDirectory, selectedDirectory, { recursive: true });

    const sourceUrl = parsed.sourceSubdir
      ? `https://github.com/${parsed.owner}/${parsed.repo}/tree/${resolvedCommit}/${parsed.sourceSubdir}`
      : `https://github.com/${parsed.owner}/${parsed.repo}/tree/${resolvedCommit}`;
    const preview = pruneUndefined({
      previewId,
      name: skillName,
      displayName: manifest.name,
      description: manifest.description,
      files,
      sourceType: 'github',
      sourceUrl,
      requestedUrl: parsed.normalizedUrl,
      resolvedCommit,
      sourceSubdir: parsed.sourceSubdir,
      conflict,
      createdAt: now().toISOString(),
    });

    await writeJsonFile(path.join(previewDirectory, 'preview.json'), preview);
    return preview;
  } catch (error) {
    await fs.rm(previewDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function previewLocalSkillUpload({
  workspacePath,
  archiveBuffer,
  originalName,
  now = () => new Date(),
  idFactory = randomUUID,
}) {
  if (!Buffer.isBuffer(archiveBuffer) || archiveBuffer.length === 0) {
    throw createHttpError('Skill archive is required', 400);
  }

  const previewId = idFactory();
  const { previewRoot } = getWorkspaceSkillsPaths(workspacePath);
  const previewDirectory = path.join(previewRoot, previewId);
  const archiveDirectory = path.join(previewDirectory, 'archive');
  const selectedDirectory = path.join(previewDirectory, 'skill');

  try {
    await fs.mkdir(archiveDirectory, { recursive: true });
    await extractGithubArchive(archiveBuffer, archiveDirectory);

    const manifestPaths = await findSkillManifestPaths(archiveDirectory);
    if (manifestPaths.length !== 1) {
      throw createHttpError('Uploaded archive must contain exactly one skill directory with SKILL.md', 400);
    }

    const skillDirectory = path.dirname(manifestPaths[0]);
    const manifest = await parseSkillManifest(skillDirectory);
    if (manifest.status === 'invalid') {
      throw createHttpError(`Uploaded skill has an invalid SKILL.md: ${manifest.parseError}`, 400);
    }

    const skillName = sanitizeSkillName(manifest.name);
    await ensureValidSkillName(skillName);
    const conflict = await getSkillInstallConflict(workspacePath, skillName);
    const files = await listRelativeFiles(skillDirectory);
    await fs.cp(skillDirectory, selectedDirectory, { recursive: true });

    const preview = pruneUndefined({
      previewId,
      name: skillName,
      displayName: manifest.name,
      description: manifest.description,
      files,
      sourceType: 'local-upload',
      sourceFileName: firstString(originalName),
      conflict,
      createdAt: now().toISOString(),
    });

    await writeJsonFile(path.join(previewDirectory, 'preview.json'), preview);
    return preview;
  } catch (error) {
    await fs.rm(previewDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function installGithubSkill({ workspacePath, previewId, enable = true, now = () => new Date() }) {
  const { previewRoot, sourceRoot, runtimeRoot } = getWorkspaceSkillsPaths(workspacePath);
  const previewDirectory = path.join(previewRoot, previewId);
  const preview = await readJsonFile(path.join(previewDirectory, 'preview.json'));
  const name = sanitizeSkillName(preview?.name);
  await ensureValidSkillName(name);

  const conflict = await getSkillInstallConflict(workspacePath, name);
  if (conflict.type === 'unmanaged') {
    throw createHttpError(`Skill "${name}" already exists as an unmanaged runtime skill`, 409);
  }

  const oldMetadata = await readSkillsMetadata(workspacePath);
  const sourcePath = path.join(sourceRoot, name);
  const runtimePath = path.join(runtimeRoot, name);
  const backupToken = `${process.pid}.${Date.now()}`;
  const sourceBackupPath = path.join(sourceRoot, `.${name}.${backupToken}.backup`);
  const runtimeBackupPath = path.join(runtimeRoot, `.${name}.${backupToken}.backup`);
  const sourceStagePath = path.join(sourceRoot, `.${name}.${backupToken}.stage`);
  let sourceBackedUp = false;
  let runtimeBackedUp = false;

  try {
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.mkdir(runtimeRoot, { recursive: true });
    await fs.rm(sourceStagePath, { recursive: true, force: true });
    await fs.cp(path.join(previewDirectory, 'skill'), sourceStagePath, { recursive: true });

    if (await pathExists(sourcePath)) {
      await fs.rm(sourceBackupPath, { recursive: true, force: true });
      await fs.rename(sourcePath, sourceBackupPath);
      sourceBackedUp = true;
    }
    await fs.rename(sourceStagePath, sourcePath);

    const metadata = {
      version: 1,
      skills: {
        ...oldMetadata.skills,
        [name]: pruneUndefined({
          name,
          description: firstString(preview.description),
          enabled: enable !== false,
          sourceType: firstString(preview.sourceType) || 'github',
          sourceUrl: firstString(preview.sourceUrl) || undefined,
          resolvedCommit: firstString(preview.resolvedCommit) || undefined,
          sourceSubdir: firstString(preview.sourceSubdir) || undefined,
          sourceFileName: firstString(preview.sourceFileName) || undefined,
          installedAt: firstString(oldMetadata.skills?.[name]?.installedAt) || now().toISOString(),
          updatedAt: now().toISOString(),
          managedBy: 'cloudcli',
        }),
      },
    };
    await writeSkillsMetadata(workspacePath, metadata);

    if (await pathExists(runtimePath)) {
      await fs.rm(runtimeBackupPath, { recursive: true, force: true });
      await fs.rename(runtimePath, runtimeBackupPath);
      runtimeBackedUp = true;
    }
    if (enable !== false) {
      await fs.cp(sourcePath, runtimePath, { recursive: true });
    }

    await fs.rm(sourceBackupPath, { recursive: true, force: true });
    await fs.rm(runtimeBackupPath, { recursive: true, force: true });
    await fs.rm(previewDirectory, { recursive: true, force: true });

    const manifest = await parseSkillManifest(sourcePath);
    return pruneUndefined({
      name,
      displayName: manifest.status === 'valid' ? manifest.name : name,
      description: manifest.description || firstString(preview.description),
      kind: 'managed',
      status: manifest.status === 'invalid' ? 'invalid' : enable === false ? 'disabled' : 'enabled',
      enabled: enable !== false,
      manageable: true,
      sourceType: firstString(preview.sourceType) || 'github',
      sourceUrl: firstString(preview.sourceUrl) || undefined,
      resolvedCommit: firstString(preview.resolvedCommit) || undefined,
      sourceSubdir: firstString(preview.sourceSubdir) || undefined,
      sourceFileName: firstString(preview.sourceFileName) || undefined,
      managedBy: 'cloudcli',
      sourcePath,
      runtimePath,
      manifestPath: manifest.manifestPath,
      parseError: manifest.status === 'invalid' ? manifest.parseError : undefined,
    });
  } catch (error) {
    await fs.rm(sourceStagePath, { recursive: true, force: true });
    await fs.rm(sourcePath, { recursive: true, force: true });
    if (sourceBackedUp) {
      await fs.rename(sourceBackupPath, sourcePath).catch(() => {});
    }
    await fs.rm(runtimePath, { recursive: true, force: true });
    if (runtimeBackedUp) {
      await fs.rename(runtimeBackupPath, runtimePath).catch(() => {});
    }
    await writeSkillsMetadata(workspacePath, oldMetadata).catch(() => {});
    throw error;
  }
}

export async function setSkillEnabled({ workspacePath, name, enabled, now = () => new Date() }) {
  const skillName = sanitizeSkillName(name);
  const metadata = await readSkillsMetadata(workspacePath);
  const entry = metadata.skills?.[skillName];
  if (!entry) {
    throw createHttpError(`Managed skill "${skillName}" was not found`, 404);
  }

  const nextMetadata = {
    version: 1,
    skills: {
      ...metadata.skills,
      [skillName]: {
        ...entry,
        enabled: enabled !== false,
        updatedAt: now().toISOString(),
      },
    },
  };
  await writeSkillsMetadata(workspacePath, nextMetadata);

  const { sourceRoot, runtimeRoot } = getWorkspaceSkillsPaths(workspacePath);
  const sourcePath = path.join(sourceRoot, skillName);
  const runtimePath = path.join(runtimeRoot, skillName);
  if (enabled !== false) {
    await materializeManagedSkill(sourcePath, runtimePath);
  } else {
    await fs.rm(runtimePath, { recursive: true, force: true });
  }

  const manifest = await parseSkillManifest(sourcePath);
  return pruneUndefined({
    name: skillName,
    displayName: manifest.status === 'valid' ? manifest.name : skillName,
    description: manifest.description || firstString(entry.description),
    kind: 'managed',
    status: manifest.status === 'invalid' ? 'invalid' : enabled === false ? 'disabled' : 'enabled',
    enabled: enabled !== false,
    manageable: true,
    sourceType: firstString(entry.sourceType) || 'github',
    sourceUrl: firstString(entry.sourceUrl),
    resolvedCommit: firstString(entry.resolvedCommit),
    sourceSubdir: firstString(entry.sourceSubdir),
    sourceFileName: firstString(entry.sourceFileName),
    managedBy: firstString(entry.managedBy) || 'cloudcli',
    sourcePath,
    runtimePath,
    manifestPath: manifest.manifestPath,
    parseError: manifest.status === 'invalid' ? manifest.parseError : undefined,
  });
}

export async function uninstallManagedSkill({ workspacePath, name }) {
  const skillName = sanitizeSkillName(name);
  const metadata = await readSkillsMetadata(workspacePath);
  if (!metadata.skills?.[skillName]) {
    throw createHttpError(`Managed skill "${skillName}" was not found`, 404);
  }

  const { sourceRoot, runtimeRoot } = getWorkspaceSkillsPaths(workspacePath);
  const nextSkills = { ...metadata.skills };
  delete nextSkills[skillName];

  await fs.rm(path.join(sourceRoot, skillName), { recursive: true, force: true });
  await fs.rm(path.join(runtimeRoot, skillName), { recursive: true, force: true });
  await writeSkillsMetadata(workspacePath, {
    version: 1,
    skills: nextSkills,
  });
}

export async function reconcileManagedSkills(workspacePath) {
  const metadata = await readSkillsMetadata(workspacePath);
  const { sourceRoot, runtimeRoot } = getWorkspaceSkillsPaths(workspacePath);
  const result = {
    materialized: [],
    removed: [],
    failures: [],
  };

  for (const [key, entry] of Object.entries(metadata.skills)) {
    const name = sanitizeSkillName(entry?.name || key);
    const sourcePath = path.join(sourceRoot, name);
    const runtimePath = path.join(runtimeRoot, name);
    try {
      if (entry?.enabled === false) {
        await fs.rm(runtimePath, { recursive: true, force: true });
        result.removed.push(name);
      } else {
        await materializeManagedSkill(sourcePath, runtimePath);
        result.materialized.push(name);
      }
    } catch (error) {
      result.failures.push({
        name,
        error: error?.message || 'Failed to reconcile skill',
      });
    }
  }

  result.materialized.sort((left, right) => left.localeCompare(right));
  result.removed.sort((left, right) => left.localeCompare(right));
  result.failures.sort((left, right) => left.name.localeCompare(right.name));
  return result;
}

export async function reconcileWorkspaceSkillsForAgentTurn({
  workspacePath,
  reconcile = reconcileManagedSkills,
  logger = console,
}) {
  const resolvedWorkspacePath = firstString(workspacePath);
  if (!resolvedWorkspacePath) {
    return { materialized: [], removed: [], failures: [] };
  }

  const result = await reconcile(resolvedWorkspacePath);
  if (result.failures.length > 0) {
    for (const failure of result.failures) {
      logger?.error?.('Workspace skill reconcile failed before Claude turn', {
        workspacePath: resolvedWorkspacePath,
        skillName: failure.name,
        error: failure.error,
      });
    }
    const error = createHttpError('Workspace skills failed to reconcile before starting Claude', 500);
    error.code = 'WORKSPACE_SKILLS_RECONCILE_FAILED';
    error.failures = result.failures;
    throw error;
  }

  return result;
}

export function parseGithubSkillUrl(inputUrl) {
  const normalizedUrl = firstString(inputUrl);
  if (!normalizedUrl) {
    throw createHttpError('GitHub URL is required', 400);
  }

  let parsed;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    throw createHttpError('GitHub URL is invalid', 400);
  }

  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw createHttpError('Only https://github.com skill URLs are supported', 400);
  }
  if (parsed.username || parsed.password) {
    throw createHttpError('GitHub URLs must not include credentials', 400);
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  const owner = segments[0];
  const repo = segments[1]?.replace(/\.git$/i, '');
  if (!isValidGithubPathPart(owner) || !isValidGithubPathPart(repo)) {
    throw createHttpError('GitHub URL must include an owner and repository', 400);
  }

  if (segments.length === 2) {
    return { owner, repo, ref: 'HEAD', sourceSubdir: '', normalizedUrl };
  }

  if (segments[2] === 'tree' && segments[3]) {
    const ref = decodeURIComponent(segments[3]);
    const sourceSubdir = segments.slice(4).map(decodeURIComponent).join('/');
    return { owner, repo, ref, sourceSubdir, normalizedUrl };
  }

  if (segments[2] === 'archive') {
    const archiveRef = segments.slice(3).join('/').replace(/\.(zip|tar\.gz|tgz)$/i, '');
    if (!archiveRef) {
      throw createHttpError('GitHub archive URL must include a ref', 400);
    }
    return { owner, repo, ref: decodeURIComponent(archiveRef), sourceSubdir: '', normalizedUrl };
  }

  throw createHttpError('Only GitHub repository, tree, and archive URLs are supported', 400);
}

function normalizeMetadata(metadata) {
  return {
    version: 1,
    skills: isPlainObject(metadata?.skills) ? metadata.skills : {},
  };
}

async function resolveGithubCommit({ owner, repo, ref }) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref || 'HEAD')}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'CloudCLI-Skills-Market',
    },
  });
  if (!response.ok) {
    throw createHttpError(`Failed to resolve GitHub commit (${response.status})`, response.status === 404 ? 404 : 502);
  }
  const payload = await response.json();
  const sha = firstString(payload?.sha);
  if (!/^[a-f0-9]{40}$/i.test(sha)) {
    throw createHttpError('GitHub did not return a valid commit SHA', 502);
  }
  return sha;
}

async function downloadGithubArchive({ owner, repo, resolvedCommit }) {
  const response = await fetch(`https://codeload.github.com/${owner}/${repo}/zip/${resolvedCommit}`, {
    headers: {
      Accept: 'application/zip',
      'User-Agent': 'CloudCLI-Skills-Market',
    },
  });
  if (!response.ok) {
    throw createHttpError(`Failed to download GitHub archive (${response.status})`, response.status === 404 ? 404 : 502);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function extractGithubArchive(archiveBuffer, destinationDirectory) {
  const zip = await JSZip.loadAsync(archiveBuffer);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length === 0) {
    throw createHttpError('GitHub archive is empty', 400);
  }

  await Promise.all(entries.map(async (entry) => {
    const normalizedPath = normalizeArchivePath(entry.name);
    const destinationPath = path.join(destinationDirectory, normalizedPath);
    if (!isPathInside(destinationDirectory, destinationPath)) {
      throw createHttpError('GitHub archive contains an unsafe file path', 400);
    }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, await entry.async('nodebuffer'));
  }));
}

async function resolveSingleExtractedRoot(archiveDirectory) {
  const directories = await listDirectories(archiveDirectory);
  if (directories.length !== 1) {
    throw createHttpError('GitHub archive must contain exactly one repository root', 400);
  }
  return directories[0].path;
}

async function resolveOnlySkillDirectory(rootDirectory) {
  const manifestPaths = await findSkillManifestPaths(rootDirectory);
  if (manifestPaths.length !== 1) {
    throw createHttpError('GitHub URL must point to exactly one skill directory', 400);
  }
  return path.dirname(manifestPaths[0]);
}

async function findSkillManifestPaths(rootDirectory) {
  const manifestPaths = [];

  async function visit(currentDirectory) {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        manifestPaths.push(entryPath);
      }
    }
  }

  await visit(rootDirectory);
  return manifestPaths.sort((left, right) => left.localeCompare(right));
}

async function getSkillInstallConflict(workspacePath, name) {
  const metadata = await readSkillsMetadata(workspacePath);
  if (metadata.skills?.[name]) {
    return { type: 'managed', blocking: false };
  }

  const { runtimeRoot } = getWorkspaceSkillsPaths(workspacePath);
  if (await pathExists(path.join(runtimeRoot, name))) {
    return { type: 'unmanaged', blocking: true };
  }

  return { type: 'none', blocking: false };
}

async function materializeManagedSkill(sourcePath, runtimePath) {
  await assertDirectoryExists(sourcePath, `Managed skill source does not exist at ${sourcePath}`);
  const stagePath = path.join(path.dirname(runtimePath), `.${path.basename(runtimePath)}.${process.pid}.${Date.now()}.stage`);
  await fs.mkdir(path.dirname(runtimePath), { recursive: true });
  await fs.rm(stagePath, { recursive: true, force: true });
  await fs.cp(sourcePath, stagePath, { recursive: true });
  await fs.rm(runtimePath, { recursive: true, force: true });
  await fs.rename(stagePath, runtimePath);
}

async function listRelativeFiles(rootDirectory) {
  const files = [];

  async function visit(currentDirectory) {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        files.push(path.relative(rootDirectory, entryPath));
      }
    }
  }

  await visit(rootDirectory);
  return files.sort((left, right) => {
    if (left === 'SKILL.md') return -1;
    if (right === 'SKILL.md') return 1;
    return left.localeCompare(right);
  });
}

async function assertDirectoryExists(directoryPath, message) {
  try {
    const stat = await fs.stat(directoryPath);
    if (stat.isDirectory()) return;
  } catch {
    // Fall through to a consistent product error.
  }
  throw createHttpError(message, 400);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw createHttpError('Skill install preview was not found or has expired', 404);
    }
    throw error;
  }
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function ensureValidSkillName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name)) {
    throw createHttpError('Skill name must use letters, numbers, dots, underscores, or hyphens', 400);
  }
}

function sanitizeSkillName(name) {
  return firstString(name).toLowerCase();
}

function normalizeArchivePath(archivePath) {
  return archivePath.split('/').filter(Boolean).join('/');
}

function isPathInside(rootPath, targetPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isValidGithubPathPart(value) {
  return /^[A-Za-z0-9_.-]+$/.test(firstString(value));
}

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeSystemSkills(availableSystemSkills) {
  if (!Array.isArray(availableSystemSkills)) return [];

  return availableSystemSkills
    .filter((skill) => firstString(skill?.name))
    .map((skill) => pruneUndefined({
      name: firstString(skill.name),
      displayName: firstString(skill.displayName) || firstString(skill.name),
      description: firstString(skill.description) || '',
      kind: 'system',
      status: firstString(skill.status) || 'available',
      enabled: true,
      manageable: false,
      sourceType: firstString(skill.sourceType) || 'bundled',
      sourcePath: firstString(skill.sourcePath),
    }));
}

async function listDirectories(rootPath) {
  try {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(rootPath, entry.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function summarizeSkills(skills) {
  return {
    total: skills.length,
    managed: skills.filter((skill) => skill.kind === 'managed').length,
    unmanaged: skills.filter((skill) => skill.kind === 'unmanaged').length,
    system: skills.filter((skill) => skill.kind === 'system').length,
    enabled: skills.filter((skill) => skill.kind === 'managed' && skill.status === 'enabled').length,
    disabled: skills.filter((skill) => skill.kind === 'managed' && skill.status === 'disabled').length,
    invalid: skills.filter((skill) => skill.status === 'invalid').length,
  };
}

function sortSkills(skills) {
  return [...skills].sort((left, right) => {
    const kindDiff = (KIND_ORDER[left.kind] ?? 99) - (KIND_ORDER[right.kind] ?? 99);
    if (kindDiff !== 0) return kindDiff;
    return left.name.localeCompare(right.name);
  });
}

function firstString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readFirstHeading(content) {
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^#\s+(.+)$/);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return '';
}

function readFirstParagraph(content) {
  let inFence = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !trimmed || trimmed.startsWith('#')) continue;
    return trimmed;
  }
  return '';
}

function pruneUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
