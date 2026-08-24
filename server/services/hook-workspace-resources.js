import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { loadBuiltinHookSkill } from './hook-builtin-skills.js';
import { hookMcpCatalogService } from './hook-mcp-catalog.js';

const HOOK_CONFIG_DIRECTORY = path.join('.cloudcli', 'hook-config');
const MAX_SKILL_FILES = 512;
const MAX_SKILL_BYTES = 32 * 1024 * 1024;

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
  try {
    const stat = await fs.lstat(manifestPath);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      return { ...skill, contentHash: description.contentHash, hostDirectory: targetDirectory };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await fs.mkdir(skillRoot, { recursive: true, mode: 0o755 });
  const stagingDirectory = path.join(skillRoot, `.staging-${crypto.randomUUID()}`);
  await fs.mkdir(stagingDirectory, { mode: 0o755 });
  try {
    for (const file of description.files) {
      const destination = path.join(stagingDirectory, file.relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
      await fs.copyFile(file.absolutePath, destination);
      await fs.chmod(destination, file.mode).catch(() => {});
    }
    await fs.writeFile(path.join(stagingDirectory, '.ccui-resource.json'), `${JSON.stringify({
      type: 'hook-skill',
      skillId: skill.skillId,
      skillName: skill.name,
      contentHash: description.contentHash,
      fileCount: description.files.length,
      totalBytes: description.totalBytes,
      materializedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o644 });
    try {
      await fs.rename(stagingDirectory, targetDirectory);
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
    }
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
  }
  return { ...skill, contentHash: description.contentHash, hostDirectory: targetDirectory };
}

function resolveActionMcpServerIds(hook, catalog) {
  const serverIds = new Set();
  for (const action of hook?.postActions || []) {
    if (action.type === 'invoke_skill') {
      for (const serverId of action.config?.mcpServerIds || []) serverIds.add(String(serverId));
      continue;
    }
    if (action.type !== 'call_mcp_tool') continue;
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
  await fs.mkdir(serverDirectory, { recursive: true, mode: 0o755 });
  if (server.helperScript?.content) {
    const helperPath = path.join(serverDirectory, safeSegment(server.helperScript.fileName, 'headers-helper'));
    await fs.writeFile(helperPath, server.helperScript.content, { mode: 0o755 });
    await fs.chmod(helperPath, 0o755).catch(() => {});
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
  })}\n`, { mode: 0o644 });
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
    await fs.mkdir(hookDirectory, { recursive: true, mode: 0o755 });
    await fs.writeFile(path.join(hookDirectory, `${safeSegment(hook.id, 'hook')}.json`), `${stableJson({
      hookId: hook.id,
      hookVersion: hook.version,
      skillResources: skills.map((skill) => ({ skillId: skill.skillId, contentHash: skill.contentHash })),
      mcpResources: mcpServers.map((server) => ({ id: server.id, contentHash: server.contentHash })),
      materializedAt: new Date().toISOString(),
    })}\n`, { mode: 0o644 });
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
