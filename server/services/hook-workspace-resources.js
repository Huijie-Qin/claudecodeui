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

export async function describeHookSkillSource(skill) {
  const sourceDirectory = path.dirname(skill.manifestPath);
  const files = await scanSkillDirectory(sourceDirectory);
  if (files.length > MAX_SKILL_FILES) {
    throw createResourceError(`Hook Skill ${skill.name} exceeds ${MAX_SKILL_FILES} files`);
  }
  const filesWithContent = await Promise.all(files.map(async (file) => ({
    ...file,
    content: await fs.readFile(file.absolutePath),
  })));
  const totalBytes = filesWithContent.reduce((total, file) => total + file.content.length, 0);
  if (totalBytes > MAX_SKILL_BYTES) {
    throw createResourceError(`Hook Skill ${skill.name} exceeds ${MAX_SKILL_BYTES} bytes`);
  }
  const hash = crypto.createHash('sha256');
  for (const file of filesWithContent) {
    hash.update(file.relativePath.split(path.sep).join('/'));
    hash.update('\0');
    hash.update(String(file.mode));
    hash.update('\0');
    hash.update(file.content);
    hash.update('\0');
  }
  return {
    sourceDirectory,
    files: filesWithContent,
    totalBytes,
    contentHash: hash.digest('hex'),
  };
}

async function materializeSkill({ workspaceRoot, skill, description }) {
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
      await fs.writeFile(destination, file.content, { mode: materializedFileMode(file.mode) });
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
  const tools = catalog.listToolResources();
  for (const action of hook?.postActions || []) {
    if (!['call_mcp_tool', 'mcp_loop_run'].includes(action.type)) continue;
    if (action.type === 'mcp_loop_run') {
      const matchedTool = tools.find((candidate) => candidate.name === hook?.matcher?.value);
      if (matchedTool?.mcpServerId) serverIds.add(matchedTool.mcpServerId);
      continue;
    }
    let serverId = String(action.config?.mcpServerId || '').trim();
    if (!serverId) {
      const toolName = String(action.config?.toolName || '');
      const resource = tools.find((candidate) => candidate.name === toolName);
      serverId = resource?.mcpServerId || '';
    }
    if (serverId) serverIds.add(serverId);
  }
  return [...serverIds];
}

function resolveActionMcpTools(hook, catalog) {
  const tools = catalog.listToolResources();
  const selected = new Map();
  for (const action of hook?.postActions || []) {
    if (!['call_mcp_tool', 'mcp_loop_run'].includes(action.type)) continue;
    const name = action.type === 'mcp_loop_run'
      ? String(hook?.matcher?.value || '')
      : String(action.config?.toolName || '');
    if (!name) continue;
    const explicitServerId = action.type === 'call_mcp_tool'
      ? String(action.config?.mcpServerId || '')
      : '';
    const tool = tools.find((candidate) => (
      candidate.name === name
      && (!explicitServerId || candidate.mcpServerId === explicitServerId)
    ));
    if (!tool) throw createResourceError(`Hook MCP tool ${name} is unavailable`);
    selected.set(`${tool.mcpServerId}\0${tool.name}`, {
      name: tool.name,
      toolName: tool.name,
      mcpServerId: tool.mcpServerId,
    });
  }
  return [...selected.values()];
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
  const preparedPlans = new WeakMap();

  function validatePreparedResources(hook, resources) {
    const expected = hook?.resourceRefs;
    if (!expected || typeof expected !== 'object') return;
    for (const expectedSkill of Array.isArray(expected.skills) ? expected.skills : []) {
      const skillId = typeof expectedSkill === 'string'
        ? expectedSkill
        : String(expectedSkill?.skillId || '');
      if (!skillId) continue;
      const actual = resources.skills.find((skill) => skill.skillId === skillId);
      if (!actual) throw createResourceError(`Published Hook Skill ${skillId} could not be resolved`);
      const expectedVersion = typeof expectedSkill === 'object' && expectedSkill != null
        ? Number(expectedSkill.version)
        : NaN;
      if (
        Number.isFinite(expectedVersion)
        && expectedVersion > 0
        && Number(actual.version) !== expectedVersion
      ) {
        throw createResourceError(`Published Hook Skill ${skillId} version has changed`);
      }
      const expectedHash = typeof expectedSkill === 'object' && expectedSkill != null
        ? String(expectedSkill.contentHash || '')
        : '';
      if (expectedHash && actual.contentHash !== expectedHash) {
        throw createResourceError(`Published Hook Skill ${skillId} content has changed`);
      }
    }
    for (const expectedServer of Array.isArray(expected.mcpServers) ? expected.mcpServers : []) {
      const serverId = typeof expectedServer === 'string'
        ? expectedServer
        : String(expectedServer?.id || '');
      if (!serverId) continue;
      const actual = resources.mcpServers.find((server) => server.id === serverId);
      if (!actual) throw createResourceError(`Published Hook MCP server ${serverId} could not be resolved`);
      const expectedHash = typeof expectedServer === 'object' && expectedServer != null
        ? String(expectedServer.contentHash || '')
        : '';
      if (expectedHash && actual.contentHash !== expectedHash) {
        throw createResourceError(`Published Hook MCP server ${serverId} configuration has changed`);
      }
    }
    for (const expectedTool of Array.isArray(expected.mcpTools) ? expected.mcpTools : []) {
      const toolName = typeof expectedTool === 'string'
        ? expectedTool
        : String(expectedTool?.toolName || expectedTool?.name || '');
      if (!toolName) continue;
      const expectedServerId = typeof expectedTool === 'object' && expectedTool != null
        ? String(expectedTool.mcpServerId || '')
        : '';
      const actual = resources.mcpTools.find((tool) => (
        tool.toolName === toolName
        && (!expectedServerId || tool.mcpServerId === expectedServerId)
      ));
      if (!actual) throw createResourceError(`Published Hook MCP tool ${toolName} is unavailable`);
    }
  }

  async function prepareHook({ hook }) {
    if (!hook?.id) throw createResourceError('Hook is required');
    const skillPlans = [];
    for (const action of hook.postActions || []) {
      if (action.type !== 'invoke_skill') continue;
      let skill;
      try {
        skill = await skillLoader({
          skillId: action.config?.skillId,
          skillName: action.config?.skillName,
        });
      } catch (error) {
        if (error?.statusCode) throw error;
        throw createResourceError(error?.message || 'Hook Skill is unavailable');
      }
      if (!skillPlans.some((candidate) => candidate.skill.skillId === skill.skillId)) {
        let description;
        try {
          description = await describeHookSkillSource(skill);
        } catch (error) {
          if (error?.statusCode) throw error;
          throw createResourceError(error?.message || `Hook Skill ${skill.name} is unavailable`);
        }
        skillPlans.push({ skill, description });
      }
    }

    const mcpTools = resolveActionMcpTools(hook, hookMcpCatalog);
    const serverIds = resolveActionMcpServerIds(hook, hookMcpCatalog);
    const serverPlans = [];
    for (const serverId of serverIds) {
      const server = hookMcpCatalog.getServerById(serverId);
      if (!server) throw createResourceError(`Hook MCP server ${serverId} is unavailable`);
      const publicServer = hookMcpCatalog.listServers().find((candidate) => candidate.id === serverId);
      serverPlans.push({ ...server, ...publicServer, helperScript: server.helperScript || null });
    }

    const resources = {
      skills: skillPlans.map(({ skill, description }) => ({
        skillId: skill.skillId,
        name: skill.name,
        version: Number(skill.version) || 0,
        contentHash: description.contentHash,
      })),
      mcpServers: serverPlans.map((server) => ({ id: server.id, contentHash: server.contentHash })),
      mcpTools,
    };
    validatePreparedResources(hook, resources);
    preparedPlans.set(resources, {
      hookId: hook.id,
      hookVersion: Number(hook.version) || 0,
      skillPlans,
      serverPlans,
    });
    return resources;
  }

  async function materializeHook({ hook, workspacePath, preparedResources = null }) {
    if (!hook?.id) throw createResourceError('Hook is required');
    const requestedWorkspacePath = String(workspacePath || '').trim();
    if (!requestedWorkspacePath || !path.isAbsolute(requestedWorkspacePath)) {
      throw createResourceError('Workspace path must be absolute', 500);
    }
    const resources = preparedResources || await prepareHook({ hook });
    const plan = preparedPlans.get(resources);
    if (
      !plan
      || plan.hookId !== hook.id
      || plan.hookVersion !== (Number(hook.version) || 0)
    ) {
      throw createResourceError('Prepared Hook resources do not match this Hook');
    }
    // Re-run the cheap comparison immediately before the first workspace write.
    // The prepared plan contains the exact Skill bytes and MCP configuration that
    // passed validation, so later source changes cannot alter this installation.
    validatePreparedResources(hook, resources);
    const workspaceRoot = path.resolve(requestedWorkspacePath);
    await ensureHookConfigRoot(workspaceRoot);

    const skills = [];
    for (const { skill, description } of plan.skillPlans) {
      skills.push(await materializeSkill({ workspaceRoot, skill, description }));
    }
    const mcpServers = [];
    for (const server of plan.serverPlans) {
      mcpServers.push(await materializeMcpManifest({ workspaceRoot, server }));
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
    return {
      root: path.join(workspaceRoot, HOOK_CONFIG_DIRECTORY),
      skills,
      mcpServers,
      mcpTools: resources.mcpTools,
    };
  }

  async function materializeHooks({ hooks, workspacePath }) {
    const results = [];
    for (const hook of hooks || []) results.push(await materializeHook({ hook, workspacePath }));
    return results;
  }

  return { prepareHook, materializeHook, materializeHooks, resolveActionMcpServerIds };
}

export const hookWorkspaceResourcesService = createHookWorkspaceResourcesService();

export { HOOK_CONFIG_DIRECTORY };
