/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { CLAUDE_MODELS } from '../shared/modelConstants.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import { loadMcpConfig } from './services/claude-mcp-config.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { recordProviderSession } from './services/session-ownership.js';
import { agentSessionRuntimeManager } from './services/agent-session-runtime.js';
import {
  bindRuntimeMessagesToProviderSession,
  persistNormalizedMessages,
  persistUserPromptMessage,
} from './services/session-message-history.js';
import { savePlanMarkdownToWorkspaceRoot } from './services/workspace-file-operations.js';
import { reconcileWorkspaceSkillsForAgentTurn } from './services/workspace-skills.js';
import { createNormalizedMessage } from './shared/utils.js';

const activeSessions = new Map();
const abortedSessions = new Set();
const pendingToolApprovals = new Map();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;
const CLAUDE_DISABLED_TOOLS_ENV = 'CLAUDE_DISABLED_TOOLS';

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode']);

function parseDisabledTools(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((tool) => typeof tool === 'string').map((tool) => tool.trim()).filter(Boolean);
      }
    } catch (error) {
      console.warn(`Unable to parse ${CLAUDE_DISABLED_TOOLS_ENV} JSON array:`, error?.message || error);
    }
  }

  return trimmed.split(/[,\n]+/).map((tool) => tool.trim()).filter(Boolean);
}

function uniqueTools(tools) {
  return Array.from(new Set(tools.filter((tool) => typeof tool === 'string' && tool.trim()).map((tool) => tool.trim())));
}

function getConfiguredDisabledTools(options = {}) {
  return uniqueTools([
    ...parseDisabledTools(process.env[CLAUDE_DISABLED_TOOLS_ENV]),
    ...parseDisabledTools(options.executionEnv?.[CLAUDE_DISABLED_TOOLS_ENV]),
  ]);
}

function getBashCommand(input) {
  if (input && typeof input === 'object' && typeof input.command === 'string') {
    return input.command.trim();
  }

  if (typeof input !== 'string' || !input.trim()) {
    return '';
  }

  try {
    const parsed = JSON.parse(input);
    return typeof parsed?.command === 'string' ? parsed.command.trim() : '';
  } catch {
    return '';
  }
}

function buildToolPermissionEntry(toolName, input) {
  if (!toolName) {
    return null;
  }

  if (toolName !== 'Bash') {
    return toolName;
  }

  const command = getBashCommand(input);
  if (!command) {
    return toolName;
  }

  const tokens = command.split(/\s+/);
  if (tokens.length === 0) {
    return toolName;
  }

  if (tokens[0] === 'git' && tokens[1]) {
    return `Bash(${tokens[0]} ${tokens[1]}:*)`;
  }

  return `Bash(${tokens[0]}:*)`;
}

function isToolDisabled(toolName, input, disabledTools) {
  if (!Array.isArray(disabledTools) || disabledTools.length === 0) {
    return false;
  }

  const permissionEntry = buildToolPermissionEntry(toolName, input);
  return disabledTools.includes(toolName) || (permissionEntry ? disabledTools.includes(permissionEntry) : false);
}

function getToolInteractionMessage(toolName) {
  if (toolName === 'AskUserQuestion') {
    return 'Claude is asking a question.';
  }

  if (toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode') {
    return 'Claude is waiting for plan confirmation.';
  }

  return 'Claude requires your attention.';
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

function resolveClaudeModel(options = {}) {
  const runtimeEnvModel = options.executionEnv?.ANTHROPIC_MODEL?.trim();
  const envModel = process.env.ANTHROPIC_MODEL?.trim();
  return runtimeEnvModel || envModel || options.model || CLAUDE_MODELS.DEFAULT;
}

/**
 * Maps CLI options to SDK-compatible options format
 * @param {Object} options - CLI options
 * @returns {Object} SDK-compatible options
 */
function mapCliOptionsToSDK(options = {}) {
  const {
    sessionId,
    cwd,
    permissionMode,
    pathToClaudeCodeExecutable,
    executionEnv,
    settingSources,
  } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = executionEnv ? { ...executionEnv } : { ...process.env };

  // Use CLAUDE_CLI_PATH if explicitly set, otherwise fall back to 'claude' on PATH.
  // The SDK 0.2.113+ looks for a bundled native binary optional dep by default;
  // this fallback ensures users who installed via the official installer still work
  // even when npm prune --production has removed those optional deps.
  sdkOptions.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable || process.env.CLAUDE_CLI_PATH || 'claude';

  // Map working directory
  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  // Keep plan mode behavior, while normal execution is auto-approved through canUseTool below.
  if (permissionMode === 'plan') {
    sdkOptions.permissionMode = permissionMode;
  }

  let allowedTools = [];

  // Add plan mode default tools
  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = uniqueTools([
    ...getConfiguredDisabledTools(options),
  ]);

  // Claude Agent SDK emits token-level partial assistant events only when this is enabled.
  // The provider adapter converts those stream_event payloads into UI stream_delta events.
  sdkOptions.includePartialMessages = true;

  // ANTHROPIC_MODEL pins custom gateways to their configured model name.
  // Without this, the UI model alias (e.g. opus) is forwarded to the gateway.
  sdkOptions.model = resolveClaudeModel(options);
  // Model logged at query start below

  // Map system prompt configuration
  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'  // Required to use CLAUDE.md
  };

  // Map setting sources for CLAUDE.md loading
  // This loads CLAUDE.md from project, user (~/.config/claude/CLAUDE.md), and local directories
  sdkOptions.settingSources = Array.isArray(settingSources) ? settingSources : ['project', 'user', 'local'];

  // Map resume session
  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Array<string>} tempImagePaths - Temp image file paths for cleanup
 * @param {string} tempDir - Temp directory for cleanup
 */
function addSession(sessionId, queryInstance, tempImagePaths = [], tempDir = null, writer = null, runtimeOptions = {}) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    tempImagePaths,
    tempDir,
    writer,
    runtimeId: runtimeOptions.runtimeId || null,
    runtimeMode: runtimeOptions.runtimeMode || 'local',
    runtimeOptions,
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

function countActiveSessionsForRuntime(runtimeId, { excludingSessionId = null } = {}) {
  if (!runtimeId) return 0;
  let count = 0;
  for (const [activeSessionId, session] of activeSessions.entries()) {
    if (activeSessionId === excludingSessionId) continue;
    if (session.runtimeMode === 'docker' && session.runtimeId === runtimeId && session.status === 'active') {
      count += 1;
    }
  }
  return count;
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * Extracts token usage from SDK result messages
 * @param {Object} resultMessage - SDK result message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(resultMessage) {
  if (resultMessage.type !== 'result' || !resultMessage.modelUsage) {
    return null;
  }

  // Get the first model's usage data
  const modelKey = Object.keys(resultMessage.modelUsage)[0];
  const modelData = resultMessage.modelUsage[modelKey];

  if (!modelData) {
    return null;
  }

  // Use cumulative tokens if available (tracks total for the session)
  // Otherwise fall back to per-request tokens
  const inputTokens = modelData.cumulativeInputTokens || modelData.inputTokens || 0;
  const outputTokens = modelData.cumulativeOutputTokens || modelData.outputTokens || 0;
  const cacheReadTokens = modelData.cumulativeCacheReadInputTokens || modelData.cacheReadInputTokens || 0;
  const cacheCreationTokens = modelData.cumulativeCacheCreationInputTokens || modelData.cacheCreationInputTokens || 0;

  // Total used = input + output + cache tokens
  const totalUsed = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  // Use configured context window budget from environment (default 160000)
  // This is the user's budget limit, not the model's context window
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW) || 160000;

  // Token calc logged via token-budget WS event

  return {
    used: totalUsed,
    total: contextWindow
  };
}

/**
 * Extracts per-turn token usage from SDK result messages for durable analytics.
 * @param {Object} resultMessage - SDK result message
 * @returns {Object|null} Token usage object or null
 */
function extractTokenUsage(resultMessage) {
  if (resultMessage.type !== 'result' || !resultMessage.modelUsage) {
    return null;
  }

  const modelKey = Object.keys(resultMessage.modelUsage)[0];
  const modelData = resultMessage.modelUsage[modelKey];
  if (!modelData) {
    return null;
  }

  const inputTokens = modelData.inputTokens || modelData.input_tokens || 0;
  const outputTokens = modelData.outputTokens || modelData.output_tokens || 0;
  const cacheReadTokens = modelData.cacheReadInputTokens || modelData.cache_read_input_tokens || 0;
  const cacheCreationTokens = modelData.cacheCreationInputTokens || modelData.cache_creation_input_tokens || 0;
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  const cumulativeInputTokens = modelData.cumulativeInputTokens || modelData.cumulative_input_tokens || 0;
  const cumulativeOutputTokens = modelData.cumulativeOutputTokens || modelData.cumulative_output_tokens || 0;
  const cumulativeCacheReadTokens = modelData.cumulativeCacheReadInputTokens || modelData.cumulative_cache_read_input_tokens || 0;
  const cumulativeCacheCreationTokens = modelData.cumulativeCacheCreationInputTokens || modelData.cumulative_cache_creation_input_tokens || 0;

  if (totalTokens === 0 && cumulativeInputTokens + cumulativeOutputTokens + cumulativeCacheReadTokens + cumulativeCacheCreationTokens === 0) {
    return null;
  }

  return {
    model: modelKey,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens: cacheReadTokens + cacheCreationTokens,
    totalTokens,
    cumulativeInputTokens,
    cumulativeOutputTokens,
    cumulativeCacheReadTokens,
    cumulativeCacheCreationTokens,
    cumulativeCacheTokens: cumulativeCacheReadTokens + cumulativeCacheCreationTokens,
    cumulativeTotalTokens: cumulativeInputTokens
      + cumulativeOutputTokens
      + cumulativeCacheReadTokens
      + cumulativeCacheCreationTokens,
  };
}

/**
 * Handles image processing for SDK queries
 * Saves base64 images to temporary files and returns modified prompt with file paths
 * @param {string} command - Original user prompt
 * @param {Array} images - Array of image objects with base64 data
 * @param {string} cwd - Working directory for temp file creation
 * @returns {Promise<Object>} {modifiedCommand, tempImagePaths, tempDir}
 */
async function handleImages(command, images, cwd, promptCwd = cwd) {
  const tempImagePaths = [];
  const promptImagePaths = [];
  let tempDir = null;

  if (!images || images.length === 0) {
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }

  try {
    // Create temp directory in the project directory
    const workingDir = cwd || process.cwd();
    const promptWorkingDir = promptCwd || workingDir;
    const tempSubdir = path.join('.tmp', 'images', Date.now().toString());
    tempDir = path.join(workingDir, tempSubdir);
    await fs.mkdir(tempDir, { recursive: true });

    // Save each image to a temp file
    for (const [index, image] of images.entries()) {
      // Extract base64 data and mime type
      const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        console.error('Invalid image data format');
        continue;
      }

      const [, mimeType, base64Data] = matches;
      const extension = mimeType.split('/')[1] || 'png';
      const filename = `image_${index}.${extension}`;
      const filepath = path.join(tempDir, filename);
      const promptPath = path.join(promptWorkingDir, tempSubdir, filename);

      // Write base64 data to file
      await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
      tempImagePaths.push(filepath);
      promptImagePaths.push(promptPath);
    }

    // Include the full image paths in the prompt
    let modifiedCommand = command;
    if (promptImagePaths.length > 0 && command && command.trim()) {
      const imageNote = `\n\n[Images provided at the following paths:]\n${promptImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
      modifiedCommand = command + imageNote;
    }

    // Images processed
    return { modifiedCommand, tempImagePaths, tempDir };
  } catch (error) {
    console.error('Error processing images for SDK:', error);
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }
}

/**
 * Cleans up temporary image files
 * @param {Array<string>} tempImagePaths - Array of temp file paths to delete
 * @param {string} tempDir - Temp directory to remove
 */
async function cleanupTempFiles(tempImagePaths, tempDir) {
  if (!tempImagePaths || tempImagePaths.length === 0) {
    return;
  }

  try {
    // Delete individual temp files
    for (const imagePath of tempImagePaths) {
      await fs.unlink(imagePath).catch(err =>
        console.error(`Failed to delete temp image ${imagePath}:`, err)
      );
    }

    // Delete temp directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(err =>
        console.error(`Failed to delete temp directory ${tempDir}:`, err)
      );
    }

    // Temp files cleaned
  } catch (error) {
    console.error('Error during temp file cleanup:', error);
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws) {
  const { sessionId, sessionSummary } = options;
  let capturedSessionId = sessionId;
  const pendingProviderSessionId = sessionId ? null : `pending:${createRequestId()}`;
  let sessionCreatedSent = false;
  let tempImagePaths = [];
  let tempDir = null;
  let runtimeOptions = options;
  let runtimeContext = null;
  let runtimeBoundToProviderSession = Boolean(sessionId);

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  const bindRuntimeToProviderSession = (providerSessionId) => {
    if (!runtimeOptions.runtimeId || !providerSessionId || runtimeBoundToProviderSession) {
      return;
    }
    agentSessionRuntimeManager.bindProviderSession({
      runtimeId: runtimeOptions.runtimeId,
      providerSessionId,
    });
    bindRuntimeMessagesToProviderSession({
      runtimeId: runtimeOptions.runtimeId,
      providerSessionId,
      fromProviderSessionId: pendingProviderSessionId,
    });
    runtimeBoundToProviderSession = true;
  };

  try {
    runtimeContext = await agentSessionRuntimeManager.prepareClaudeRuntime(options);
    runtimeOptions = {
      ...options,
      cwd: runtimeContext.cwd || options.cwd,
      projectPath: runtimeContext.projectPath || options.projectPath,
      pathToClaudeCodeExecutable: runtimeContext.pathToClaudeCodeExecutable,
      executionEnv: runtimeContext.executionEnv,
      settingSources: runtimeContext.settingSources,
      runtimeId: runtimeContext.runtimeId,
      runtimeMode: runtimeContext.mode,
    };

    await reconcileWorkspaceSkillsForAgentTurn({
      workspacePath: runtimeContext.hostWorkspacePath || runtimeOptions.cwd || runtimeOptions.projectPath,
    });

    const displayCommand = typeof runtimeOptions.displayCommand === 'string' && runtimeOptions.displayCommand.trim()
      ? runtimeOptions.displayCommand
      : command;

    persistUserPromptMessage({
      options: runtimeOptions,
      provider: 'claude',
      providerSessionId: capturedSessionId || sessionId || pendingProviderSessionId,
      runtimeId: runtimeOptions.runtimeId,
      command: displayCommand,
    });

    // Map CLI options to SDK format
    const sdkOptions = mapCliOptionsToSDK(runtimeOptions);

    // Load MCP configuration
    const mcpServers = await loadMcpConfig(runtimeOptions.cwd, {
      includeHostConfig: !runtimeContext.disableHostMcpConfig,
      tenantId: runtimeOptions.tenantId,
      workspaceId: runtimeOptions.workspaceId,
      runtimeMode: runtimeContext.mode,
      runtimeHomePath: runtimeContext.runtimeHomePath,
    });
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Handle images - save to temp files and modify prompt
    const imageResult = await handleImages(
      command,
      options.images,
      runtimeContext.hostWorkspacePath || options.cwd,
      runtimeContext.containerCwd || runtimeOptions.cwd,
    );
    const finalCommand = imageResult.modifiedCommand;
    tempImagePaths = imageResult.tempImagePaths;
    tempDir = imageResult.tempDir;

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: capturedSessionId || sessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${capturedSessionId || sessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    sdkOptions.canUseTool = async (toolName, input, context) => {
      if (isToolDisabled(toolName, input, sdkOptions.disallowedTools)) {
        return {
          behavior: 'deny',
          message: `${toolName} is disabled by configuration`,
        };
      }

      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        return { behavior: 'allow', updatedInput: input };
      }

      if ((toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode') && typeof input?.plan === 'string') {
        try {
          const savedPlan = await savePlanMarkdownToWorkspaceRoot({
            workspaceRoot: runtimeContext.hostWorkspacePath || runtimeOptions.cwd || options.cwd,
            plan: input.plan,
            sessionId: capturedSessionId || sessionId || null,
          });
          ws.send({
            type: 'files_changed',
            projectName: runtimeOptions.projectName,
            workspaceId: runtimeOptions.workspaceId,
            changedPath: savedPlan.relativePath,
            reason: 'plan',
            savedPlanPath: savedPlan.relativePath,
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          console.warn('Failed to save plan markdown to workspace root:', error?.message || error);
        }
      }

      const requestId = createRequestId();
      const interactionMessage = getToolInteractionMessage(toolName);
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: capturedSessionId || sessionId || null,
        kind: 'action_required',
        code: 'agent.notification',
        meta: { message: interactionMessage, toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:interaction:${capturedSessionId || sessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          _sessionId: capturedSessionId || sessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Tool interaction timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Tool interaction cancelled' };
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User declined tool interaction' };
    };

    // Set stream-close timeout for interactive tools (Query constructor reads it synchronously). Claude Agent SDK has a default of 5s and this overrides it
    const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

    let queryInstance;
    try {
      queryInstance = query({
        prompt: finalCommand,
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      queryInstance = query({
        prompt: finalCommand,
        options: sdkOptions
      });
    }

    // Restore immediately — Query constructor already captured the value
    if (prevStreamTimeout !== undefined) {
      process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
    } else {
      delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    }

    // Track the query instance for abort capability
    if (capturedSessionId) {
      addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, runtimeOptions);
      bindRuntimeToProviderSession(capturedSessionId);
      recordProviderSession({ options: runtimeOptions, provider: 'claude', providerSessionId: capturedSessionId, status: 'active' });
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const message of queryInstance) {
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, runtimeOptions);
        bindRuntimeToProviderSession(capturedSessionId);
        recordProviderSession({ options: runtimeOptions, provider: 'claude', providerSessionId: capturedSessionId, status: 'active' });

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for new sessions
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;
      const persistenceSessionId = sid || pendingProviderSessionId;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
      persistNormalizedMessages({
        options: runtimeOptions,
        provider: 'claude',
        providerSessionId: persistenceSessionId,
        runtimeId: runtimeOptions.runtimeId,
        messages: normalized,
      });
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        ws.send(msg);
      }

      // Extract and send token budget updates from result messages
      if (message.type === 'result') {
        const models = Object.keys(message.modelUsage || {});
        if (models.length > 0) {
          // Model info available in result message
        }
        const tokenBudgetData = extractTokenBudget(message);
        if (tokenBudgetData) {
          const tokenStatusMessage = createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget: tokenBudgetData,
            tokenUsage: extractTokenUsage(message),
            sessionId: capturedSessionId || sessionId || null,
            provider: 'claude',
          });
          persistNormalizedMessages({
            options: runtimeOptions,
            provider: 'claude',
            providerSessionId: persistenceSessionId,
            runtimeId: runtimeOptions.runtimeId,
            messages: [tokenStatusMessage],
          });
          ws.send(tokenStatusMessage);
        }
      }
    }

    const finalSessionId = capturedSessionId || sessionId || null;
    const wasAborted = finalSessionId ? abortedSessions.delete(finalSessionId) : false;

    // Clean up session on completion
    if (finalSessionId) {
      removeSession(finalSessionId);
    }

    // Clean up temporary image files
    await cleanupTempFiles(tempImagePaths, tempDir);
    agentSessionRuntimeManager.markIdle(runtimeOptions.runtimeId);
    recordProviderSession({
      options: runtimeOptions,
      provider: 'claude',
      providerSessionId: finalSessionId,
      status: wasAborted ? 'aborted' : 'completed',
    });

    // Send completion event
    ws.send(createNormalizedMessage({
      kind: 'complete',
      exitCode: 0,
      isNewSession: !sessionId && !!command,
      sessionId: finalSessionId,
      provider: 'claude',
      aborted: wasAborted,
      success: true,
    }));
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: finalSessionId,
      sessionName: sessionSummary,
      stopReason: wasAborted ? 'aborted' : 'completed'
    });
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);
    const finalSessionId = capturedSessionId || sessionId || null;
    const wasAborted = finalSessionId ? abortedSessions.delete(finalSessionId) : false;

    // Clean up session on error
    if (finalSessionId) {
      removeSession(finalSessionId);
    }

    // Clean up temporary image files on error
    await cleanupTempFiles(tempImagePaths, tempDir);

    if (wasAborted) {
      agentSessionRuntimeManager.markIdle(runtimeOptions.runtimeId);
      recordProviderSession({
        options: runtimeOptions,
        provider: 'claude',
        providerSessionId: finalSessionId,
        status: 'aborted',
      });
      ws.send(createNormalizedMessage({
        kind: 'complete',
        exitCode: 0,
        aborted: true,
        success: true,
        sessionId: finalSessionId,
        provider: 'claude',
      }));
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        stopReason: 'aborted',
      });
      return;
    }

    agentSessionRuntimeManager.markFailed(runtimeOptions.runtimeId);
    recordProviderSession({ options: runtimeOptions, provider: 'claude', providerSessionId: finalSessionId, status: 'failed' });

    // Check if Claude CLI is installed for a clearer error message
    const installed = runtimeOptions.runtimeMode === 'docker'
      ? true
      : await providerAuthService.isProviderInstalled('claude');
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    const errorMessage = {
      kind: 'error',
      content: errorContent,
      sessionId: finalSessionId,
      provider: 'claude'
    };
    if (error?.code) {
      errorMessage.code = error.code;
    }
    if (Array.isArray(error?.failures)) {
      errorMessage.failures = error.failures;
    }

    // Send error to WebSocket
    ws.send(createNormalizedMessage(errorMessage));
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      error
    });
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Docker-backed Claude runs inside a reusable user/workspace container. If this
    // is the last active session for that runtime, stop the container as a hard
    // cleanup because SDK interrupt can leave docker exec alive.
    session.status = 'aborted';
    abortedSessions.add(sessionId);

    const interruptPromise = Promise.resolve()
      .then(() => session.instance.interrupt())
      .catch((error) => {
        console.warn(`SDK interrupt failed for session ${sessionId}:`, error?.message || error);
      });

    if (
      session.runtimeMode === 'docker' &&
      session.runtimeId &&
      countActiveSessionsForRuntime(session.runtimeId, { excludingSessionId: sessionId }) === 0
    ) {
      await agentSessionRuntimeManager.stopRuntime(session.runtimeId);
    } else {
      await interruptPromise;
    }

    if (session.runtimeOptions) {
      recordProviderSession({
        options: session.runtimeOptions,
        provider: 'claude',
        providerSessionId: sessionId,
        status: 'aborted',
      });
    }

    // Clean up temporary image files
    await cleanupTempFiles(session.tempImagePaths, session.tempDir);

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    return false;
  }
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active';
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  resolveClaudeModel,
  loadMcpConfig,
  getPendingApprovalsForSession,
  reconnectSessionWriter
};
