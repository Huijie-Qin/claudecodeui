import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { loadBuiltinHookSkill } from './hook-builtin-skills.js';
import { hookMcpCatalogService } from './hook-mcp-catalog.js';

const HOOK_CONFIG_DIRECTORY = path.join('.cloudcli', 'hook-config');
const MAX_SKILL_FILES = 512;
const MAX_SKILL_BYTES = 32 * 1024 * 1024;
const MATERIALIZED_DIRECTORY_MODE = 0o755;
const MATERIALIZED_FILE_MODE = 0o644;
const MATERIALIZED_EXECUTABLE_MODE = 0o755;

function createResourceError(message, statusCode = 409) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function safeSegment(value, fallback = 'resource') {
  const normalized = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return normalized.slice(0, 100) || fallback;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function materializedFileMode(sourceMode) {
  return sourceMode & 0o111
    ? MATERIALIZED_EXECUTABLE_MODE
    : MATERIALIZED_FILE_MODE;
}

async function ensureDirectoryMode(directory, mode = MATERIALIZED_DIRECTORY_MODE) {
  await fs.mkdir(directory, { recursive: true, mode });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw createResourceError(`Hook resource path is not a safe directory: ${directory}`);
  }
  if ((stat.mode & 0o777) !== mode) await fs.chmod(directory, mode);
}

async function ensureHookConfigRoot(workspaceRoot) {
  const cloudcliDirectory = path.join(workspaceRoot, '.cloudcli');
  await fs.mkdir(cloudcliDirectory, { recursive: true, mode: MATERIALIZED_DIRECTORY_MODE });
  const cloudcliStat = await fs.lstat(cloudcliDirectory);
  if (cloudcliStat.isSymbolicLink() || !cloudcliStat.isDirectory()) {
    throw createResourceError(`Hook resource path is not a safe directory: ${cloudcliDirectory}`);
  }
  const traversableMode = (cloudcliStat.mode & 0o777) | 0o111;
  if ((cloudcliStat.mode & 0o777) !== traversableMode) {
    await fs.chmod(cloudcliDirectory, traversableMode);
  }

  const hookConfigRoot = path.join(workspaceRoot, HOOK_CONFIG_DIRECTORY);
  await ensureDirectoryMode(hookConfigRoot);
  return hookConfigRoot;
}

function collectMaterializedDirectories(targetDirectory, files) {
  const directories = new Set([targetDirectory]);
  for (const file of files) {
    let relativeDirectory = path.dirname(file.relativePath);
    while (relativeDirectory && relativeDirectory !== '.') {
      directories.add(path.join(targetDirectory, relativeDirectory));
      relativeDirectory = path.dirname(relativeDirectory);
    }
  }
  return [...directories].sort((left, right) => left.length - right.length);
}

async function reconcileMaterializedSkill({ targetDirectory, files }) {
  for (const directory of collectMaterializedDirectories(targetDirectory, files)) {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw createResourceError(`Hook Skill cache contains an unsafe directory: ${directory}`);
    }
    if ((stat.mode & 0o777) !== MATERIALIZED_DIRECTORY_MODE) {
      await fs.chmod(directory, MATERIALIZED_DIRECTORY_MODE);
    }
  }

  for (const file of files) {
    const destination = path.join(targetDirectory, file.relativePath);
    const stat = await fs.lstat(destination);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw createResourceError(`Hook Skill cache contains an unsafe file: ${destination}`);
    }
    const mode = materializedFileMode(file.mode);
    if ((stat.mode & 0o777) !== mode) await fs.chmod(destination, mode);
  }

  const metadataPath = path.join(targetDirectory, '.ccui-resource.json');
  try {
    const stat = await fs.lstat(metadataPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw createResourceError(`Hook Skill cache contains an unsafe file: ${metadataPath}`);
    }
    if ((stat.mode & 0o777) !== MATERIALIZED_FILE_MODE) {
      await fs.chmod(metadataPath, MATERIALIZED_FILE_MODE);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function scanSkillDirectory(directory, relativeDirectory = '') {
  const entries = await fs.readdir(path.join(directory, relativeDirectory), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
    const absolutePath = path.join(directory, relativePath);
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) throw createResourceError(`Hook Skill contains a symbolic link: ${relativePath}`);
    if (stat.isDirectory()) {
      files.push(...await scanSkillDirectory(directory, relativePath));
      continue;
    }
    if (!stat.isFile()) throw createResourceError(`Hook Skill contains an unsupported file: ${relativePath}`);
    files.push({ relativePath, absolutePath, size: stat.size, mode: stat.mode & 0o777 });
  }
  return files;
}

async function describeSkill(skill) {
  const sourceDirectory = path.dirname(skill.manifestPath);
  const files = await scanSkillDirectory(sourceDirectory);
  if (files.length > MAX_SKILL_FILES) {
    throw createResourceError(`Hook Skill ${skill.name} exceeds ${MAX_SKILL_FILES} files`);
  }
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_SKILL_BYTES) {
    throw createResourceError(`Hook Skill ${skill.name} exceeds ${MAX_SKILL_BYTES} bytes`);
  }
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file.relativePath.split(path.sep).join('/'));
    hash.update('\0');
    hash.update(String(file.mode));
    hash.update('\0');
    hash.update(await fs.readFile(file.absolutePath));
    hash.update('\0');
  }
  return { sourceDirectory, files, totalBytes, contentHash: hash.digest('hex') };
}

async function materializeSkill({ workspaceRoot, skill }) {
  const description = await describeSkill(skill);
  const skillKey = safeSegment(skill.skillId, safeSegment(skill.name, 'skill'));
  const skillRoot = path.join(workspaceRoot, HOOK_CONFIG_DIRECTORY, 'skills', skillKey);
  const targetDirectory = path.join(skillRoot, description.contentHash);
  const manifestPath = path.join(targetDirectory, 'SKILL.md');
  await ensureDirectoryMode(path.dirname(skillRoot));
  await ensureDirectoryMode(skillRoot);
  try {
    const stat = await fs.lstat(manifestPath);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      await reconcileMaterializedSkill({ targetDirectory, files: description.files });
      return { ...skill, contentHash: description.contentHash, hostDirectory: targetDirectory };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const stagingDirectory = path.join(skillRoot, `.staging-${crypto.randomUUID()}`);
  await fs.mkdir(stagingDirectory, { mode: MATERIALIZED_DIRECTORY_MODE });
  try {
    for (const file of description.files) {
      const destination = path.join(stagingDirectory, file.relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: MATERIALIZED_DIRECTORY_MODE });
      await fs.copyFile(file.absolutePath, destination);
      await fs.chmod(destination, materializedFileMode(file.mode));
    }
    await fs.writeFile(path.join(stagingDirectory, '.ccui-resource.json'), `${JSON.stringify({
      type: 'hook-skill',
      skillId: skill.skillId,
      skillName: skill.name,
      contentHash: description.contentHash,
      fileCount: description.files.length,
      totalBytes: description.totalBytes,
      materializedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: MATERIALIZED_FILE_MODE });
    try {
      await fs.rename(stagingDirectory, targetDirectory);
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
    }
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
  }
  await reconcileMaterializedSkill({ targetDirectory, files: description.files });
  return { ...skill, contentHash: description.contentHash, hostDirectory: targetDirectory };
}

function resolveActionMcpServerIds(hook, catalog) {
  const serverIds = new Set();
  for (const action of hook?.postActions || []) {
    if (!['call_mcp_tool', 'mcp_loop_run'].includes(action.type)) continue;
    let serverId = String(action.config?.mcpServerId || '').trim();
    if (!serverId) {
      const toolName = String(action.config?.toolName || '');
      const resource = catalog.listToolResources().find((candidate) => candidate.name === toolName);
      serverId = resource?.mcpServerId || '';
    }
    if (serverId) serverIds.add(serverId);
  }
  return [...serverIds];
}

async function materializeMcpManifest({ workspaceRoot, server }) {
  const serverDirectory = path.join(
    workspaceRoot,
    HOOK_CONFIG_DIRECTORY,
    'mcp',
    safeSegment(server.id, 'mcp'),
    server.contentHash,
  );
  await ensureDirectoryMode(path.dirname(path.dirname(serverDirectory)));
  await ensureDirectoryMode(path.dirname(serverDirectory));
  await ensureDirectoryMode(serverDirectory);
  if (server.helperScript?.content) {
    const helperPath = path.join(serverDirectory, safeSegment(server.helperScript.fileName, 'headers-helper'));
    await fs.writeFile(helperPath, server.helperScript.content, { mode: MATERIALIZED_EXECUTABLE_MODE });
    await fs.chmod(helperPath, MATERIALIZED_EXECUTABLE_MODE);
  }
  const { headers: _headers, helperEnv: _helperEnv, ...safeConfig } = server.config || {};
  await fs.writeFile(path.join(serverDirectory, 'server.json'), `${stableJson({
    type: 'hook-mcp',
    id: server.id,
    name: server.name,
    displayName: server.displayName,
    runtimeAlias: server.runtimeAlias,
    contentHash: server.contentHash,
    config: safeConfig,
    helperScript: server.helperScript ? {
      fileName: server.helperScript.fileName,
      sha256: server.helperScript.sha256,
    } : null,
  })}\n`, { mode: MATERIALIZED_FILE_MODE });
  return { ...server, hostDirectory: serverDirectory };
}

export function createHookWorkspaceResourcesService({
  hookMcpCatalog = hookMcpCatalogService,
  skillLoader = loadBuiltinHookSkill,
} = {}) {
  async function materializeHook({ hook, workspacePath }) {
    if (!hook?.id) throw createResourceError('Hook is required');
    const requestedWorkspacePath = String(workspacePath || '').trim();
    if (!requestedWorkspacePath || !path.isAbsolute(requestedWorkspacePath)) {
      throw createResourceError('Workspace path must be absolute', 500);
    }
    const workspaceRoot = path.resolve(requestedWorkspacePath);
    await ensureHookConfigRoot(workspaceRoot);

    const skills = [];
    for (const action of hook.postActions || []) {
      if (action.type !== 'invoke_skill') continue;
      const skill = await skillLoader({
        skillId: action.config?.skillId,
        skillName: action.config?.skillName,
      });
      if (!skills.some((candidate) => candidate.skillId === skill.skillId)) {
        skills.push(await materializeSkill({ workspaceRoot, skill }));
      }
    }

    const serverIds = resolveActionMcpServerIds(hook, hookMcpCatalog);
    const mcpServers = [];
    for (const serverId of serverIds) {
      const server = hookMcpCatalog.getServerById(serverId);
      if (!server) throw createResourceError(`Hook MCP server ${serverId} is unavailable`);
      const publicServer = hookMcpCatalog.listServers().find((candidate) => candidate.id === serverId);
      mcpServers.push(await materializeMcpManifest({
        workspaceRoot,
        server: { ...server, ...publicServer, helperScript: server.helperScript || null },
      }));
    }

    const hookDirectory = path.join(workspaceRoot, HOOK_CONFIG_DIRECTORY, 'hooks');
    await ensureDirectoryMode(hookDirectory);
    await fs.writeFile(path.join(hookDirectory, `${safeSegment(hook.id, 'hook')}.json`), `${stableJson({
      hookId: hook.id,
      hookVersion: hook.version,
      skillResources: skills.map((skill) => ({ skillId: skill.skillId, contentHash: skill.contentHash })),
      mcpResources: mcpServers.map((server) => ({ id: server.id, contentHash: server.contentHash })),
      materializedAt: new Date().toISOString(),
    })}\n`, { mode: MATERIALIZED_FILE_MODE });
    return { root: path.join(workspaceRoot, HOOK_CONFIG_DIRECTORY), skills, mcpServers };
  }

  async function materializeHooks({ hooks, workspacePath }) {
    const results = [];
    for (const hook of hooks || []) results.push(await materializeHook({ hook, workspacePath }));
    return results;
  }

  return { materializeHook, materializeHooks, resolveActionMcpServerIds };
}

export const hookWorkspaceResourcesService = createHookWorkspaceResourcesService();

export { HOOK_CONFIG_DIRECTORY };
