import path from 'node:path';

// Only log an explicit allowlist. SDK status/config/error payloads can contain
// URLs, headers, helper commands or credentials, including echoed HTTP bodies.
function errorCategory(error) {
  const text = String(error?.message || error || '');
  if (!text) return null;
  if (/401|403|unauthorized|forbidden|oauth|authentication/i.test(text)) return 'authentication';
  if (/timeout|timed out|ETIMEDOUT/i.test(text)) return 'timeout';
  if (/certificate|TLS|SSL/i.test(text)) return 'tls';
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return 'dns';
  if (/ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(text)) return 'network';
  if (/protocol|JSON|parse|invalid response/i.test(text)) return 'protocol';
  if (/ENOENT|EACCES|permission denied/i.test(text)) return 'process_or_file';
  return 'other';
}

export function createMcpRuntimeDiagnostics({
  requestId = null,
  workspaceId = null,
  runtimeId = null,
  runtimeMode = 'local',
  workspacePath = null,
  containerName = null,
  logger = console,
  statusTimeoutMs = 5000,
} = {}) {
  const context = { requestId, workspaceId, runtimeId, runtimeMode, workspacePath, containerName };
  let configuredNames = [];
  let statusRequested = false;
  const emit = (event, fields) => {
    try {
      logger.info('[MCP Runtime]', JSON.stringify({ ...context, event, ...fields }));
    } catch {
      // Diagnostics must never interrupt a query.
    }
  };

  const logServers = (event, servers, sessionId, tools) => {
    const entries = Array.isArray(servers) ? servers : [];
    const names = new Set(entries.map((server) => server.name));
    emit(event, {
      sessionId,
      servers: entries.map((server) => ({
        name: server.name,
        status: server.status,
        // An absent list is unknown, not zero. Init counts describe tools
        // advertised in that snapshot, not necessarily all deferred tools.
        toolCount: Array.isArray(server.tools) ? server.tools.length : null,
        advertisedToolCount: Array.isArray(tools)
          ? tools.filter((tool) => typeof tool === 'string' && tool.startsWith(`mcp__${server.name}__`)).length
          : null,
        errorCategory: errorCategory(server.error),
      })),
      missingFromSnapshot: configuredNames.filter((name) => !names.has(name)),
    });
  };

  return {
    logConfig(sdkOptions, { sessionId = null, includeHostConfig = false } = {}) {
      configuredNames = Object.keys(sdkOptions.mcpServers || {});
      emit('config', {
        sessionId,
        configPath: workspacePath ? path.join(workspacePath, '.mcp.json') : null,
        includeHostConfig,
        strictMcpConfig: sdkOptions.strictMcpConfig === true,
        serverCount: configuredNames.length,
        serverNames: configuredNames,
        disallowedMcpTools: (sdkOptions.disallowedTools || [])
          .filter((name) => typeof name === 'string' && name.startsWith('mcp__')),
      });
    },
    observe(message, queryInstance) {
      if (message?.type !== 'system' || message.subtype !== 'init') return;
      const sessionId = message.session_id || null;
      logServers('sdk_init', message.mcp_servers, sessionId, message.tools);
      if (statusRequested) return;
      statusRequested = true;
      if (typeof queryInstance?.mcpServerStatus !== 'function') {
        emit('status_unavailable', { sessionId, reason: 'unsupported_sdk' });
        return;
      }
      // Do not await a control request inside the message iterator: the SDK
      // must keep consuming messages, and diagnostics must not delay the turn.
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), statusTimeoutMs);
        timer.unref?.();
      });
      void Promise.race([
        Promise.resolve().then(() => queryInstance.mcpServerStatus()),
        timeout,
      ]).then(
        (servers) => logServers('sdk_status', servers, sessionId),
        (error) => emit('status_unavailable', { sessionId, errorCategory: errorCategory(error) }),
      ).finally(() => clearTimeout(timer));
    },
  };
}
