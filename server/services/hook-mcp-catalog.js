import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appConfigDb } from '../database/db.js';

import {
  materializeMcpHelperConfig,
  normalizeUploadedHelperScript,
} from './mcp-helper-scripts.js';
import {
  probeHttpMcpServer,
  rewriteLocalHttpMcpServerForDocker,
} from './workspace-tools.js';

const CONFIG_KEY = 'hook.mcp_servers.v1';
const SERVER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const MAX_SERVERS = 50;

function stableServerId(name) {
  return `hook-mcp-${crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 16)}`;
}

export function buildHookMcpRuntimeAlias(serverId) {
  const suffix = String(serverId || '').replace(/[^a-zA-Z0-9-]/g, '').slice(-16) || 'unknown';
  return `ccui-hook-mcp-${suffix}`;
}

function withServerIdentity(server) {
  const id = typeof server?.id === 'string' && server.id.trim()
    ? server.id.trim()
    : stableServerId(server?.name);
  const hashPayload = JSON.stringify({
    id,
    name: server?.name || '',
    config: server?.config || {},
    helperSha256: server?.helperScript?.sha256 || null,
    helperContent: server?.helperScript?.sha256 ? null : server?.helperScript?.content || null,
  });
  return {
    ...server,
    id,
    contentHash: crypto.createHash('sha256').update(hashPayload).digest('hex'),
  };
}

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireString(value, name, { max = 500 } = {}) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw createHttpError(`${name} is required`);
  if (normalized.length > max) throw createHttpError(`${name} is too long`);
  return normalized;
}

function normalizeServerName(value) {
  const name = requireString(value, 'name', { max: 80 });
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw createHttpError('name must use letters, numbers, dots, underscores, or hyphens');
  }
  return name;
}

function normalizeUrl(value) {
  const url = requireString(value, 'url', { max: 2_048 });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw createHttpError('url must be a valid HTTP URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createHttpError('url must start with http:// or https://');
  }
  return url;
}

function normalizeHeaders(value) {
  if (value == null || value === '') return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createHttpError('headers must be an object');
  }
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = requireString(rawName, 'header name', { max: 200 });
    if (rawValue == null || String(rawValue).trim() === '') continue;
    headers[name] = String(rawValue);
  }
  return headers;
}

function normalizeHeadersHelper(value) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') throw createHttpError('headersHelper must be a string');
  const helper = value.trim();
  if (!helper) return undefined;
  if (helper.length > 4_000) throw createHttpError('headersHelper is too long');
  return helper;
}

function normalizeHelperEnv(value) {
  if (value == null || value === '') return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createHttpError('helperEnv must be an object');
  }
  const helperEnv = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = requireString(rawName, 'helper environment variable name', { max: 200 });
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw createHttpError('helperEnv names must use shell-safe environment variable syntax');
    }
    if (rawValue == null || String(rawValue).trim() === '') continue;
    helperEnv[name] = String(rawValue);
  }
  return Object.keys(helperEnv).length > 0 ? helperEnv : undefined;
}

function normalizeInput(input = {}) {
  const config = input.config && typeof input.config === 'object' && !Array.isArray(input.config)
    ? input.config
    : input;
  const headersHelper = normalizeHeadersHelper(config.headersHelper);
  const helperEnv = normalizeHelperEnv(config.helperEnv);
  return {
    name: normalizeServerName(input.name ?? config.name),
    displayName: requireString(input.displayName ?? input.display_name, 'displayName', { max: 120 }),
    description: typeof input.description === 'string' ? input.description.trim().slice(0, 1_000) : '',
    config: {
      type: 'http',
      url: normalizeUrl(config.url),
      headers: normalizeHeaders(config.headers),
      ...(headersHelper ? { headersHelper } : {}),
      ...(helperEnv ? { helperEnv } : {}),
      alwaysLoad: true,
    },
  };
}

function parseServers(configStore) {
  try {
    const value = JSON.parse(configStore.get(CONFIG_KEY) || '[]');
    return Array.isArray(value)
      ? value.filter((server) => server && typeof server === 'object').map(withServerIdentity)
      : [];
  } catch {
    return [];
  }
}

function saveServers(configStore, servers) {
  configStore.set(CONFIG_KEY, JSON.stringify(servers.map(({ contentHash: _contentHash, ...server }) => server)));
}

function toPublicServer(server) {
  return {
    id: server.id,
    name: server.name,
    displayName: server.displayName,
    description: server.description || '',
    config: server.config,
    lastTestStatus: server.lastTestStatus || null,
    lastTestError: server.lastTestError || null,
    lastTestedAt: server.lastTestedAt || null,
    toolCount: Number(server.toolCount || 0),
    tools: Array.isArray(server.tools) ? server.tools : [],
    helperScript: server.helperScript ? {
      fileName: server.helperScript.fileName,
      sizeBytes: Number(server.helperScript.sizeBytes || 0),
      sha256: server.helperScript.sha256,
      updatedAt: server.helperScript.updatedAt || null,
    } : null,
    contentHash: server.contentHash,
    runtimeAlias: buildHookMcpRuntimeAlias(server.id),
    createdByUserId: server.createdByUserId || null,
    updatedByUserId: server.updatedByUserId || null,
    createdAt: server.createdAt || null,
    updatedAt: server.updatedAt || null,
  };
}

export function createHookMcpCatalogService({
  configStore = appConfigDb,
  probe = probeHttpMcpServer,
  materializeHelper = materializeMcpHelperConfig,
  fsImpl = fs,
  temporaryRoot = os.tmpdir(),
  now = () => new Date().toISOString(),
} = {}) {
  function listServers() {
    return parseServers(configStore)
      .map(toPublicServer)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  function createServer({ input, userId } = {}) {
    const normalized = normalizeInput(input);
    const servers = parseServers(configStore);
    if (servers.some((server) => server.name === normalized.name)) {
      throw createHttpError(`Hook MCP server ${normalized.name} already exists`, 409);
    }
    if (servers.length >= MAX_SERVERS) throw createHttpError(`Hook MCP supports at most ${MAX_SERVERS} servers`);
    const timestamp = now();
    const server = {
      ...normalized,
      id: stableServerId(normalized.name),
      lastTestStatus: null,
      lastTestError: null,
      lastTestedAt: null,
      toolCount: 0,
      tools: [],
      createdByUserId: Number(userId) || null,
      updatedByUserId: Number(userId) || null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const identified = withServerIdentity(server);
    saveServers(configStore, [...servers, identified]);
    return toPublicServer(identified);
  }

  function updateServer({ serverName, input, userId } = {}) {
    const normalizedServerName = normalizeServerName(serverName);
    const normalized = normalizeInput({ ...input, name: input?.name || normalizedServerName });
    if (normalized.name !== normalizedServerName) throw createHttpError('Hook MCP server name cannot be changed');
    const servers = parseServers(configStore);
    const index = servers.findIndex((server) => server.name === normalizedServerName);
    if (index < 0) throw createHttpError('Hook MCP server not found', 404);
    const server = withServerIdentity({
      ...servers[index],
      ...normalized,
      lastTestStatus: null,
      lastTestError: null,
      lastTestedAt: null,
      toolCount: 0,
      tools: [],
      updatedByUserId: Number(userId) || null,
      updatedAt: now(),
    });
    servers[index] = server;
    saveServers(configStore, servers);
    return toPublicServer(server);
  }

  async function testServer({ serverName, userId } = {}) {
    const normalizedServerName = normalizeServerName(serverName);
    const servers = parseServers(configStore);
    const index = servers.findIndex((server) => server.name === normalizedServerName);
    if (index < 0) throw createHttpError('Hook MCP server not found', 404);
    const testedAt = now();
    const probeDirectory = await fsImpl.mkdtemp(path.join(temporaryRoot, 'ccui-hook-mcp-probe-'));
    let result;
    try {
      const config = await materializeHelper({
        config: { name: normalizedServerName, ...servers[index].config },
        helperScript: servers[index].helperScript || null,
        hostDirectory: path.join(probeDirectory, normalizedServerName),
        commandDirectory: path.join(probeDirectory, normalizedServerName),
        fsImpl,
      });
      result = await probe(config);
    } finally {
      await fsImpl.rm(probeDirectory, { recursive: true, force: true }).catch(() => {});
    }
    const healthy = result?.status === 'healthy';
    const server = withServerIdentity({
      ...servers[index],
      lastTestStatus: healthy ? 'healthy' : 'failed',
      lastTestError: healthy ? null : String(result?.error || 'MCP probe failed').slice(0, 4_000),
      lastTestedAt: testedAt,
      toolCount: healthy ? Number(result.toolCount || 0) : 0,
      tools: healthy && Array.isArray(result.tools) ? result.tools : [],
      updatedByUserId: Number(userId) || null,
      updatedAt: testedAt,
    });
    servers[index] = server;
    saveServers(configStore, servers);
    return toPublicServer(server);
  }

  function deleteServer({ serverName } = {}) {
    const normalizedServerName = normalizeServerName(serverName);
    const servers = parseServers(configStore);
    const server = servers.find((candidate) => candidate.name === normalizedServerName);
    if (!server) throw createHttpError('Hook MCP server not found', 404);
    saveServers(configStore, servers.filter((candidate) => candidate.name !== normalizedServerName));
    return toPublicServer(server);
  }

  function updateHelperScriptState(server, helperScript, userId) {
    return {
      ...server,
      helperScript,
      lastTestStatus: null,
      lastTestError: null,
      lastTestedAt: null,
      toolCount: 0,
      tools: [],
      updatedByUserId: Number(userId) || null,
      updatedAt: now(),
    };
  }

  function uploadHelperScript({ serverName, userId, originalName, content } = {}) {
    const normalizedServerName = normalizeServerName(serverName);
    const servers = parseServers(configStore);
    const index = servers.findIndex((server) => server.name === normalizedServerName);
    if (index < 0) throw createHttpError('Hook MCP server not found', 404);
    const script = normalizeUploadedHelperScript({ originalName, content });
    const timestamp = now();
    servers[index] = withServerIdentity(updateHelperScriptState(servers[index], {
      ...script,
      sha256: crypto.createHash('sha256').update(script.content).digest('hex'),
      uploadedByUserId: Number(userId) || null,
      updatedAt: timestamp,
    }, userId));
    saveServers(configStore, servers);
    return toPublicServer(servers[index]);
  }

  function deleteHelperScript({ serverName, userId } = {}) {
    const normalizedServerName = normalizeServerName(serverName);
    const servers = parseServers(configStore);
    const index = servers.findIndex((server) => server.name === normalizedServerName);
    if (index < 0) throw createHttpError('Hook MCP server not found', 404);
    servers[index] = withServerIdentity(updateHelperScriptState(servers[index], null, userId));
    saveServers(configStore, servers);
    return toPublicServer(servers[index]);
  }

  async function getRuntimeConfig({
    serverIds = null,
    hostDirectory = null,
    commandDirectory = hostDirectory,
    runtimeMode = 'local',
    runtimeOwner = null,
  } = {}) {
    const requestedIds = Array.isArray(serverIds) ? new Set(serverIds.map(String)) : null;
    const servers = parseServers(configStore).filter((server) => !requestedIds || requestedIds.has(server.id));
    if (requestedIds && servers.length !== requestedIds.size) {
      throw createHttpError('One or more Hook MCP servers are unavailable', 409);
    }
    const runtimeConfigs = [];
    for (const server of servers) {
      const hasPrivateHelper = Boolean(server.helperScript)
        || Boolean(server.config?.helperEnv && Object.keys(server.config.helperEnv).length > 0);
      if (server.config?.headersHelper && hasPrivateHelper && (!hostDirectory || !commandDirectory)) {
        throw createHttpError('Hook MCP helper runtime directory is required', 500);
      }
      const runtimeServerConfig = runtimeMode === 'docker'
        ? rewriteLocalHttpMcpServerForDocker(server.config)
        : server.config;
      const resourceSegments = [server.id, server.contentHash];
      const helperConfig = {
        ...runtimeServerConfig,
        // Hook MCP helpers intentionally inherit the active user's runtime
        // environment. Static helperEnv values would otherwise be written to
        // the workspace cache as a shell file.
        helperEnv: undefined,
      };
      const config = await materializeHelper({
        config: helperConfig,
        helperScript: server.helperScript || null,
        hostDirectory: hostDirectory ? path.join(hostDirectory, ...resourceSegments) : null,
        commandDirectory: commandDirectory
          ? (runtimeMode === 'docker'
              ? path.posix.join(commandDirectory, ...resourceSegments)
              : path.join(commandDirectory, ...resourceSegments))
          : null,
        runtimeMode,
        runtimeOwner,
        fsImpl,
      });
      const runtimeAlias = buildHookMcpRuntimeAlias(server.id);
      runtimeConfigs.push([runtimeAlias, config]);
    }
    return {
      mcpServers: Object.fromEntries(runtimeConfigs),
      toolNames: servers.flatMap((server) => (
        Array.isArray(server.tools)
          ? server.tools
            .map((tool) => String(tool?.name || '').trim())
            .filter(Boolean)
            .map((toolName) => `mcp__${buildHookMcpRuntimeAlias(server.id)}__${toolName}`)
          : []
      )),
    };
  }

  return {
    listServers,
    createServer,
    updateServer,
    testServer,
    deleteServer,
    uploadHelperScript,
    deleteHelperScript,
    getRuntimeConfig,
    getServerById: (serverId) => {
      const server = parseServers(configStore).find((candidate) => candidate.id === String(serverId));
      return server ? { ...server } : null;
    },
    getServerByName: (serverName) => {
      const server = parseServers(configStore).find((candidate) => candidate.name === String(serverName));
      return server ? { ...server } : null;
    },
    listToolResources: () => parseServers(configStore).flatMap((server) => (
      Array.isArray(server.tools) ? server.tools.map((tool) => ({
        name: `mcp__${server.name}__${String(tool?.name || '').trim()}`,
        mcpServerId: server.id,
        serverName: server.name,
        serverDisplayName: server.displayName,
        runtimeAlias: buildHookMcpRuntimeAlias(server.id),
        toolName: String(tool?.name || '').trim(),
        description: typeof tool?.description === 'string' ? tool.description : server.description || '',
        inputSchema: tool?.inputSchema && typeof tool.inputSchema === 'object'
          ? tool.inputSchema
          : { type: 'object', properties: {} },
        tenantCodes: [],
        source: 'hook',
      })).filter((tool) => tool.toolName) : []
    )),
  };
}

export const hookMcpCatalogService = createHookMcpCatalogService();
