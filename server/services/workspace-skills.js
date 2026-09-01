import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import matter from 'gray-matter';
import JSZip from 'jszip';

import { applyWorkspaceOwnership } from './workspace-ownership.js';

const EMPTY_METADATA = Object.freeze({
  version: 1,
  skills: {},
});

const KIND_ORDER = {
  managed: 0,
  unmanaged: 1,
  system: 2,
};

const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_ARCHIVE_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_ARCHIVE_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_SKILL_ARCHIVE_ENTRIES = 500;
const MAX_SKILL_ARCHIVE_DEPTH = 20;

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
  await applyWorkspaceOwnership({
    workspaceRoot: workspacePath,
    targetPaths: [metadataPath],
    reason: 'workspace_skills_metadata',
  });
}

export async function parseSkillManifest(skillDirectory) {
  const manifestPath = path.join(skillDirectory, 'SKILL.md');
  const fallbackName = path.basename(skillDirectory);
  const diagnostics = [];

  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    matter.clearCache();
    const parsed = matter(raw);
    const content = parsed.content || '';
    const manifestName = firstString(parsed.data?.name);
    const manifestDescription = firstString(parsed.data?.description);
    const name = manifestName || readFirstHeading(content) || fallbackName;
    const description = manifestDescription || readFirstParagraph(content);

    return pruneUndefined({
      name,
      description,
      manifestPath,
      status: diagnostics.length > 0 ? 'invalid' : 'valid',
      diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
      parseError: diagnostics.length > 0 ? diagnostics.map((entry) => entry.message).join('\n') : undefined,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      diagnostics.push(createSkillDiagnostic('ROOT_MANIFEST_MISSING', '技能根目录缺少 SKILL.md。', 'SKILL.md'));
      const nestedManifests = (await findSkillManifestPaths(skillDirectory))
        .map((entryPath) => path.relative(skillDirectory, entryPath).split(path.sep).join('/'))
        .filter((entryPath) => entryPath !== 'SKILL.md');
      for (const nestedPath of nestedManifests) {
        diagnostics.push(createSkillDiagnostic(
          'NESTED_MANIFEST_FOUND',
          `检测到 SKILL.md 位于子目录 ${nestedPath}，请将它移动到技能根目录。`,
          nestedPath,
        ));
        try {
          matter.clearCache();
          matter(await fs.readFile(path.join(skillDirectory, ...nestedPath.split('/')), 'utf8'));
        } catch (nestedError) {
          diagnostics.push(createSkillDiagnostic(
            'MANIFEST_PARSE_ERROR',
            `${nestedPath} 解析失败：${nestedError?.message || 'frontmatter 格式无效'}`,
            nestedPath,
          ));
        }
      }
      return {
        name: fallbackName,
        description: '',
        manifestPath,
        status: 'invalid',
        diagnostics,
        parseError: diagnostics.map((entry) => entry.message).join('\n'),
      };
    }
    diagnostics.push(createSkillDiagnostic(
      'MANIFEST_PARSE_ERROR',
      `SKILL.md 解析失败：${error?.message || 'frontmatter 格式无效'}`,
      'SKILL.md',
    ));
    return {
      name: fallbackName,
      description: '',
      manifestPath,
      status: 'invalid',
      diagnostics,
      parseError: diagnostics.map((entry) => entry.message).join('\n'),
    };
  }
}

function createSkillDiagnostic(code, message, entryPath) {
  return pruneUndefined({ code, message, path: entryPath });
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
        diagnostics: manifest.status === 'invalid' ? manifest.diagnostics : undefined,
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
          diagnostics: invalid ? manifest.diagnostics : undefined,
        });
      }),
  );

  return sortSkills(skills);
}

export async function listWorkspaceSkills(workspacePath, availableSystemSkills = [], marketImports = [], options = {}) {
  const runtimeSkills = await listRuntimeWorkspaceSkills(workspacePath);
  const system = normalizeSystemSkills(availableSystemSkills);
  const importsByName = createMarketImportsByName(marketImports);
  const skills = sortSkills(await Promise.all([...runtimeSkills, ...system].map(async (skill) => {
    const marketImport = importsByName.get(skill.name.toLowerCase());
    const origin = resolveSkillOrigin(skill, marketImport, options.currentUsername);
    const bindingType = resolveBindingType(origin, marketImport);
    const locallyModified = await isWorkspaceSkillLocallyModified(skill, marketImport);
    return pruneUndefined({
      ...skill,
      origin,
      bindingType,
      published: bindingType === 'published',
      imported: Boolean(marketImport),
      locallyModified,
      manageable: skill.kind !== 'system',
      targetPath: skill.kind === 'system' ? undefined : `.claude/skills/${skill.name}`,
      localVersion: marketImport ? normalizeNonNegativeInteger(marketImport.version) : undefined,
      createUserId: marketImport?.createUserId,
      marketSkillId: marketImport?.skillId || marketImport?.id,
    });
  })));

  return {
    skills,
    summary: {
      ...summarizeSkills(skills),
      market: skills.filter((skill) => skill.kind !== 'system' && skill.enabled !== false && skill.origin === 'market').length,
      local: skills.filter((skill) => skill.kind !== 'system' && skill.enabled !== false && skill.origin === 'local').length,
    },
  };
}

async function listRuntimeWorkspaceSkills(workspacePath) {
  const metadata = await readSkillsMetadata(workspacePath);
  const { runtimeRoot, sourceRoot } = getWorkspaceSkillsPaths(workspacePath);
  const directories = await listDirectories(runtimeRoot);

  return Promise.all(directories.map(async (directory) => {
    const managedKey = Object.keys(metadata.skills || {}).find((entryName) => (
      entryName.toLowerCase() === directory.name.toLowerCase()
    ));
    const managedEntry = managedKey ? metadata.skills[managedKey] : null;
    const manifest = await parseSkillManifest(directory.path);
    const invalid = manifest.status === 'invalid';
    return pruneUndefined({
      name: directory.name,
      displayName: invalid ? directory.name : manifest.name,
      description: invalid ? '' : manifest.description,
      kind: managedEntry ? 'managed' : 'unmanaged',
      status: invalid ? 'invalid' : managedEntry ? 'enabled' : 'available',
      enabled: true,
      manageable: true,
      sourceType: firstString(managedEntry?.sourceType) || 'workspace-runtime',
      sourceUrl: firstString(managedEntry?.sourceUrl),
      resolvedCommit: firstString(managedEntry?.resolvedCommit),
      sourceSubdir: firstString(managedEntry?.sourceSubdir),
      sourceFileName: firstString(managedEntry?.sourceFileName),
      installedAt: firstString(managedEntry?.installedAt),
      updatedAt: firstString(managedEntry?.updatedAt),
      managedBy: firstString(managedEntry?.managedBy),
      sourcePath: managedEntry ? path.join(sourceRoot, managedKey) : undefined,
      runtimePath: directory.path,
      manifestPath: manifest.manifestPath,
      parseError: invalid ? manifest.parseError : undefined,
      diagnostics: invalid ? manifest.diagnostics : undefined,
    });
  }));
}

export async function getWorkspaceSkillDetail({ workspacePath, name, marketImports = [], currentUsername }) {
  const context = await resolveWorkspaceSkillContext({ workspacePath, name, marketImports, currentUsername });
  const manifest = await parseSkillManifest(context.rootPath);
  const files = await listSkillEntries(context.rootPath);
  const marketImport = context.marketImport;
  const bindingType = resolveBindingType(context.origin, marketImport);

  return pruneUndefined({
    name: context.name,
    displayName: manifest.status === 'valid' ? manifest.name : context.name,
    description: manifest.status === 'valid' ? manifest.description : '',
    status: manifest.status === 'valid' ? 'available' : 'invalid',
    parseError: manifest.status === 'invalid' ? manifest.parseError : undefined,
    diagnostics: manifest.status === 'invalid' ? manifest.diagnostics : undefined,
    origin: context.origin,
    bindingType,
    published: bindingType === 'published',
    imported: Boolean(marketImport),
    locallyModified: await isSkillRootLocallyModified(context.rootPath, marketImport),
    manageable: true,
    targetPath: `.claude/skills/${context.name}`,
    localVersion: marketImport ? normalizeNonNegativeInteger(marketImport.version) : undefined,
    createUserId: marketImport?.createUserId,
    marketSkillId: marketImport?.skillId || marketImport?.id,
    files,
  });
}

export async function readWorkspaceSkillFile({ workspacePath, name, filePath, marketImports = [] }) {
  const context = await resolveWorkspaceSkillContext({ workspacePath, name, marketImports });
  const targetPath = await resolveSkillEntryPath(context.rootPath, filePath, { mustExist: true });
  const stat = await fs.stat(targetPath);
  if (!stat.isFile()) {
    throw createHttpError('Selected skill entry is not a file', 400);
  }
  if (stat.size > MAX_SKILL_FILE_BYTES) {
    throw createHttpError('Skill file is too large to preview', 413);
  }
  const buffer = await fs.readFile(targetPath);
  const binary = isBinaryBuffer(buffer);

  return pruneUndefined({
    path: normalizeSkillRelativePath(filePath),
    size: stat.size,
    isBinary: binary,
    mimeType: inferSkillFileMimeType(filePath),
    revision: createHash('sha256').update(buffer).digest('hex'),
    content: binary ? undefined : buffer.toString('utf8'),
    contentBase64: binary ? buffer.toString('base64') : undefined,
  });
}

export async function createWorkspaceSkill({ workspacePath, name, displayName, description, content = '' }) {
  const skillName = normalizeWorkspaceSkillName(name);
  const { runtimeRoot } = getWorkspaceSkillsPaths(workspacePath);
  const skillPath = path.join(runtimeRoot, skillName);
  if (await findWorkspaceSkillNameConflict(workspacePath, skillName)) {
    throw createHttpError(`Skill "${skillName}" already exists`, 409, 'SKILL_NAME_CONFLICT', { name: skillName });
  }

  const manifestContent = firstString(content) || [
    '---',
    `name: ${JSON.stringify(skillName)}`,
    `description: ${JSON.stringify(firstString(description) || 'Describe when this skill should be used.')}`,
    '---',
    '',
    `# ${firstString(displayName) || skillName}`,
    '',
  ].join('\n');
  validateSkillManifestContent(manifestContent, skillName);

  await fs.mkdir(runtimeRoot, { recursive: true });
  const stagePath = path.join(runtimeRoot, `.${skillName}.${process.pid}.${Date.now()}.stage`);
  try {
    await fs.mkdir(stagePath, { recursive: false });
    await fs.writeFile(path.join(stagePath, 'SKILL.md'), manifestContent, 'utf8');
    await fs.rename(stagePath, skillPath);
    await applyWorkspaceOwnership({
      workspaceRoot: workspacePath,
      targetPaths: [skillPath],
      recursive: true,
      reason: 'workspace_skill_create',
      context: { skillName },
    });
  } catch (error) {
    await fs.rm(stagePath, { recursive: true, force: true });
    throw error;
  }

  return getWorkspaceSkillDetail({ workspacePath, name: skillName });
}

export async function createWorkspaceSkillEntry({
  workspacePath,
  name,
  entryPath,
  entryType,
  content = '\n',
  marketImports = [],
}) {
  const context = await requireEditableWorkspaceSkill({ workspacePath, name, marketImports });
  const targetPath = await resolveSkillEntryPath(context.rootPath, entryPath, { mustExist: false });
  if (await pathExists(targetPath)) {
    throw createHttpError('A skill entry already exists at that path', 409);
  }
  if (entryType === 'directory') {
    await fs.mkdir(targetPath, { recursive: false });
  } else if (entryType === 'file') {
    const nextContent = String(content ?? '');
    if (Buffer.byteLength(nextContent, 'utf8') > MAX_SKILL_FILE_BYTES) {
      throw createHttpError('Skill file is too large to create', 413);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, nextContent, { encoding: 'utf8', flag: 'wx' });
  } else {
    throw createHttpError('Entry type must be file or directory', 400);
  }
  await syncManagedSkillAfterMutation(context, workspacePath);
  await applyWorkspaceOwnership({
    workspaceRoot: workspacePath,
    targetPaths: [targetPath],
    recursive: entryType === 'directory',
    reason: 'workspace_skill_entry_create',
    context: { skillName: context.name },
  });
  return getWorkspaceSkillDetail({ workspacePath, name: context.name, marketImports });
}

export async function updateWorkspaceSkillFile({
  workspacePath,
  name,
  filePath,
  content,
  revision,
  marketImports = [],
}) {
  const context = await requireEditableWorkspaceSkill({ workspacePath, name, marketImports });
  const targetPath = await resolveSkillEntryPath(context.rootPath, filePath, { mustExist: true });
  const stat = await fs.stat(targetPath);
  if (!stat.isFile()) {
    throw createHttpError('Selected skill entry is not a file', 400);
  }
  const currentBuffer = await fs.readFile(targetPath);
  if (isBinaryBuffer(currentBuffer)) {
    throw createHttpError('Binary skill files cannot be edited', 400);
  }
  const currentRevision = createHash('sha256').update(currentBuffer).digest('hex');
  if (firstString(revision) && revision !== currentRevision) {
    throw createHttpError('Skill file changed on disk. Reload it before saving.', 409);
  }
  const nextContent = String(content ?? '');
  if (Buffer.byteLength(nextContent, 'utf8') > MAX_SKILL_FILE_BYTES) {
    throw createHttpError('Skill file is too large to save', 413);
  }
  const normalizedFilePath = normalizeSkillRelativePath(filePath);
  if (normalizedFilePath === 'SKILL.md') {
    const currentManifest = tryParseSkillManifestContent(currentBuffer.toString('utf8'));
    const nextManifest = validateSkillManifestContent(nextContent);
    if (currentManifest?.name && nextManifest.name !== currentManifest.name) {
      throw createHttpError('SKILL.md.name 不可修改', 409, 'SKILL_MANIFEST_NAME_IMMUTABLE', {
        currentName: currentManifest.name,
        nextName: nextManifest.name,
      });
    }
  }
  const finalTargetPath = path.join(context.rootPath, ...normalizedFilePath.split('/'));
  const tempPath = `${finalTargetPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, nextContent, 'utf8');
  await fs.rename(tempPath, finalTargetPath);
  await syncManagedSkillAfterMutation(context, workspacePath);
  await applyWorkspaceOwnership({
    workspaceRoot: workspacePath,
    targetPaths: [finalTargetPath],
    reason: 'workspace_skill_file_update',
    context: { skillName: context.name },
  });
  const file = await readWorkspaceSkillFile({ workspacePath, name: context.name, filePath, marketImports });
  return { ...file, skillName: context.name };
}

export async function renameWorkspaceSkillEntry({
  workspacePath,
  name,
  entryPath,
  nextPath,
  marketImports = [],
}) {
  const context = await requireEditableWorkspaceSkill({ workspacePath, name, marketImports });
  const normalizedEntryPath = normalizeSkillRelativePath(entryPath);
  const normalizedNextPath = normalizeSkillRelativePath(nextPath);
  if (normalizedEntryPath === 'SKILL.md' || normalizedNextPath === 'SKILL.md') {
    throw createHttpError('The root SKILL.md cannot be renamed', 400);
  }
  const sourcePath = await resolveSkillEntryPath(context.rootPath, normalizedEntryPath, { mustExist: true });
  const destinationPath = await resolveSkillEntryPath(context.rootPath, normalizedNextPath, { mustExist: false });
  if (await pathExists(destinationPath)) {
    throw createHttpError('A skill entry already exists at the destination path', 409);
  }
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.rename(sourcePath, destinationPath);
  await syncManagedSkillAfterMutation(context, workspacePath);
  return getWorkspaceSkillDetail({ workspacePath, name: context.name, marketImports });
}

export async function renameLocalWorkspaceSkillDirectory({
  workspacePath,
  name,
  nextName,
  marketImports = [],
  onSkillRenamed,
}) {
  const context = await requireEditableWorkspaceSkill({ workspacePath, name, marketImports });
  const normalizedNextName = normalizeWorkspaceSkillName(nextName);
  const conflict = await findWorkspaceSkillNameConflict(workspacePath, normalizedNextName, context.name);
  if (conflict) {
    throw createHttpError(
      `Skill directory "${conflict}" already exists`,
      409,
      'SKILL_NAME_CONFLICT',
      { name: normalizedNextName, existingName: conflict },
    );
  }
  await renameWorkspaceSkillDirectory({ context, workspacePath, nextName: normalizedNextName, onSkillRenamed });
  return getWorkspaceSkillDetail({
    workspacePath,
    name: normalizedNextName,
    marketImports: (marketImports || []).map((entry) => (
      String(entry?.name || '').toLowerCase() === String(name || '').toLowerCase()
        ? { ...entry, name: normalizedNextName }
        : entry
    )),
  });
}

export async function deleteWorkspaceSkillEntry({ workspacePath, name, entryPath, marketImports = [] }) {
  const context = await requireEditableWorkspaceSkill({ workspacePath, name, marketImports });
  const normalizedEntryPath = normalizeSkillRelativePath(entryPath);
  if (normalizedEntryPath === 'SKILL.md') {
    throw createHttpError('The root SKILL.md cannot be deleted', 400);
  }
  const targetPath = await resolveSkillEntryPath(context.rootPath, normalizedEntryPath, { mustExist: true });
  await fs.rm(targetPath, { recursive: true, force: false });
  await syncManagedSkillAfterMutation(context, workspacePath);
  return getWorkspaceSkillDetail({ workspacePath, name: context.name, marketImports });
}

export async function deleteLocalWorkspaceSkill({ workspacePath, name, marketImports = [] }) {
  const context = await requireEditableWorkspaceSkill({ workspacePath, name, marketImports });
  if (context.managedEntry) {
    await uninstallManagedSkill({ workspacePath, name: context.name });
  } else {
    await fs.rm(context.rootPath, { recursive: true, force: false });
  }
  return { deleted: context.name };
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
    await applyWorkspaceOwnership({
      workspaceRoot: workspacePath,
      targetPaths: [previewDirectory],
      recursive: true,
      reason: 'workspace_skill_github_preview',
      context: { previewId, skillName },
    });
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
    await validateLocalSkillArchiveStructure(archiveBuffer);
    await fs.mkdir(archiveDirectory, { recursive: true });
    await extractGithubArchive(archiveBuffer, archiveDirectory);

    const skillDirectory = await resolveSingleExtractedRoot(archiveDirectory);

    const manifest = await parseSkillManifest(skillDirectory);
    if (manifest.status === 'invalid') {
      throw createHttpError(`Uploaded skill has an invalid SKILL.md: ${manifest.parseError}`, 400);
    }

    const skillName = normalizeWorkspaceSkillName(manifest.name);
    const conflict = await getSkillInstallConflict(workspacePath, skillName, { allowExactManaged: false });
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
    await applyWorkspaceOwnership({
      workspaceRoot: workspacePath,
      targetPaths: [previewDirectory],
      recursive: true,
      reason: 'workspace_skill_upload_preview',
      context: { previewId, skillName },
    });
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

  const conflict = await getSkillInstallConflict(workspacePath, name, {
    allowExactManaged: preview?.sourceType !== 'local-upload',
  });
  if (conflict.blocking) {
    const message = conflict.type === 'unmanaged' && !conflict.existingName
      ? `Skill "${name}" already exists as an unmanaged runtime skill`
      : `Skill "${conflict.existingName || name}" already exists`;
    throw createHttpError(
      message,
      409,
      'SKILL_NAME_CONFLICT',
      { name, existingName: conflict.existingName },
    );
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

    await applyWorkspaceOwnership({
      workspaceRoot: workspacePath,
      targetPaths: [sourcePath, ...(enable !== false ? [runtimePath] : [])],
      recursive: true,
      reason: 'workspace_skill_install',
      context: { skillName: name },
    });

    const manifest = await parseSkillManifest(sourcePath);
    await Promise.all([
      fs.rm(sourceBackupPath, { recursive: true, force: true }),
      fs.rm(runtimeBackupPath, { recursive: true, force: true }),
      fs.rm(previewDirectory, { recursive: true, force: true }),
    ]).catch((error) => {
      console.warn('[workspace-skills] Failed to remove an install staging path:', error?.message || error);
    });
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
    await materializeManagedSkill(sourcePath, runtimePath, workspacePath);
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
        await materializeManagedSkill(sourcePath, runtimePath, workspacePath);
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
  if (entries.length > MAX_SKILL_ARCHIVE_ENTRIES) {
    throw createHttpError('Skill archive contains too many files', 400);
  }

  let totalBytes = 0;
  for (const entry of entries) {
    const normalizedPath = normalizeArchivePath(entry.name);
    if (normalizedPath.split('/').length > MAX_SKILL_ARCHIVE_DEPTH) {
      throw createHttpError('Skill archive directory depth exceeds the limit', 400);
    }
    const destinationPath = path.join(destinationDirectory, normalizedPath);
    if (!isPathInside(destinationDirectory, destinationPath)) {
      throw createHttpError('GitHub archive contains an unsafe file path', 400);
    }
    const content = await entry.async('nodebuffer');
    if (content.length > MAX_SKILL_ARCHIVE_ENTRY_BYTES) {
      throw createHttpError('Skill archive contains a file that is too large', 400);
    }
    totalBytes += content.length;
    if (totalBytes > MAX_SKILL_ARCHIVE_TOTAL_BYTES) {
      throw createHttpError('Skill archive expands beyond the allowed size', 400);
    }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, content);
  }
}

async function validateLocalSkillArchiveStructure(archiveBuffer) {
  const zip = await JSZip.loadAsync(archiveBuffer);
  const entries = Object.values(zip.files)
    .map((entry) => ({ entry, normalizedPath: normalizeArchivePath(entry.name) }))
    .filter(({ normalizedPath }) => normalizedPath);
  const topLevelNames = new Set(entries.map(({ normalizedPath }) => normalizedPath.split('/')[0]));
  const rootFiles = entries
    .filter(({ entry, normalizedPath }) => !entry.dir && !normalizedPath.includes('/'))
    .map(({ normalizedPath }) => normalizedPath);
  const topLevelName = topLevelNames.size === 1 ? Array.from(topLevelNames)[0] : null;
  const manifestPaths = entries
    .filter(({ entry, normalizedPath }) => !entry.dir && normalizedPath.split('/').pop() === 'SKILL.md')
    .map(({ normalizedPath }) => normalizedPath);
  const expectedManifestPath = topLevelName ? `${topLevelName}/SKILL.md` : null;

  if (
    topLevelNames.size !== 1
    || rootFiles.length > 0
    || manifestPaths.length !== 1
    || manifestPaths[0] !== expectedManifestPath
  ) {
    throw createHttpError(
      'Uploaded ZIP must contain exactly one top-level directory with one direct SKILL.md and no root files',
      400,
      'SKILL_UPLOAD_STRUCTURE_INVALID',
      {
        topLevelEntries: Array.from(topLevelNames).sort(),
        rootFiles,
        manifestPaths,
      },
    );
  }
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

async function getSkillInstallConflict(workspacePath, name, { allowExactManaged = true } = {}) {
  const metadata = await readSkillsMetadata(workspacePath);
  const normalizedName = normalizeWorkspaceSkillIdentityKey(name);
  const managedName = Object.keys(metadata.skills || {}).find((entryName) => (
    normalizeWorkspaceSkillIdentityKey(entryName) === normalizedName
  ));
  if (managedName) {
    return pruneUndefined({
      type: 'managed',
      blocking: !allowExactManaged || managedName !== name,
      existingName: managedName,
    });
  }

  const { runtimeRoot } = getWorkspaceSkillsPaths(workspacePath);
  const runtimeDirectories = await listDirectories(runtimeRoot);
  const runtimeDirectory = runtimeDirectories.find((entry) => (
    normalizeWorkspaceSkillIdentityKey(entry.name) === normalizedName
  ));
  if (runtimeDirectory) {
    return pruneUndefined({
      type: 'unmanaged',
      blocking: true,
      existingName: runtimeDirectory.name !== name ? runtimeDirectory.name : undefined,
    });
  }

  const manifestConflict = await findWorkspaceManifestNameConflict(workspacePath, normalizedName, metadata, runtimeDirectories);
  if (manifestConflict) {
    return {
      type: manifestConflict.managed ? 'managed' : 'unmanaged',
      blocking: true,
      existingName: manifestConflict.directoryName,
    };
  }

  return { type: 'none', blocking: false };
}

async function findWorkspaceManifestNameConflict(workspacePath, normalizedName, metadata, runtimeDirectories) {
  const { sourceRoot } = getWorkspaceSkillsPaths(workspacePath);
  const managedNames = Object.keys(metadata.skills || {});
  const candidates = [
    ...runtimeDirectories.map((entry) => ({
      directoryName: entry.name,
      directoryPath: entry.path,
      managed: managedNames.some((name) => (
        normalizeWorkspaceSkillIdentityKey(name) === normalizeWorkspaceSkillIdentityKey(entry.name)
      )),
    })),
    ...managedNames.map((directoryName) => ({
      directoryName,
      directoryPath: path.join(sourceRoot, directoryName),
      managed: true,
    })),
  ];
  const visited = new Set();
  for (const candidate of candidates) {
    const candidatePath = path.resolve(candidate.directoryPath);
    if (visited.has(candidatePath)) continue;
    visited.add(candidatePath);
    let parsed;
    try {
      parsed = tryParseSkillManifestContent(await fs.readFile(path.join(candidatePath, 'SKILL.md'), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (parsed && normalizeWorkspaceSkillIdentityKey(parsed.name) === normalizedName) {
      return candidate;
    }
  }
  return null;
}

async function materializeManagedSkill(sourcePath, runtimePath, workspacePath) {
  await assertDirectoryExists(sourcePath, `Managed skill source does not exist at ${sourcePath}`);
  const stagePath = path.join(path.dirname(runtimePath), `.${path.basename(runtimePath)}.${process.pid}.${Date.now()}.stage`);
  await fs.mkdir(path.dirname(runtimePath), { recursive: true });
  await fs.rm(stagePath, { recursive: true, force: true });
  await fs.cp(sourcePath, stagePath, { recursive: true });
  await fs.rm(runtimePath, { recursive: true, force: true });
  await fs.rename(stagePath, runtimePath);
  await applyWorkspaceOwnership({
    workspaceRoot: workspacePath,
    targetPaths: [runtimePath],
    recursive: true,
    reason: 'workspace_skill_materialize',
    context: { skillName: path.basename(runtimePath) },
  });
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
        files.push(path.relative(rootDirectory, entryPath).replace(/\\/g, '/'));
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

async function listSkillEntries(rootDirectory) {
  const entries = [];

  async function visit(currentDirectory) {
    const children = await fs.readdir(currentDirectory, { withFileTypes: true });
    children.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      if (left.name === 'SKILL.md') return -1;
      if (right.name === 'SKILL.md') return 1;
      return left.name.localeCompare(right.name);
    });
    for (const child of children) {
      const childPath = path.join(currentDirectory, child.name);
      const relativePath = path.relative(rootDirectory, childPath).split(path.sep).join('/');
      const childStat = await fs.lstat(childPath);
      if (childStat.isSymbolicLink()) {
        entries.push({ path: relativePath, type: 'symlink', size: childStat.size });
      } else if (child.isDirectory()) {
        entries.push({ path: relativePath, type: 'directory' });
        await visit(childPath);
      } else if (child.isFile()) {
        entries.push({
          path: relativePath,
          type: 'file',
          size: childStat.size,
          mimeType: inferSkillFileMimeType(relativePath),
        });
      }
    }
  }

  await visit(rootDirectory);
  return entries;
}

function createMarketImportsByName(marketImports) {
  return new Map((Array.isArray(marketImports) ? marketImports : [])
    .filter((entry) => firstString(entry?.name))
    .map((entry) => [firstString(entry.name).toLowerCase(), entry]));
}

async function resolveWorkspaceSkillContext({ workspacePath, name, marketImports = [], currentUsername }) {
  const skillName = normalizeWorkspaceSkillName(name);
  const importsByName = createMarketImportsByName(marketImports);
  const marketImport = importsByName.get(skillName.toLowerCase());
  const metadata = await readSkillsMetadata(workspacePath);
  const managedKey = Object.keys(metadata.skills).find((entryName) => entryName.toLowerCase() === skillName.toLowerCase());
  const managedEntry = managedKey ? metadata.skills[managedKey] : null;
  const { sourceRoot, runtimeRoot } = getWorkspaceSkillsPaths(workspacePath);
  const actualName = managedKey || skillName;
  const runtimePath = path.join(runtimeRoot, actualName);
  const sourcePath = path.join(sourceRoot, actualName);
  const rootPath = await pathExists(runtimePath) ? runtimePath : sourcePath;
  await assertDirectoryExists(rootPath, `Workspace skill "${skillName}" was not found`);
  const rootStat = await fs.lstat(rootPath);
  if (rootStat.isSymbolicLink()) {
    throw createHttpError('Symbolic-link skill directories are not supported', 403);
  }

  return {
    name: actualName,
    origin: resolveSkillOrigin({ sourceType: managedEntry?.sourceType }, marketImport, currentUsername),
    marketImport,
    managedEntry,
    rootPath,
  };
}

async function requireEditableWorkspaceSkill(options) {
  return resolveWorkspaceSkillContext(options);
}

function resolveSkillOrigin(skill, marketImport, currentUsername) {
  if (!marketImport) return 'local';
  if (marketImport.origin === 'local' || marketImport.origin === 'market') return marketImport.origin;
  if (marketImport.bindingType === 'published') return 'local';
  if (firstString(skill?.sourceType) === 'local-upload') return 'local';
  if (
    !marketImport.bindingType
    && currentUsername
    && marketImport.createUserId
    && String(currentUsername) === String(marketImport.createUserId)
  ) return 'local';
  return 'market';
}

function resolveBindingType(origin, marketImport) {
  if (!marketImport) return undefined;
  if (marketImport.bindingType === 'published' || marketImport.bindingType === 'imported') {
    return marketImport.bindingType;
  }
  return origin === 'local' ? 'published' : 'imported';
}

async function isWorkspaceSkillLocallyModified(skill, marketImport) {
  if (!marketImport?.baselineHash || skill?.kind === 'system') return false;
  const rootPath = firstString(skill?.sourcePath) || firstString(skill?.runtimePath);
  return rootPath ? isSkillRootLocallyModified(rootPath, marketImport) : false;
}

async function isSkillRootLocallyModified(rootPath, marketImport) {
  if (!marketImport?.baselineHash) return false;
  try {
    return (await computeSkillDirectoryHash(rootPath)) !== marketImport.baselineHash;
  } catch {
    return false;
  }
}

export async function computeSkillDirectoryHash(rootPath) {
  const files = await listRelativeFiles(rootPath);
  const digest = createHash('sha256');
  for (const relativePath of files.sort((left, right) => left.localeCompare(right))) {
    digest.update(relativePath);
    digest.update('\0');
    digest.update(await fs.readFile(path.join(rootPath, ...relativePath.split('/'))));
    digest.update('\0');
  }
  return digest.digest('hex');
}

function normalizeWorkspaceSkillName(name) {
  const skillName = firstString(name);
  if (!skillName) throw createHttpError('Skill name is required', 400);
  if (
    skillName === '.'
    || skillName === '..'
    || /[\\/]/.test(skillName)
    || /[\x00-\x1F\x7F]/.test(skillName)
  ) {
    throw createHttpError('Skill name contains invalid path characters', 400);
  }
  return skillName;
}

function normalizeWorkspaceSkillIdentityKey(name) {
  return firstString(name).normalize('NFC').toLowerCase();
}

function normalizeSkillRelativePath(entryPath) {
  const rawPath = firstString(entryPath).replace(/\\/g, '/');
  if (!rawPath || rawPath.startsWith('/') || rawPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw createHttpError('Skill entry path must be a safe relative path', 400);
  }
  return rawPath;
}

async function resolveSkillEntryPath(rootPath, entryPath, { mustExist }) {
  const normalizedPath = normalizeSkillRelativePath(entryPath);
  const targetPath = path.resolve(rootPath, normalizedPath);
  if (!isPathInside(rootPath, targetPath)) {
    throw createHttpError('Skill entry path must stay inside the skill directory', 403);
  }

  const relativeSegments = normalizedPath.split('/');
  let currentPath = rootPath;
  for (let index = 0; index < relativeSegments.length; index += 1) {
    currentPath = path.join(currentPath, relativeSegments[index]);
    try {
      const stat = await fs.lstat(currentPath);
      if (stat.isSymbolicLink()) {
        throw createHttpError('Symbolic links are not supported in editable skill paths', 403);
      }
    } catch (error) {
      if (error?.statusCode) throw error;
      if (error?.code === 'ENOENT') {
        if (mustExist || index < relativeSegments.length - 1) {
          throw createHttpError('Skill entry was not found', 404);
        }
        break;
      }
      throw error;
    }
  }
  return targetPath;
}

async function syncManagedSkillAfterMutation(context, workspacePath) {
  if (!context.managedEntry || context.managedEntry.enabled === false) return;
  const { runtimeRoot, sourceRoot } = getWorkspaceSkillsPaths(workspacePath);
  const runtimePath = path.join(runtimeRoot, context.name);
  const sourcePath = path.join(sourceRoot, context.name);
  if (path.resolve(context.rootPath) === path.resolve(runtimePath)) {
    await replaceSkillDirectory(runtimePath, sourcePath);
  } else {
    await materializeManagedSkill(sourcePath, runtimePath, workspacePath);
  }
}

async function replaceSkillDirectory(sourcePath, destinationPath) {
  const stagePath = `${destinationPath}.${process.pid}.${Date.now()}.stage`;
  const backupPath = `${destinationPath}.${process.pid}.${Date.now()}.backup`;
  let backedUp = false;
  try {
    await fs.rm(stagePath, { recursive: true, force: true });
    await fs.cp(sourcePath, stagePath, { recursive: true });
    if (await pathExists(destinationPath)) {
      await fs.rename(destinationPath, backupPath);
      backedUp = true;
    }
    await fs.rename(stagePath, destinationPath);
    await fs.rm(backupPath, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(stagePath, { recursive: true, force: true });
    await fs.rm(destinationPath, { recursive: true, force: true });
    if (backedUp) await fs.rename(backupPath, destinationPath).catch(() => {});
    throw error;
  }
}

async function findWorkspaceSkillNameConflict(workspacePath, candidateName, currentName = '') {
  const normalizedCandidate = normalizeWorkspaceSkillIdentityKey(normalizeWorkspaceSkillName(candidateName));
  const normalizedCurrent = normalizeWorkspaceSkillIdentityKey(currentName);
  const metadata = await readSkillsMetadata(workspacePath);
  const { runtimeRoot } = getWorkspaceSkillsPaths(workspacePath);
  const names = new Set([
    ...Object.keys(metadata.skills || {}),
    ...(await listDirectories(runtimeRoot)).map((entry) => entry.name),
  ]);
  return Array.from(names).find((entryName) => (
    normalizeWorkspaceSkillIdentityKey(entryName) === normalizedCandidate
    && normalizeWorkspaceSkillIdentityKey(entryName) !== normalizedCurrent
  ));
}

async function renameWorkspaceSkillDirectory({ context, workspacePath, nextName, onSkillRenamed }) {
  const currentName = context.name;
  normalizeWorkspaceSkillName(nextName);
  const { sourceRoot, runtimeRoot } = getWorkspaceSkillsPaths(workspacePath);
  const moves = context.managedEntry
    ? [
        { from: path.join(sourceRoot, currentName), to: path.join(sourceRoot, nextName), required: true },
        { from: path.join(runtimeRoot, currentName), to: path.join(runtimeRoot, nextName), required: false },
      ]
    : [{ from: path.join(runtimeRoot, currentName), to: path.join(runtimeRoot, nextName), required: true }];
  const completedMoves = [];
  const oldMetadata = context.managedEntry ? await readSkillsMetadata(workspacePath) : null;

  try {
    for (const move of moves) {
      if (!await pathExists(move.from)) {
        if (move.required) throw createHttpError(`Skill directory "${currentName}" was not found`, 404);
        continue;
      }
      const tempPath = path.join(path.dirname(move.from), `.${currentName}.${process.pid}.${Date.now()}.rename`);
      await fs.rename(move.from, tempPath);
      try {
        await fs.rename(tempPath, move.to);
      } catch (error) {
        await fs.rename(tempPath, move.from).catch(() => {});
        throw error;
      }
      completedMoves.push(move);
    }

    if (oldMetadata) {
      const nextSkills = { ...oldMetadata.skills };
      const entry = nextSkills[currentName];
      delete nextSkills[currentName];
      nextSkills[nextName] = { ...entry, name: nextName, updatedAt: new Date().toISOString() };
      await writeSkillsMetadata(workspacePath, { ...oldMetadata, skills: nextSkills });
    }
    await onSkillRenamed?.({ currentName, nextName });
  } catch (error) {
    if (oldMetadata) await writeSkillsMetadata(workspacePath, oldMetadata).catch(() => {});
    for (const move of completedMoves.reverse()) {
      if (await pathExists(move.to)) {
        await fs.rename(move.to, move.from).catch(() => {});
      }
    }
    throw error;
  }

  context.name = nextName;
  context.rootPath = context.managedEntry ? path.join(sourceRoot, nextName) : path.join(runtimeRoot, nextName);
}

function validateSkillManifestContent(content) {
  try {
    matter.clearCache();
    const parsed = matter(String(content ?? ''));
    const manifestName = firstString(parsed.data?.name);
    const description = firstString(parsed.data?.description);
    if (!manifestName) throw new Error('frontmatter name is required');
    if (!description) throw new Error('frontmatter description is required');
    normalizeWorkspaceSkillName(manifestName);
    return { name: manifestName, description };
  } catch (error) {
    throw createHttpError(
      `Invalid SKILL.md: ${error?.message || 'frontmatter could not be parsed'}`,
      400,
      'SKILL_MANIFEST_INVALID',
    );
  }
}

function tryParseSkillManifestContent(content) {
  try {
    matter.clearCache();
    const parsed = matter(String(content ?? ''));
    const name = firstString(parsed.data?.name);
    return name ? { name } : null;
  } catch {
    return null;
  }
}

function normalizeNonNegativeInteger(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : undefined;
}

function isBinaryBuffer(buffer) {
  if (!buffer?.length) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.1;
}

function inferSkillFileMimeType(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  return ({
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.json': 'application/json',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.js': 'text/javascript',
    '.jsx': 'text/javascript',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.py': 'text/x-python',
    '.sh': 'text/x-shellscript',
    '.txt': 'text/plain',
    '.css': 'text/css',
    '.html': 'text/html',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  })[extension] || 'application/octet-stream';
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
  const skillName = firstString(name);
  if (!skillName) {
    throw createHttpError('Skill name is required', 400);
  }
  if (
    skillName === '.'
    || skillName === '..'
    || /[\\/]/.test(skillName)
    || /[\x00-\x1F\x7F]/.test(skillName)
  ) {
    throw createHttpError('Skill name contains invalid path characters', 400);
  }
}

function sanitizeSkillName(name) {
  return firstString(name);
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

function createHttpError(message, statusCode = 400, code, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  if (details) error.details = details;
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
