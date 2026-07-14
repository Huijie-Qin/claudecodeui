import { execFile } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const EMPTY_MCP_CONFIG = Object.freeze({ mcpServers: {} });
const EMPTY_STATUS = Object.freeze({ version: 1, servers: {} });
const EMPTY_DRAFTS = Object.freeze({ version: 1, drafts: {} });
const HTTP_TIMEOUT_MS = 10_000;
const HEADER_HELPER_TIMEOUT_MS = 10_000;
const HEADER_HELPER_MAX_BUFFER_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);
const mcpStatusCache = new Map();
const DOCKER_HOST_MCP_HOSTNAME = 'host.docker.internal';
const HOST_LOOPBACK_MCP_HOSTNAME = '127.0.0.1';
const DOCKER_LOCAL_MCP_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);
const HOST_SHELL_COMMAND = process.platform === 'win32'
  ? (process.env.ComSpec || 'cmd.exe')
  : '/bin/sh';
const HOST_SHELL_ARGS = process.platform === 'win32'
  ? ['/d', '/c']
  : ['-lc'];

const BUILT_IN_TOOLS = Object.freeze([
  {
    id: 'builtin.read',
    name: 'read',
    displayName: 'Read',
    description: 'Read files inside the selected workspace.',
  },
  {
    id: 'builtin.write',
    name: 'write',
    displayName: 'Write',
    description: 'Create and update files when workspace permissions allow edits.',
  },
  {
    id: 'builtin.search',
    name: 'search',
    displayName: 'Search',
    description: 'Search workspace files and code symbols.',
  },
  {
    id: 'builtin.terminal',
    name: 'terminal',
    displayName: 'Terminal',
    description: 'Run workspace commands through the configured agent runtime.',
  },
]);

function redactProbeLogValue(value) {
  return String(value || '')
    .replace(/security:[0-9a-f:]+/gi, 'security:[redacted]')
    .replace(/\b[0-9a-f]{64}\b/gi, '[hex64-redacted]')
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]');
}

function probeLogSnippet(value) {
  const redacted = redactProbeLogValue(value);
  return redacted.length > 300 ? `${redacted.slice(0, 300)}...` : redacted;
}

function logMcpProbe(event, details = {}) {
  console.log(`[MCP Probe] ${event}`, details);
}

function summarizeProbeConfig(config = {}) {
  return {
    name: config.name || null,
    url: config.url || null,
    hasHeadersHelper: typeof config.headersHelper === 'string' && config.headersHelper.trim() !== '',
    staticHeaderKeys: config.headers && typeof config.headers === 'object'
      ? Object.keys(config.headers)
      : [],
  };
}

export function getWorkspaceToolsPaths(workspacePath) {
  return {
    mcpConfigPath: path.join(workspacePath, '.mcp.json'),
    statusPath: path.join(workspacePath, '.cloudcli', 'mcp', 'status.json'),
    draftsPath: path.join(workspacePath, '.cloudcli', 'mcp', 'drafts.json'),
  };
}

export async function readWorkspaceMcpConfig(workspacePath) {
  const { mcpConfigPath } = getWorkspaceToolsPaths(workspacePath);
  try {
    const parsed = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8'));
    return normalizeMcpConfig(parsed);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ...EMPTY_MCP_CONFIG, mcpServers: {} };
    }
    throw error;
  }
}

export async function writeWorkspaceMcpConfig(workspacePath, config, { env = process.env } = {}) {
  const { mcpConfigPath } = getWorkspaceToolsPaths(workspacePath);
  const normalized = normalizeWorkspaceMcpConfigForRuntime(config, { env });
  if (Object.keys(normalized.mcpServers).length === 0) {
    await removeJsonFile(mcpConfigPath);
    return;
  }
  await writeJsonFile(mcpConfigPath, normalized);
}

export async function readMcpStatus(workspacePath) {
  const cached = mcpStatusCache.get(getMcpStatusCacheKey(workspacePath));
  return cached ? cloneStatus(cached) : { ...EMPTY_STATUS, servers: {} };
}

export async function writeMcpStatus(workspacePath, status) {
  const normalized = normalizeStatus(status);
  if (Object.keys(normalized.servers).length === 0) {
    mcpStatusCache.delete(getMcpStatusCacheKey(workspacePath));
    return;
  }
  mcpStatusCache.set(getMcpStatusCacheKey(workspacePath), cloneStatus(normalized));
}

export async function readMcpDrafts(workspacePath) {
  const { draftsPath } = getWorkspaceToolsPaths(workspacePath);
  try {
    const parsed = JSON.parse(await fs.readFile(draftsPath, 'utf8'));
    return normalizeDrafts(parsed);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ...EMPTY_DRAFTS, drafts: {} };
    }
    throw error;
  }
}

export async function writeMcpDrafts(workspacePath, drafts) {
  const { draftsPath } = getWorkspaceToolsPaths(workspacePath);
  const normalized = normalizeDrafts(drafts);
  if (Object.keys(normalized.drafts).length === 0) {
    await removeJsonFile(draftsPath, { workspacePath });
    return;
  }
  await writeJsonFile(draftsPath, normalized);
}

export async function listWorkspaceTools(workspacePath, { accessRole = 'view' } = {}) {
  const [mcpConfig, status, drafts] = await Promise.all([
    readWorkspaceMcpConfig(workspacePath),
    readMcpStatus(workspacePath),
    readMcpDrafts(workspacePath),
  ]);
  const canManage = accessRole === 'owner' || accessRole === 'edit';
  const builtInTools = BUILT_IN_TOOLS.map((tool) => ({
    ...tool,
    type: 'builtin',
    category: 'workspace',
    status: canManage ? 'available' : 'read_only',
    permission: canManage ? 'workspace-edit' : 'workspace-view',
    manageable: false,
  }));
  const mcpServers = listMcpServersFromConfig(mcpConfig, status, drafts);
  const tools = sortTools([...builtInTools, ...mcpServers]);

  return {
    tools,
    mcpServers,
    summary: summarizeTools(tools),
  };
}

export async function probeWorkspaceMcpServer({
  workspacePath,
  server,
  now = () => new Date(),
  probe = probeHttpMcpServer,
  env = process.env,
}) {
  const normalized = normalizeHttpMcpInput(server, { allowDraft: false });
  const runtimeConfig = normalizeMcpServerConfigForProbeRuntime(normalized.config, { env });
  const result = await probe({ ...runtimeConfig, name: normalized.name });
  const checkedAt = now().toISOString();
  const entry = {
    ...result,
    name: normalized.name,
    checkedAt,
  };
  const status = await readMcpStatus(workspacePath);
  await writeMcpStatus(workspacePath, {
    version: 1,
    servers: {
      ...status.servers,
      [normalized.name]: entry,
    },
  });

  return entry;
}

export async function upsertWorkspaceMcpServer({
  workspacePath,
  server,
  now = () => new Date(),
  probe = probeHttpMcpServer,
  env = process.env,
}) {
  const normalized = normalizeHttpMcpInput(server, { allowDraft: true });
  const timestamp = now().toISOString();

  if (normalized.missingValues.length > 0) {
    const drafts = await readMcpDrafts(workspacePath);
    const draft = {
      name: normalized.name,
      status: 'needs_value',
      missingValues: normalized.missingValues,
      config: normalized.config,
      createdAt: firstString(drafts.drafts?.[normalized.name]?.createdAt) || timestamp,
      updatedAt: timestamp,
    };
    await writeMcpDrafts(workspacePath, {
      version: 1,
      drafts: {
        ...drafts.drafts,
        [normalized.name]: draft,
      },
    });
    return {
      savedAsDraft: true,
      server: toDraftTool(draft),
      probe: null,
    };
  }

  const runtimeConfig = normalizeMcpServerConfigForProbeRuntime(normalized.config, { env });
  const probeResult = await probe({ ...runtimeConfig, name: normalized.name });
  if (probeResult.status !== 'healthy') {
    const status = await readMcpStatus(workspacePath);
    await writeMcpStatus(workspacePath, {
      version: 1,
      servers: {
        ...status.servers,
        [normalized.name]: {
          ...probeResult,
          name: normalized.name,
          checkedAt: timestamp,
        },
      },
    });
    throw createHttpError(probeResult.error || 'MCP probe failed', 400, {
      code: 'MCP_PROBE_FAILED',
      details: probeResult,
    });
  }

  const [config, status, drafts] = await Promise.all([
    readWorkspaceMcpConfig(workspacePath),
    readMcpStatus(workspacePath),
    readMcpDrafts(workspacePath),
  ]);
  const nextDrafts = { ...drafts.drafts };
  delete nextDrafts[normalized.name];

  await Promise.all([
    writeWorkspaceMcpConfig(workspacePath, {
      ...config,
      mcpServers: {
        ...config.mcpServers,
        [normalized.name]: normalized.config,
      },
    }),
    writeMcpStatus(workspacePath, {
      version: 1,
      servers: {
        ...status.servers,
        [normalized.name]: {
          ...probeResult,
          name: normalized.name,
          checkedAt: timestamp,
        },
      },
    }),
    writeMcpDrafts(workspacePath, {
      version: 1,
      drafts: nextDrafts,
    }),
  ]);

  return {
    savedAsDraft: false,
    server: toMcpTool(normalized.name, normalized.config, {
      ...probeResult,
      name: normalized.name,
      checkedAt: timestamp,
    }),
    probe: {
      ...probeResult,
      name: normalized.name,
      checkedAt: timestamp,
    },
  };
}

export async function removeWorkspaceMcpServer({ workspacePath, name }) {
  const serverName = normalizeServerName(name);
  const [config, status, drafts] = await Promise.all([
    readWorkspaceMcpConfig(workspacePath),
    readMcpStatus(workspacePath),
    readMcpDrafts(workspacePath),
  ]);
  const nextServers = { ...config.mcpServers };
  const nextStatus = { ...status.servers };
  const nextDrafts = { ...drafts.drafts };
  const removed = Object.prototype.hasOwnProperty.call(nextServers, serverName)
    || Object.prototype.hasOwnProperty.call(nextDrafts, serverName);

  delete nextServers[serverName];
  delete nextStatus[serverName];
  delete nextDrafts[serverName];

  await Promise.all([
    writeWorkspaceMcpConfig(workspacePath, { ...config, mcpServers: nextServers }),
    writeMcpStatus(workspacePath, { version: 1, servers: nextStatus }),
    writeMcpDrafts(workspacePath, { version: 1, drafts: nextDrafts }),
  ]);

  return { removed, name: serverName };
}

export function previewMcpJsonImport({ json, existingNames = [] }) {
  const parsed = parseImportJson(json);
  const existing = new Set(existingNames.map((name) => normalizeServerName(name)));
  const servers = readPlainObject(parsed.mcpServers) || readPlainObject(parsed);

  if (!servers || Object.keys(servers).length === 0) {
    throw createHttpError('JSON import must include at least one MCP server', 400);
  }

  const entries = Object.entries(servers).map(([name, value]) => classifyImportEntry(name, value, existing));
  const summary = {
    total: entries.length,
    ready: entries.filter((entry) => entry.status === 'ready').length,
    needsValue: entries.filter((entry) => entry.status === 'needs_value').length,
    unsupported: entries.filter((entry) => entry.status === 'unsupported').length,
    invalid: entries.filter((entry) => entry.status === 'invalid').length,
    conflicts: entries.filter((entry) => entry.conflict).length,
  };

  return { entries, summary };
}

export async function previewWorkspaceMcpJsonImport({ workspacePath, json }) {
  const [config, drafts] = await Promise.all([
    readWorkspaceMcpConfig(workspacePath),
    readMcpDrafts(workspacePath),
  ]);
  return previewMcpJsonImport({
    json,
    existingNames: [
      ...Object.keys(config.mcpServers),
      ...Object.keys(drafts.drafts),
    ],
  });
}

export async function probeHttpMcpServer(config, {
  fetchImpl = fetch,
  timeoutMs = HTTP_TIMEOUT_MS,
} = {}) {
  const startedAt = Date.now();
  const initializePayload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'CloudCLI',
        version: '1.0.0',
      },
    },
  };

  try {
    const normalized = normalizeHttpConfig(config);
    logMcpProbe('start', summarizeProbeConfig(normalized));
    const requestHeaders = await resolveRequestHeaders(normalized);
    logMcpProbe('headers_ready', {
      name: normalized.name || null,
      url: normalized.url,
      headerKeys: Object.keys(requestHeaders),
    });
    const initialize = await postJsonRpc({
      fetchImpl,
      timeoutMs,
      url: normalized.url,
      headers: requestHeaders,
      payload: initializePayload,
    });
    const sessionId = initialize.headers.get('mcp-session-id') || initialize.headers.get('Mcp-Session-Id');
    logMcpProbe('initialize_response', {
      name: normalized.name || null,
      url: normalized.url,
      httpStatus: initialize.httpStatus,
      ok: initialize.ok,
      hasRpcError: Boolean(initialize.body?.error),
      hasSessionId: Boolean(sessionId),
    });

    if (initialize.httpStatus === 401 || initialize.httpStatus === 403) {
      return failedProbe('auth', `HTTP ${initialize.httpStatus}`, startedAt);
    }
    if (!initialize.ok) {
      return failedProbe('initialize', `Initialize failed with HTTP ${initialize.httpStatus}`, startedAt);
    }
    if (initialize.body?.error) {
      return failedProbe('initialize', readRpcError(initialize.body.error), startedAt);
    }

    await postJsonRpc({
      fetchImpl,
      timeoutMs,
      url: normalized.url,
      headers: sessionId
        ? { ...requestHeaders, 'Mcp-Session-Id': sessionId }
        : requestHeaders,
      payload: {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      },
    }).catch((error) => {
      logMcpProbe('initialized_notification_failed', {
        name: normalized.name || null,
        url: normalized.url,
        error: error?.message || 'request failed',
      });
    });

    const toolsList = await postJsonRpc({
      fetchImpl,
      timeoutMs,
      url: normalized.url,
      headers: sessionId
        ? { ...requestHeaders, 'Mcp-Session-Id': sessionId }
        : requestHeaders,
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      },
    });
    logMcpProbe('tools_list_response', {
      name: normalized.name || null,
      url: normalized.url,
      httpStatus: toolsList.httpStatus,
      ok: toolsList.ok,
      hasRpcError: Boolean(toolsList.body?.error),
    });

    if (toolsList.httpStatus === 401 || toolsList.httpStatus === 403) {
      return failedProbe('auth', `HTTP ${toolsList.httpStatus}`, startedAt);
    }
    if (!toolsList.ok) {
      return failedProbe('tools_list', `Tools list failed with HTTP ${toolsList.httpStatus}`, startedAt);
    }
    if (toolsList.body?.error) {
      return failedProbe('tools_list', readRpcError(toolsList.body.error), startedAt);
    }

    const tools = normalizeProbeTools(toolsList.body?.result?.tools);
    logMcpProbe('complete', {
      name: normalized.name || null,
      url: normalized.url,
      status: 'healthy',
      toolCount: tools.length,
      latencyMs: Date.now() - startedAt,
    });
    return {
      status: 'healthy',
      phase: 'tools_list',
      error: '',
      latencyMs: Date.now() - startedAt,
      toolCount: tools.length,
      tools,
    };
  } catch (error) {
    logMcpProbe('failed', {
      name: config?.name || null,
      url: config?.url || null,
      statusCode: error?.statusCode || null,
      error: error?.message || 'Network probe failed',
    });
    if (error?.statusCode) {
      return failedProbe('static_validation', error.message, startedAt);
    }
    return failedProbe('network', error?.message || 'Network probe failed', startedAt);
  }
}

function listMcpServersFromConfig(mcpConfig, status, drafts) {
  const configured = Object.entries(mcpConfig.mcpServers).map(([name, rawConfig]) =>
    toMcpTool(name, rawConfig, status.servers?.[name]),
  );
  const configuredNames = new Set(configured.map((server) => server.name));
  const draftServers = Object.entries(drafts.drafts)
    .filter(([name]) => !configuredNames.has(name))
    .map(([, draft]) => toDraftTool(draft));

  return sortTools([...configured, ...draftServers]);
}

function toMcpTool(name, rawConfig, cachedStatus) {
  const transport = detectTransport(rawConfig);
  const isHttp = transport === 'http';
  const normalizedStatus = normalizeProbeStatus(cachedStatus);
  const unsupported = !isHttp;
  const toolStatus = unsupported
    ? 'unsupported'
    : normalizedStatus?.status === 'healthy'
      ? 'healthy'
      : normalizedStatus?.status === 'probe_failed'
        ? 'probe_failed'
        : 'unverified';

  return pruneUndefined({
    id: `mcp.${name}`,
    name,
    displayName: name,
    description: isHttp ? firstString(rawConfig?.url) : 'Only HTTP MCP servers can be managed here.',
    type: 'mcp',
    category: 'mcp',
    source: 'project-mcp',
    transport,
    status: toolStatus,
    manageable: isHttp,
    url: firstString(rawConfig?.url),
    headers: readStringRecord(rawConfig?.headers),
    headersHelper: firstString(rawConfig?.headersHelper) || undefined,
    config: sanitizeConfigForUi(rawConfig),
    probe: normalizedStatus,
    tools: normalizedStatus?.tools,
    toolCount: normalizedStatus?.toolCount,
  });
}

function toDraftTool(draft) {
  return pruneUndefined({
    id: `mcp.${draft.name}`,
    name: draft.name,
    displayName: draft.name,
    description: 'Complete missing values before writing this server to .mcp.json.',
    type: 'mcp',
    category: 'mcp',
    source: 'draft',
    transport: 'http',
    status: 'needs_value',
    manageable: true,
    missingValues: Array.isArray(draft.missingValues) ? draft.missingValues : [],
    url: firstString(draft.config?.url),
    headers: readStringRecord(draft.config?.headers),
    headersHelper: firstString(draft.config?.headersHelper) || undefined,
    config: sanitizeConfigForUi(draft.config),
    createdAt: firstString(draft.createdAt),
    updatedAt: firstString(draft.updatedAt),
  });
}

function normalizeHttpMcpInput(server, { allowDraft }) {
  const record = readPlainObject(server) || {};
  const name = normalizeServerName(record.name);
  const type = firstString(record.type || record.transport) || 'http';
  if (type !== 'http') {
    throw createHttpError('Only HTTP MCP servers are supported in Tools v1', 400);
  }

  const headers = readStringRecord(record.headers) || {};
  const missingValues = [];
  const url = firstString(record.url);
  if (!url) {
    missingValues.push('url');
  }
  for (const [key, value] of Object.entries(headers)) {
    if (!firstString(value)) {
      missingValues.push(`headers.${key}`);
    }
  }

  if (!allowDraft && missingValues.length > 0) {
    throw createHttpError(`Missing required MCP values: ${missingValues.join(', ')}`, 400);
  }
  if (url) {
    assertHttpUrl(url);
  }

  return {
    name,
    missingValues,
    config: {
      type: 'http',
      url,
      headers,
      headersHelper: firstString(record.headersHelper) || undefined,
    },
  };
}

function normalizeHttpConfig(config) {
  const record = readPlainObject(config) || {};
  const url = firstString(record.url);
  assertHttpUrl(url);
  return {
    type: 'http',
    name: firstString(record.name) || undefined,
    url,
    headers: readStringRecord(record.headers) || {},
    headersHelper: firstString(record.headersHelper) || undefined,
  };
}

async function resolveRequestHeaders(config) {
  const helperHeaders = await resolveHeadersHelper(config);
  return {
    ...config.headers,
    ...helperHeaders,
  };
}

async function resolveHeadersHelper(config) {
  if (!config.headersHelper) {
    return {};
  }

  logMcpProbe('headers_helper_start', {
    name: config.name || null,
    url: config.url || null,
    commandPresent: true,
  });
  let stdout = '';
  try {
    const result = await execFileAsync(HOST_SHELL_COMMAND, [...HOST_SHELL_ARGS, config.headersHelper], {
      timeout: HEADER_HELPER_TIMEOUT_MS,
      maxBuffer: HEADER_HELPER_MAX_BUFFER_BYTES,
      env: {
        ...process.env,
        CLAUDE_CODE_MCP_SERVER_NAME: config.name || '',
        CLAUDE_CODE_MCP_SERVER_URL: config.url || '',
      },
    });
    stdout = result.stdout;
    logMcpProbe('headers_helper_exit', {
      name: config.name || null,
      url: config.url || null,
      stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    });
  } catch (error) {
    logMcpProbe('headers_helper_failed', {
      name: config.name || null,
      url: config.url || null,
      error: describeHeadersHelperFailure(error),
    });
    throw createHttpError(describeHeadersHelperFailure(error), 400);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    logMcpProbe('headers_helper_invalid_stdout', {
      name: config.name || null,
      url: config.url || null,
      stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
      stdoutSnippet: probeLogSnippet(stdout),
    });
    throw createHttpError('headersHelper must write a valid JSON object to stdout', 400);
  }

  const record = readPlainObject(parsed);
  if (!record) {
    throw createHttpError('headersHelper must write a JSON object of string header values', 400);
  }

  const headers = {};
  for (const [key, value] of Object.entries(record)) {
    const headerName = firstString(key);
    if (!headerName || typeof value !== 'string') {
      throw createHttpError('headersHelper must write a JSON object of string header values', 400);
    }
    headers[headerName] = value;
  }
  logMcpProbe('headers_helper_parsed', {
    name: config.name || null,
    url: config.url || null,
    headerKeys: Object.keys(headers),
  });
  return headers;
}

function describeHeadersHelperFailure(error) {
  if (error?.killed || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT') {
    return 'headersHelper timed out after 10 seconds';
  }
  const stderr = firstString(error?.stderr);
  if (stderr) {
    return `headersHelper failed: ${stderr}`;
  }
  return `headersHelper failed: ${error?.message || 'command failed'}`;
}

async function postJsonRpc({ fetchImpl, timeoutMs, url, headers, payload }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      httpStatus: response.status,
      headers: response.headers,
      body: safeParseRpcBody(text, response.headers.get('content-type') || ''),
    };
  } finally {
    clearTimeout(timer);
  }
}

function safeParseRpcBody(text, contentType) {
  try {
    return parseRpcBody(text, contentType);
  } catch {
    return null;
  }
}

function parseRpcBody(text, contentType) {
  if (!text.trim()) {
    return null;
  }
  if (contentType.includes('text/event-stream')) {
    const dataLine = text.split(/\r?\n/).find((line) => line.startsWith('data:'));
    if (!dataLine) {
      return null;
    }
    return JSON.parse(dataLine.slice('data:'.length).trim());
  }
  return JSON.parse(text);
}

function normalizeProbeTools(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((tool) => {
      if (!tool || typeof tool !== 'object') return null;
      const name = firstString(tool.name);
      if (!name) return null;
      return pruneUndefined({
        name,
        description: firstString(tool.description),
        inputSchema: readPlainObject(tool.inputSchema) || readPlainObject(tool.input_schema) || readPlainObject(tool.parameters) || undefined,
      });
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function failedProbe(phase, error, startedAt) {
  return {
    status: 'probe_failed',
    phase,
    error,
    latencyMs: Date.now() - startedAt,
    toolCount: 0,
    tools: [],
  };
}

function classifyImportEntry(name, value, existing) {
  try {
    const serverName = normalizeServerName(name);
    const record = readPlainObject(value);
    if (!record) {
      return {
        name: serverName,
        status: 'invalid',
        reason: 'Server config must be an object',
        conflict: existing.has(serverName),
      };
    }

    const transport = detectTransport(record);
    if (transport !== 'http') {
      return {
        name: serverName,
        status: 'unsupported',
        transport,
        reason: 'Only HTTP MCP servers are supported in Tools v1',
        conflict: existing.has(serverName),
      };
    }

    const normalized = normalizeHttpMcpInput({ name: serverName, ...record }, { allowDraft: true });
    return pruneUndefined({
      name: serverName,
      status: normalized.missingValues.length > 0 ? 'needs_value' : 'ready',
      transport: 'http',
      url: normalized.config.url,
      headers: normalized.config.headers,
      headersHelper: normalized.config.headersHelper,
      missingValues: normalized.missingValues,
      conflict: existing.has(serverName),
    });
  } catch (error) {
    return {
      name: firstString(name) || 'unknown',
      status: 'invalid',
      reason: error?.message || 'Invalid MCP server config',
      conflict: false,
    };
  }
}

function parseImportJson(json) {
  try {
    const parsed = JSON.parse(firstString(json));
    const record = readPlainObject(parsed);
    if (!record) {
      throw createHttpError('JSON import must be an object', 400);
    }
    return record;
  } catch (error) {
    if (error?.statusCode) throw error;
    throw createHttpError('JSON import is invalid', 400);
  }
}

function normalizeMcpConfig(config) {
  return {
    ...readPlainObject(config),
    mcpServers: readPlainObject(config?.mcpServers) || {},
  };
}

function normalizeWorkspaceMcpConfigForRuntime(config, { env = process.env } = {}) {
  const normalized = normalizeMcpConfig(config);
  if (String(env.CLAUDE_EXECUTION_MODE || 'local').trim().toLowerCase() !== 'docker') {
    return normalized;
  }

  return {
    ...normalized,
    mcpServers: Object.fromEntries(
      Object.entries(normalized.mcpServers).map(([name, serverConfig]) => [
        name,
        rewriteLocalHttpMcpServerForDocker(serverConfig),
      ]),
    ),
  };
}

function normalizeMcpServerConfigForRuntime(serverConfig, { env = process.env } = {}) {
  if (String(env.CLAUDE_EXECUTION_MODE || 'local').trim().toLowerCase() !== 'docker') {
    return serverConfig;
  }
  return rewriteLocalHttpMcpServerForDocker(serverConfig);
}

export function normalizeMcpServerConfigForProbeRuntime(serverConfig, { env = process.env } = {}) {
  return resolveMcpProbeRuntime(env) === 'docker'
    ? rewriteLocalHttpMcpServerForDocker(serverConfig)
    : rewriteDockerHostHttpMcpServerForHost(serverConfig);
}

function resolveMcpProbeRuntime(env = process.env) {
  const configured = String(env.CLOUDCLI_MCP_PROBE_RUNTIME || '').trim().toLowerCase();
  if (configured === 'docker' || configured === 'container') return 'docker';
  if (configured === 'host' || configured === 'local') return 'host';
  return isRunningInsideContainer() ? 'docker' : 'host';
}

function isRunningInsideContainer() {
  if (process.platform === 'win32') return false;
  if (existsSync('/.dockerenv')) return true;
  try {
    return /docker|kubepods|containerd/i.test(readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}

function rewriteLocalHttpMcpServerForDocker(serverConfig) {
  const record = readPlainObject(serverConfig);
  const url = firstString(record?.url);
  if (!record || !url) {
    return serverConfig;
  }

  try {
    const parsed = new URL(url);
    if (!DOCKER_LOCAL_MCP_HOSTNAMES.has(parsed.hostname)) {
      return serverConfig;
    }
    parsed.hostname = DOCKER_HOST_MCP_HOSTNAME;
    return {
      ...record,
      url: parsed.toString(),
    };
  } catch {
    return serverConfig;
  }
}

function rewriteDockerHostHttpMcpServerForHost(serverConfig) {
  const record = readPlainObject(serverConfig);
  const url = firstString(record?.url);
  if (!record || !url) {
    return serverConfig;
  }

  try {
    const parsed = new URL(url);
    if (parsed.hostname !== DOCKER_HOST_MCP_HOSTNAME) {
      return serverConfig;
    }
    parsed.hostname = HOST_LOOPBACK_MCP_HOSTNAME;
    return {
      ...record,
      url: parsed.toString(),
    };
  } catch {
    return serverConfig;
  }
}

function normalizeStatus(status) {
  return {
    version: 1,
    servers: readPlainObject(status?.servers) || {},
  };
}

function getMcpStatusCacheKey(workspacePath) {
  return path.resolve(String(workspacePath || ''));
}

function cloneStatus(status) {
  return JSON.parse(JSON.stringify(normalizeStatus(status)));
}

function normalizeDrafts(drafts) {
  return {
    version: 1,
    drafts: readPlainObject(drafts?.drafts) || {},
  };
}

function normalizeProbeStatus(status) {
  if (!status || typeof status !== 'object') {
    return null;
  }
  const record = status;
  const probeStatus = firstString(record.status);
  if (probeStatus !== 'healthy' && probeStatus !== 'probe_failed') {
    return null;
  }
  return pruneUndefined({
    status: probeStatus,
    phase: firstString(record.phase),
    error: firstString(record.error),
    checkedAt: firstString(record.checkedAt),
    latencyMs: typeof record.latencyMs === 'number' ? record.latencyMs : undefined,
    toolCount: Number.isInteger(record.toolCount) ? record.toolCount : 0,
    tools: normalizeProbeTools(record.tools),
  });
}

function detectTransport(config) {
  const type = firstString(config?.type || config?.transport);
  if (type === 'sse') return 'sse';
  if (type === 'stdio' || firstString(config?.command)) return 'stdio';
  if (firstString(config?.url)) return 'http';
  return type || 'unknown';
}

function normalizeServerName(value) {
  const name = firstString(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name)) {
    throw createHttpError('MCP server name must use letters, numbers, dots, underscores, or hyphens', 400);
  }
  return name;
}

function assertHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(firstString(value));
  } catch {
    throw createHttpError('MCP server URL is invalid', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createHttpError('MCP server URL must start with http:// or https://', 400);
  }
}

function summarizeTools(tools) {
  return {
    total: tools.length,
    builtin: tools.filter((tool) => tool.type === 'builtin').length,
    httpMcp: tools.filter((tool) => tool.type === 'mcp' && tool.transport === 'http' && tool.status !== 'needs_value').length,
    healthy: tools.filter((tool) => tool.status === 'healthy').length,
    needsValue: tools.filter((tool) => tool.status === 'needs_value').length,
    unsupported: tools.filter((tool) => tool.status === 'unsupported').length,
    blocked: tools.filter((tool) => tool.status === 'probe_failed' || tool.status === 'needs_value' || tool.status === 'unsupported').length,
  };
}

function sortTools(tools) {
  const typeOrder = { builtin: 0, mcp: 1 };
  const statusOrder = {
    healthy: 0,
    available: 1,
    read_only: 2,
    unverified: 3,
    needs_value: 4,
    probe_failed: 5,
    unsupported: 6,
  };

  return [...tools].sort((left, right) => {
    const typeDelta = (typeOrder[left.type] ?? 99) - (typeOrder[right.type] ?? 99);
    if (typeDelta !== 0) return typeDelta;
    const statusDelta = (statusOrder[left.status] ?? 99) - (statusOrder[right.status] ?? 99);
    if (statusDelta !== 0) return statusDelta;
    return left.name.localeCompare(right.name);
  });
}

function sanitizeConfigForUi(config) {
  const record = readPlainObject(config) || {};
  return pruneUndefined({
    type: firstString(record.type || record.transport),
    url: firstString(record.url),
    command: firstString(record.command),
    headers: readStringRecord(record.headers),
    headersHelper: firstString(record.headersHelper) || undefined,
  });
}

function readStringRecord(value) {
  const record = readPlainObject(value);
  if (!record) return {};

  return Object.fromEntries(
    Object.entries(record)
      .filter(([key, entry]) => firstString(key) && typeof entry === 'string')
      .map(([key, entry]) => [key, entry]),
  );
}

function readRpcError(error) {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    return firstString(error.message) || JSON.stringify(error);
  }
  return 'JSON-RPC error';
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

async function removeJsonFile(filePath, { workspacePath } = {}) {
  await fs.rm(filePath, { force: true });
  if (!workspacePath) {
    return;
  }

  const workspaceRoot = path.resolve(workspacePath);
  let currentDir = path.dirname(filePath);
  while (currentDir.startsWith(workspaceRoot) && currentDir !== workspaceRoot) {
    try {
      await fs.rmdir(currentDir);
    } catch {
      return;
    }
    currentDir = path.dirname(currentDir);
  }
}

function createHttpError(message, statusCode = 400, extras = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, extras);
  return error;
}

function readPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function firstString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function pruneUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
