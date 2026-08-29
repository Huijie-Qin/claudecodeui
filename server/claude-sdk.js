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

import crypto from 'crypto';
import { promises as fs } from 'fs';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { CLAUDE_MODELS } from '../shared/modelConstants.js';

import {
  CLAUDE_NATIVE_SCHEDULING_TOOL_NAMES,
  applyClaudeNativeSchedulingEnvironmentPolicy,
  assertClaudeNativeSchedulingCommandAllowed,
  isClaudeNativeSchedulingDisabled,
} from './services/claude-native-scheduling-policy.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import {
  applyMcpConfigToSdkOptions,
  loadMcpConfig,
} from './services/claude-mcp-config.js';
import {
  MCP_TOOL_OVERRIDES_TRACE_LOG_ID,
  applyMcpToolOverrides,
  buildMcpToolOverridePreToolUseOutput,
  isMcpToolName,
  readMcpToolOverridesConfig,
} from './services/mcp-tool-overrides.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { recordProviderSession } from './services/session-ownership.js';
import { agentSessionRuntimeManager } from './services/agent-session-runtime.js';
import {
  bindRuntimeMessagesToProviderSession,
  persistNormalizedMessages,
  persistUserPromptMessage,
  shouldSuppressLiveUserTextMessage,
} from './services/session-message-history.js';
import { savePlanMarkdownToWorkspaceRoot } from './services/workspace-file-operations.js';
import { reconcileWorkspaceSkillsForAgentTurn } from './services/workspace-skills.js';
import { createClaudeProcessDiagnostics } from './services/claude-sdk-diagnostics.js';
import { appendClaudeDisplayCommand } from './modules/providers/list/claude/claude-display-command-store.js';
import { userDb } from './database/db.js';
import { resolveUserWorkspaceMcpToolAccess } from './services/mcp-tool-access.js';
import { hookConfigService } from './services/hook-configs.js';
import { createHookRuntimeSession, mergeSdkHooks } from './services/hook-runtime.js';
import { createNormalizedMessage } from './shared/utils.js';

const activeSessions = new Map();
const abortedSessions = new Set();
const pendingToolApprovals = new Map();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;
const STREAM_STALL_TIMEOUT_MS = parseInt(process.env.CLAUDE_STREAM_STALL_TIMEOUT_MS, 10) || 120000;
const STREAM_STALL_PAUSE_POLL_MS = 5000;
const CLAUDE_DISABLED_TOOLS_ENV = 'CLAUDE_DISABLED_TOOLS';

const DISABLED_CLAUDE_CODE_TOOLS = Object.freeze(['WebSearch', 'WebFetch']);
const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode']);
const CLAUDE_NATIVE_SCHEDULING_TOOLS = new Set(CLAUDE_NATIVE_SCHEDULING_TOOL_NAMES);
const CLAUDE_SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const CLAUDE_SESSION_IDLE_CLOSE_MS = parseInt(process.env.CLAUDE_SESSION_IDLE_CLOSE_MS, 10) || 5 * 60 * 1000;

class StreamStalledError extends Error {
  constructor(provider, timeoutMs) {
    super(`${provider} stream stalled: no events received for ${Math.round(timeoutMs / 1000)} seconds`);
    this.name = 'StreamStalledError';
    this.code = 'STREAM_STALLED';
    this.provider = provider;
    this.timeoutMs = timeoutMs;
  }
}

function readIteratorNextWithStallTimeout(iterator, {
  timeoutMs,
  provider,
  shouldPauseTimeout = () => false,
  onTimeout,
}) {
  if (!timeoutMs || timeoutMs <= 0) {
    return iterator.next();
  }

  let timer = null;

  const timeoutPromise = new Promise((_, reject) => {
    const check = () => {
      if (shouldPauseTimeout()) {
        timer = setTimeout(check, STREAM_STALL_PAUSE_POLL_MS);
        return;
      }

      const error = new StreamStalledError(provider, timeoutMs);
      onTimeout?.(error);
      reject(error);
    };

    timer = setTimeout(check, timeoutMs);
  });

  return Promise.race([iterator.next(), timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

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

function buildToolInteractionContext(context) {
  const toolUseId = typeof context?.toolUseID === 'string' && context.toolUseID.trim()
    ? context.toolUseID.trim()
    : undefined;
  const agentId = typeof context?.agentID === 'string' && context.agentID.trim()
    ? context.agentID.trim()
    : undefined;

  return toolUseId || agentId ? { toolUseId, agentId } : undefined;
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
    executableArgs,
    executionEnv,
    settingSources,
    spawnClaudeCodeProcess,
  } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = applyClaudeNativeSchedulingEnvironmentPolicy(
    executionEnv ? { ...executionEnv } : { ...process.env },
  );

  // Use CLAUDE_CLI_PATH if explicitly set, otherwise fall back to 'claude' on PATH.
  // The SDK 0.2.113+ looks for a bundled native binary optional dep by default;
  // this fallback ensures users who installed via the official installer still work
  // even when npm prune --production has removed those optional deps.
  sdkOptions.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable || process.env.CLAUDE_CLI_PATH || 'claude';
  if (Array.isArray(executableArgs) && executableArgs.length > 0) {
    sdkOptions.executableArgs = executableArgs;
  }
  if (spawnClaudeCodeProcess) {
    sdkOptions.spawnClaudeCodeProcess = spawnClaudeCodeProcess;
  }

  // Map working directory
  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  // Normal CCUI sessions auto-authorize every tool that is not explicitly
  // disabled. Express that through the SDK's native permission mode so
  // Agent-tool subagents inherit the same access as the parent. Relying only
  // on canUseTool leaves background subagents unable to use tools because they
  // cannot always surface permission prompts.
  if (permissionMode === 'plan') {
    sdkOptions.permissionMode = 'plan';
  } else {
    sdkOptions.permissionMode = 'bypassPermissions';
    sdkOptions.allowDangerouslySkipPermissions = true;
  }

  let allowedTools = [];

  // Add plan mode default tools
  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite'];
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
    ...DISABLED_CLAUDE_CODE_TOOLS,
    ...getConfiguredDisabledTools(options),
    ...(isClaudeNativeSchedulingDisabled(sdkOptions.env) ? CLAUDE_NATIVE_SCHEDULING_TOOL_NAMES : []),
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
function addSession(sessionId, queryInstance, tempImagePaths = [], tempDir = null, writer = null, runtimeOptions = {}, inputQueue = null) {
  const existing = activeSessions.get(sessionId) || {};
  if (existing.idleCloseTimer) {
    clearTimeout(existing.idleCloseTimer);
  }

  activeSessions.set(sessionId, {
    ...existing,
    instance: queryInstance,
    startTime: Date.now(),
    status: 'processing',
    tempImagePaths,
    tempDir,
    writer,
    inputQueue: inputQueue || existing.inputQueue || null,
    idleCloseTimer: null,
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

function updateSessionWriter(sessionId, writer) {
  const session = getSession(sessionId);
  if (!session || !writer) {
    return false;
  }
  session.writer = writer;
  return true;
}

function markSessionProcessing(sessionId) {
  const session = getSession(sessionId);
  if (!session) return false;
  if (session.idleCloseTimer) {
    clearTimeout(session.idleCloseTimer);
    session.idleCloseTimer = null;
  }
  session.status = 'processing';
  return true;
}

function scheduleSessionIdleClose(sessionId) {
  const session = getSession(sessionId);
  if (!session) return;
  session.status = 'idle';
  if (session.idleCloseTimer) {
    clearTimeout(session.idleCloseTimer);
  }
  session.idleCloseTimer = setTimeout(() => {
    const latest = getSession(sessionId);
    if (!latest || latest.status !== 'idle') {
      return;
    }
    latest.inputQueue?.close();
    latest.instance?.close?.();
  }, CLAUDE_SESSION_IDLE_CLOSE_MS);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.entries())
    .filter(([, session]) => session.status === 'processing')
    .map(([sessionId]) => sessionId);
}

function countActiveSessionsForRuntime(runtimeId, { excludingSessionId = null } = {}) {
  if (!runtimeId) return 0;
  let count = 0;
  for (const [activeSessionId, session] of activeSessions.entries()) {
    if (activeSessionId === excludingSessionId) continue;
    if (session.runtimeMode === 'docker' && session.runtimeId === runtimeId && session.status === 'processing') {
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

function createSingleMessagePrompt(message) {
  return (async function* singleMessagePrompt() {
    yield message;
  })();
}

function parseImageDataUrl(image, index) {
  const matches = typeof image?.data === 'string'
    ? image.data.match(/^data:([^;]+);base64,(.+)$/)
    : null;
  if (!matches) {
    throw new Error(`Image ${index + 1} is missing valid base64 data.`);
  }

  const [, mimeType, base64Data] = matches;
  if (!CLAUDE_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported image type ${mimeType}. Claude supports JPEG, PNG, GIF, and WebP images.`);
  }

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mimeType,
      data: base64Data,
    },
  };
}

function logChatSessionTokenUsage({ requestId, provider, sessionId, model, tokenBudget, tokenUsage }) {
  console.log('[chat-session]', JSON.stringify({
    event: 'token_usage',
    requestId: requestId || null,
    provider,
    sessionId: sessionId || null,
    model: model || null,
    tokenBudget,
    tokenUsage,
  }));
}

class ClaudeInputQueue {
  constructor({ onQueryPushed = null } = {}) {
    this.items = [];
    this.waiters = [];
    this.closed = false;
    this.pendingQueryTurns = 0;
    this.onQueryPushed = typeof onQueryPushed === 'function' ? onQueryPushed : null;
  }

  push(message) {
    if (this.closed) {
      throw new Error('Claude input queue is closed');
    }
    if (message?.shouldQuery !== false) {
      this.pendingQueryTurns += 1;
      this.onQueryPushed?.(this.pendingQueryTurns);
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: message, done: false });
      return;
    }

    this.items.push(message);
  }

  close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter({ value: undefined, done: true });
    }
  }

  async next() {
    const item = this.items.shift();
    if (item) {
      return { value: item, done: false };
    }

    if (this.closed) {
      return { value: undefined, done: true };
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  finishQueryTurn() {
    this.pendingQueryTurns = Math.max(0, this.pendingQueryTurns - 1);
    return this.pendingQueryTurns;
  }
}

function createClaudeTurnLifecycleTracker() {
  const activeTaskIds = new Set();
  let hasSeenSessionState = false;
  let hasSeenTaskLifecycle = false;
  let isCurrentlyIdle = false;
  let isWaitingForIdle = false;

  const readTaskId = (message) => (
    typeof message?.task_id === 'string' && message.task_id.trim()
      ? message.task_id.trim()
      : null
  );

  const completeWaitingTurnIfTasksSettled = () => {
    if (!isWaitingForIdle || activeTaskIds.size > 0) return null;
    isWaitingForIdle = false;
    return 'complete';
  };

  return {
    beginTurn() {
      // A newly queued user turn supersedes completion that was waiting on an
      // earlier background agent's idle event.
      isWaitingForIdle = false;
      isCurrentlyIdle = false;
      hasSeenTaskLifecycle = false;
    },

    observe(message) {
      if (message?.type === 'system' && message.subtype === 'task_started') {
        hasSeenTaskLifecycle = true;
        isCurrentlyIdle = false;
        const taskId = readTaskId(message);
        if (taskId) activeTaskIds.add(taskId);
        return 'processing';
      }

      if (message?.type === 'system' && message.subtype === 'task_updated') {
        hasSeenTaskLifecycle = true;
        const taskId = readTaskId(message);
        const status = typeof message.patch?.status === 'string'
          ? message.patch.status.trim().toLowerCase()
          : '';
        if (['completed', 'failed', 'killed', 'stopped'].includes(status)) {
          if (!taskId) return null;
          activeTaskIds.delete(taskId);
          return completeWaitingTurnIfTasksSettled();
        }
        if (taskId && ['pending', 'running'].includes(status)) {
          isCurrentlyIdle = false;
          activeTaskIds.add(taskId);
        }
        return 'processing';
      }

      if (message?.type === 'system' && message.subtype === 'task_progress') {
        hasSeenTaskLifecycle = true;
        isCurrentlyIdle = false;
        const taskId = readTaskId(message);
        if (taskId) activeTaskIds.add(taskId);
        return 'processing';
      }

      if (message?.type === 'system' && message.subtype === 'task_notification') {
        hasSeenTaskLifecycle = true;
        const taskId = readTaskId(message);
        if (!taskId) return null;
        activeTaskIds.delete(taskId);
        return completeWaitingTurnIfTasksSettled();
      }

      if (message?.type === 'system' && message.subtype === 'session_state_changed') {
        hasSeenSessionState = true;
        if (message.state === 'idle') {
          isCurrentlyIdle = true;
          activeTaskIds.clear();
          if (isWaitingForIdle) {
            isWaitingForIdle = false;
            return 'complete';
          }
          return null;
        }
        if (message.state === 'running' || message.state === 'requires_action') {
          isCurrentlyIdle = false;
          return 'processing';
        }
      }

      return null;
    },

    finishResult(remainingQueryTurns) {
      if (remainingQueryTurns > 0) {
        isWaitingForIdle = false;
        return false;
      }

      isWaitingForIdle = true;
      if (hasSeenSessionState && isCurrentlyIdle && activeTaskIds.size === 0) {
        isWaitingForIdle = false;
        return true;
      }
      // The SDK may omit the trailing idle event after background task
      // lifecycle messages. A final result with no active tasks is still a
      // complete turn; active tasks continue to block this fallback.
      if (hasSeenTaskLifecycle && activeTaskIds.size === 0) {
        isWaitingForIdle = false;
        return true;
      }
      // Older SDK/CLI combinations do not emit session_state_changed. Keep the
      // legacy immediate completion path when no background task was observed.
      if (!hasSeenSessionState && !hasSeenTaskLifecycle && activeTaskIds.size === 0) {
        isWaitingForIdle = false;
        return true;
      }
      return false;
    },

    flush() {
      if (!isWaitingForIdle) return false;
      isWaitingForIdle = false;
      return true;
    },
  };
}

function createPendingInteractionTracker() {
  const requestIds = new Set();

  return {
    begin(requestId) {
      requestIds.add(requestId);
    },
    end(requestId) {
      requestIds.delete(requestId);
    },
    isPaused() {
      return requestIds.size > 0;
    },
  };
}

/**
 * Builds a Claude SDK user message. Text-only turns use native string content;
 * turns with images use content blocks so Claude receives native visual input.
 */
function buildClaudeUserMessage(command, images, options = {}) {
  const envelopeMetadata = {
    ...(options.uuid ? { uuid: options.uuid } : {}),
    priority: options.priority || 'next',
    shouldQuery: options.shouldQuery !== false,
    timestamp: options.timestamp || new Date().toISOString(),
  };

  if (!images || images.length === 0) {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: command,
      },
      parent_tool_use_id: null,
      ...envelopeMetadata,
    };
  }

  const content = [];
  if (typeof command === 'string' && command.trim()) {
    content.push({ type: 'text', text: command });
  }

  images.forEach((image, index) => {
    content.push(parseImageDataUrl(image, index));
  });

  return {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    parent_tool_use_id: null,
    ...envelopeMetadata,
  };
}

/**
 * Backward-compatible helper for tests/imports that expect a prompt factory.
 */
function createClaudePromptFactory(command, images) {
  if (!images || images.length === 0) {
    return () => command;
  }

  const userMessage = buildClaudeUserMessage(command, images);
  return () => createSingleMessagePrompt(userMessage);
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
  assertClaudeNativeSchedulingCommandAllowed(command, options.executionEnv || process.env);

  const { sessionId, sessionSummary } = options;
  const processDiagnostics = createClaudeProcessDiagnostics({
    env: options.executionEnv || process.env,
  });
  let capturedSessionId = sessionId;
  const pendingProviderSessionId = sessionId ? null : `pending:${createRequestId()}`;
  let sessionCreatedSent = false;
  let tempImagePaths = [];
  let tempDir = null;
  let runtimeOptions = options;
  let runtimeContext = null;
  let runtimeBoundToProviderSession = Boolean(sessionId);
  const pendingInteractions = createPendingInteractionTracker();
  let initialDisplayCommandRecord = null;
  let initialDisplayCommandPersisted = false;
  const turnLifecycle = createClaudeTurnLifecycleTracker();
  let pendingTurnCompletion = null;
  const inputQueue = new ClaudeInputQueue({
    onQueryPushed: () => {
      pendingTurnCompletion = null;
      turnLifecycle.beginTurn();
    },
  });

  const persistInitialDisplayCommand = async (providerSessionId) => {
    if (initialDisplayCommandPersisted || !initialDisplayCommandRecord) {
      return;
    }

    try {
      await appendClaudeDisplayCommand({
        runtimeHomePath: runtimeOptions.runtimeHomePath,
        projectPath: runtimeOptions.projectPath || runtimeOptions.cwd,
        sessionId: providerSessionId,
        uid: runtimeOptions.runtimeUid,
        gid: runtimeOptions.runtimeGid,
        ...initialDisplayCommandRecord,
      });
      initialDisplayCommandPersisted = true;
    } catch (error) {
      console.warn(
        `[ClaudeDisplayCommand] Failed to persist display metadata for ${providerSessionId}:`,
        error?.message || error,
      );
    }
  };

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

  const emitPendingTurnCompletion = () => {
    const completion = pendingTurnCompletion;
    if (!completion) return false;
    pendingTurnCompletion = null;

    if (completion.sessionId) {
      scheduleSessionIdleClose(completion.sessionId);
      runtimeOptions.onConcurrencyIdle?.();
    }

    recordProviderSession({
      options: runtimeOptions,
      provider: 'claude',
      providerSessionId: completion.sessionId,
      status: 'completed',
    });

    ws.send(createNormalizedMessage({
      kind: 'complete',
      exitCode: 0,
      isNewSession: !sessionId && !!command,
      sessionId: completion.sessionId,
      provider: 'claude',
      aborted: false,
      success: true,
    }));
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: completion.sessionId,
      sessionName: sessionSummary,
      stopReason: 'completed',
    });
    return true;
  };

  try {
    runtimeContext = await agentSessionRuntimeManager.prepareClaudeRuntime(options);
    runtimeOptions = {
      ...options,
      cwd: runtimeContext.cwd || options.cwd,
      projectPath: runtimeContext.projectPath || options.projectPath,
      pathToClaudeCodeExecutable: runtimeContext.pathToClaudeCodeExecutable,
      executableArgs: runtimeContext.executableArgs,
      spawnClaudeCodeProcess: runtimeContext.spawnClaudeCodeProcess,
      executionEnv: runtimeContext.executionEnv,
      settingSources: runtimeContext.settingSources,
      runtimeId: runtimeContext.runtimeId,
      runtimeMode: runtimeContext.mode,
      runtimeHomePath: runtimeContext.runtimeHomePath,
      runtimeUid: runtimeContext.runtimeUid,
      runtimeGid: runtimeContext.runtimeGid,
    };
    processDiagnostics.updateContext({
      provider: 'claude',
      runtimeId: runtimeOptions.runtimeId || null,
      runtimeMode: runtimeOptions.runtimeMode || 'local',
      cwd: runtimeOptions.cwd || null,
      projectPath: runtimeOptions.projectPath || null,
      executable: runtimeOptions.pathToClaudeCodeExecutable || null,
      containerName: runtimeContext.containerName || null,
      hostWorkspacePath: runtimeContext.hostWorkspacePath || null,
    });
    processDiagnostics.addRedactionEnv(runtimeOptions.executionEnv || process.env);
    runtimeOptions.spawnClaudeCodeProcess = processDiagnostics.createSpawn(runtimeContext.spawnClaudeCodeProcess);

    await reconcileWorkspaceSkillsForAgentTurn({
      workspacePath: runtimeContext.hostWorkspacePath || runtimeOptions.cwd || runtimeOptions.projectPath,
    });

    const displayCommand = typeof runtimeOptions.displayCommand === 'string' && runtimeOptions.displayCommand.trim()
      ? runtimeOptions.displayCommand
      : command;
    const initialMessageId = createRequestId();
    initialDisplayCommandRecord = {
      messageId: initialMessageId,
      displayCommand,
      modelContent: command,
    };

    persistUserPromptMessage({
      options: runtimeOptions,
      provider: 'claude',
      providerSessionId: capturedSessionId || sessionId || pendingProviderSessionId,
      runtimeId: runtimeOptions.runtimeId,
      command: displayCommand,
    });

    const mcpToolAccess = resolveUserWorkspaceMcpToolAccess({
      tenantId: runtimeOptions.tenantId,
      workspaceId: runtimeOptions.workspaceId,
      userId: runtimeOptions.userId ?? ws?.userId,
    });

    // Map CLI options to SDK format
    const sdkOptions = mapCliOptionsToSDK(runtimeOptions);
    sdkOptions.disallowedTools = uniqueTools([
      ...sdkOptions.disallowedTools,
      ...mcpToolAccess.disallowedTools,
    ]);

    // Load MCP configuration
    const mcpServers = await loadMcpConfig(runtimeOptions.cwd, {
      includeHostConfig: !runtimeContext.disableHostMcpConfig,
      tenantId: runtimeOptions.tenantId,
      workspaceId: runtimeOptions.workspaceId,
      runtimeMode: runtimeContext.mode,
      runtimeHomePath: runtimeContext.runtimeHomePath,
      runtimeOwner: runtimeContext.mode === 'docker'
        ? { uid: runtimeContext.runtimeUid, gid: runtimeContext.runtimeGid }
        : null,
    });
    applyMcpConfigToSdkOptions(sdkOptions, mcpServers);

    inputQueue.push(buildClaudeUserMessage(command, options.images, {
      uuid: initialMessageId,
      priority: 'next',
      shouldQuery: true,
    }));
    if (capturedSessionId) {
      await persistInitialDisplayCommand(capturedSessionId);
    }

    const mcpOverridesWorkspaceRoot = runtimeContext.hostWorkspacePath ||
      runtimeOptions.cwd ||
      runtimeOptions.projectPath ||
      options.cwd;
    const mcpOverridesWorkspaceRootSource = runtimeContext.hostWorkspacePath
      ? 'hostWorkspacePath'
      : runtimeOptions.cwd
        ? 'runtimeCwd'
        : runtimeOptions.projectPath
          ? 'runtimeProjectPath'
          : options.cwd
            ? 'optionsCwd'
            : 'none';
    console.info(`[${MCP_TOOL_OVERRIDES_TRACE_LOG_ID}] MCP override trace initialized ${JSON.stringify({
      logId: MCP_TOOL_OVERRIDES_TRACE_LOG_ID,
      workspaceRoot: mcpOverridesWorkspaceRoot || null,
      workspaceRootSource: mcpOverridesWorkspaceRootSource,
    })}`);

    const readRuntimeMcpToolOverridesConfig = async () => {
      try {
        return await readMcpToolOverridesConfig(mcpOverridesWorkspaceRoot);
      } catch (error) {
        const traceMeta = {
          logId: MCP_TOOL_OVERRIDES_TRACE_LOG_ID,
          workspaceRoot: mcpOverridesWorkspaceRoot || null,
          errorCode: error?.code || null,
          errorMessage: error?.message || String(error),
        };
        console.warn(
          `[${MCP_TOOL_OVERRIDES_TRACE_LOG_ID}] Failed to read MCP tool overrides ${JSON.stringify(traceMeta)}`,
        );
        return null;
      }
    };

    const applyRuntimeMcpToolOverrides = async (toolName, input) => {
      if (!isMcpToolName(toolName)) {
        return { input, applied: false, appliedParams: [] };
      }

      const config = await readRuntimeMcpToolOverridesConfig();
      return applyMcpToolOverrides({ toolName, input, config });
    };

    const applyRuntimeMcpToolOverridesToMessages = async (messages) => {
      const hasMcpToolUse = Array.isArray(messages) &&
        messages.some((msg) => msg?.kind === 'tool_use' && isMcpToolName(msg.toolName));
      if (!hasMcpToolUse) {
        return messages;
      }

      const config = await readRuntimeMcpToolOverridesConfig();
      return messages.map((msg) => {
        if (msg?.kind !== 'tool_use' || !isMcpToolName(msg.toolName)) {
          return msg;
        }

        const overrideResult = applyMcpToolOverrides({
          toolName: msg.toolName,
          input: msg.toolInput,
          config,
        });
        if (!overrideResult.applied) {
          return msg;
        }

        return {
          ...msg,
          toolInput: overrideResult.input,
          originalToolInput: msg.toolInput,
          mcpToolOverrides: {
            applied: true,
            params: overrideResult.appliedParams,
            serverName: overrideResult.serverName,
            toolName: overrideResult.toolName,
          },
        };
      });
    };

    // bypassPermissions skips canUseTool for auto-approved calls, so MCP input
    // mutation must happen in PreToolUse to affect the actual server request.
    const builtinSdkHooks = {
      PreToolUse: [{
        matcher: 'mcp__.*',
        hooks: [async (input) => {
          if (input?.hook_event_name !== 'PreToolUse' || !isMcpToolName(input.tool_name)) {
            return {};
          }

          if (!mcpToolAccess.isAllowed(input.tool_name)) {
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: `${input.tool_name} is not enabled in MCP Tool settings`,
              },
            };
          }

          const config = await readRuntimeMcpToolOverridesConfig();
          const { output, overrideResult } = buildMcpToolOverridePreToolUseOutput({
            toolName: input.tool_name,
            input: input.tool_input,
            config,
          });
          if (overrideResult.applied) {
            const traceMeta = {
              logId: MCP_TOOL_OVERRIDES_TRACE_LOG_ID,
              toolName: input.tool_name,
              appliedParams: overrideResult.appliedParams,
            };
            console.info(
              `[${MCP_TOOL_OVERRIDES_TRACE_LOG_ID}] Applied MCP tool overrides ${JSON.stringify(traceMeta)}`,
            );
          }
          return output;
        }],
      }],
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

    const hookUserId = Number(runtimeOptions.userId ?? ws?.userId);
    let configuredSdkHooks = {};
    if (Number.isInteger(hookUserId) && hookUserId > 0) {
      try {
        const activeHooks = hookConfigService.listActiveHooksForUser(hookUserId);
        if (activeHooks.length > 0) {
          const needsMcpActions = activeHooks.some((hook) =>
            hook.postActions?.some((action) => action.type === 'call_mcp_tool'),
          );
          const directMcpServers = needsMcpActions && runtimeContext.mode === 'docker'
            ? await loadMcpConfig(runtimeContext.hostWorkspacePath || runtimeOptions.cwd, {
                includeHostConfig: !runtimeContext.disableHostMcpConfig,
                tenantId: runtimeOptions.tenantId,
                workspaceId: runtimeOptions.workspaceId,
                runtimeMode: 'local',
              })
            : mcpServers;
          const hookUser = userDb.getUserById(hookUserId);
          const hookRuntime = createHookRuntimeSession({
            hooks: activeHooks,
            userId: hookUserId,
            username: hookUser?.username || null,
            tenantId: runtimeOptions.tenantId || null,
            workspaceId: runtimeOptions.workspaceId || null,
            workspaceRoot: runtimeContext.hostWorkspacePath || runtimeOptions.cwd || runtimeOptions.projectPath,
            sessionId: () => capturedSessionId || sessionId || null,
            mcpServers: directMcpServers || {},
            enqueueSkillRecovery: async ({ hook, action, event, modelContent, displayCommand }) => {
              const recoveryMessageId = createRequestId();
              const recoverySessionId = event?.session_id || capturedSessionId || sessionId || null;
              if (recoverySessionId) {
                try {
                  await appendClaudeDisplayCommand({
                    runtimeHomePath: runtimeOptions.runtimeHomePath,
                    projectPath: runtimeOptions.projectPath || runtimeOptions.cwd,
                    sessionId: recoverySessionId,
                    uid: runtimeOptions.runtimeUid,
                    gid: runtimeOptions.runtimeGid,
                    messageId: recoveryMessageId,
                    displayCommand,
                    modelContent,
                  });
                } catch (error) {
                  console.warn('[HookRuntime] Failed to persist Skill recovery display command:', error?.message || error);
                }
              }
              inputQueue.push(buildClaudeUserMessage(modelContent, [], {
                uuid: recoveryMessageId,
                priority: 'next',
                shouldQuery: true,
              }));
              ws.send(createNormalizedMessage({
                kind: 'status',
                text: 'hook_skill_recovery',
                hookId: hook.id,
                hookName: hook.name,
                actionId: action.id,
                skillName: action.config.skillName,
                sessionId: recoverySessionId,
                provider: 'claude',
              }));
            },
          });
          configuredSdkHooks = hookRuntime.hooks;
          console.info(`[HookRuntime] Registered ${activeHooks.length} Hook configuration(s) for user ${hookUserId}`);
        }
      } catch (error) {
        console.error('[HookRuntime] Failed to load configured Hooks:', error?.message || error);
      }
    }
    sdkOptions.hooks = mergeSdkHooks(builtinSdkHooks, configuredSdkHooks);

    sdkOptions.canUseTool = async (toolName, input, context) => {
      if (isClaudeNativeSchedulingDisabled(sdkOptions.env) && CLAUDE_NATIVE_SCHEDULING_TOOLS.has(toolName)) {
        return {
          behavior: 'deny',
          message: 'Claude Code native scheduling is disabled in CCUI. Use CCUI scheduled tasks instead.',
        };
      }

      if (isToolDisabled(toolName, input, sdkOptions.disallowedTools)) {
        return {
          behavior: 'deny',
          message: `${toolName} is disabled by configuration`,
        };
      }

      if (!mcpToolAccess.isAllowed(toolName)) {
        return {
          behavior: 'deny',
          message: `${toolName} is not enabled in MCP Tool settings`,
        };
      }

      const overrideResult = await applyRuntimeMcpToolOverrides(toolName, input);
      const effectiveInput = overrideResult.input;
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        return { behavior: 'allow', updatedInput: effectiveInput };
      }

      if ((toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode') && typeof effectiveInput?.plan === 'string') {
        try {
          const savedPlan = await savePlanMarkdownToWorkspaceRoot({
            workspaceRoot: runtimeContext.hostWorkspacePath || runtimeOptions.cwd || options.cwd,
            plan: effectiveInput.plan,
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
      const interactionContext = buildToolInteractionContext(context);
      ws.send(createNormalizedMessage({
        kind: 'permission_request',
        requestId,
        toolName,
        input: effectiveInput,
        context: interactionContext,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'claude'
      }));
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

      pendingInteractions.begin(requestId);
      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          _sessionId: capturedSessionId || sessionId || null,
          _toolName: toolName,
          _input: effectiveInput,
          _context: interactionContext,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      }).finally(() => {
        pendingInteractions.end(requestId);
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
          if (Array.isArray(sdkOptions.disallowedTools) && !DISABLED_CLAUDE_CODE_TOOLS.includes(decision.rememberEntry)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? effectiveInput };
      }

      return { behavior: 'deny', message: decision.message ?? 'User declined tool interaction' };
    };

    // Set stream-close timeout for interactive tools (Query constructor reads it synchronously). Claude Agent SDK has a default of 5s and this overrides it
    const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

    let queryInstance;
    try {
      queryInstance = query({
        prompt: inputQueue,
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      queryInstance = query({
        prompt: inputQueue,
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
      addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, runtimeOptions, inputQueue);
      bindRuntimeToProviderSession(capturedSessionId);
      recordProviderSession({ options: runtimeOptions, provider: 'claude', providerSessionId: capturedSessionId, status: 'active' });
    }

    const iterator = queryInstance[Symbol.asyncIterator]();

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    while (true) {
      const next = await readIteratorNextWithStallTimeout(iterator, {
        timeoutMs: STREAM_STALL_TIMEOUT_MS,
        provider: 'Claude',
        shouldPauseTimeout: () => {
          const activeSessionId = capturedSessionId || sessionId || null;
          const activeSession = activeSessionId ? getSession(activeSessionId) : null;
          return pendingInteractions.isPaused() || activeSession?.status === 'idle';
        },
        onTimeout: () => {
          const activeSessionId = capturedSessionId || sessionId || null;
          const activeSession = activeSessionId ? getSession(activeSessionId) : null;
          if (activeSession?.instance?.interrupt) {
            Promise.resolve()
              .then(() => activeSession.instance.interrupt())
              .catch((error) => {
                console.warn(`Failed to interrupt stalled Claude stream ${activeSessionId}:`, error?.message || error);
              });
          }
        },
      });

      if (next.done) {
        break;
      }

      const message = next.value;
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        await persistInitialDisplayCommand(capturedSessionId);
        addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, runtimeOptions, inputQueue);
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
      const lifecycleSignal = turnLifecycle.observe(message);
      if (lifecycleSignal === 'processing' && sid) {
        markSessionProcessing(sid);
      }

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = await applyRuntimeMcpToolOverridesToMessages(
        sessionsService.normalizeMessage('claude', transformedMessage, sid)
      );
      const visibleNormalized = normalized.filter(
        (msg) => !shouldSuppressLiveUserTextMessage(msg, ws),
      );
      for (const msg of visibleNormalized) {
        // Preserve parentToolUseId from the SDK wrapper both for realtime
        // rendering and for providers that persist normalized history.
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
      }
      persistNormalizedMessages({
        options: runtimeOptions,
        provider: 'claude',
        providerSessionId: persistenceSessionId,
        runtimeId: runtimeOptions.runtimeId,
        messages: visibleNormalized,
      });
      for (const msg of visibleNormalized) {
        ws.send(msg);
      }

      // Deliver the terminal task event before the main completion event so
      // the UI never observes the parent turn as done while its last subagent
      // card is still running.
      if (lifecycleSignal === 'complete') {
        emitPendingTurnCompletion();
      }

      // Extract and send token budget updates from result messages
      if (message.type === 'result') {
        const remainingQueryTurns = inputQueue.finishQueryTurn();
        const models = Object.keys(message.modelUsage || {});
        if (models.length > 0) {
          // Model info available in result message
        }
        const tokenBudgetData = extractTokenBudget(message);
        if (tokenBudgetData) {
          const tokenUsageData = extractTokenUsage(message);
          const tokenStatusMessage = createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget: tokenBudgetData,
            tokenUsage: tokenUsageData,
            sessionId: capturedSessionId || sessionId || null,
            provider: 'claude',
          });
          logChatSessionTokenUsage({
            requestId: runtimeOptions.logRequestId,
            provider: 'claude',
            sessionId: capturedSessionId || sessionId || null,
            model: models[0] || runtimeOptions.model || null,
            tokenBudget: tokenBudgetData,
            tokenUsage: tokenUsageData,
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

        const completedSessionId = capturedSessionId || sessionId || null;
        if (remainingQueryTurns > 0) {
          pendingTurnCompletion = null;
          turnLifecycle.finishResult(remainingQueryTurns);
          if (completedSessionId) {
            markSessionProcessing(completedSessionId);
          }
          continue;
        }

        pendingTurnCompletion = { sessionId: completedSessionId };
        if (turnLifecycle.finishResult(remainingQueryTurns)) {
          emitPendingTurnCompletion();
        }
      }
    }

    if (turnLifecycle.flush()) {
      emitPendingTurnCompletion();
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

    if (wasAborted) {
      ws.send(createNormalizedMessage({
        kind: 'complete',
        exitCode: 0,
        isNewSession: !sessionId && !!command,
        sessionId: finalSessionId,
        provider: 'claude',
        aborted: true,
        success: true,
      }));
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        stopReason: 'aborted'
      });
    }
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

    const failureSessionId = finalSessionId || pendingProviderSessionId;
    if (!finalSessionId && failureSessionId && runtimeOptions.runtimeId) {
      bindRuntimeMessagesToProviderSession({
        runtimeId: runtimeOptions.runtimeId,
        providerSessionId: failureSessionId,
        fromProviderSessionId: pendingProviderSessionId,
      });
    }
    agentSessionRuntimeManager.markFailed(runtimeOptions.runtimeId);
    recordProviderSession({ options: runtimeOptions, provider: 'claude', providerSessionId: failureSessionId, status: 'failed' });

    // Check if Claude CLI is installed for a clearer error message
    const installed = runtimeOptions.runtimeMode === 'docker'
      ? true
      : await providerAuthService.isProviderInstalled('claude');
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : processDiagnostics.redactText(error?.message || String(error));
    const diagnostics = processDiagnostics.snapshot({
      provider: 'claude',
      sessionId: failureSessionId,
      providerSessionId: failureSessionId,
      runtimeId: runtimeOptions.runtimeId || null,
      runtimeMode: runtimeOptions.runtimeMode || null,
      containerName: runtimeContext?.containerName || null,
      executable: runtimeOptions.pathToClaudeCodeExecutable || null,
      errorMessage: error?.message || String(error),
      errorCode: error?.code || null,
    });
    processDiagnostics.logSnapshot('sdk query error', {
      sessionId: failureSessionId,
      errorMessage: error?.message || String(error),
      errorCode: error?.code || null,
    });

    const errorMessage = createNormalizedMessage({
      kind: 'error',
      content: errorContent,
      sessionId: failureSessionId,
      provider: 'claude',
      diagnostics,
    });
    if (error?.code) {
      errorMessage.code = error.code;
    }
    if (Array.isArray(error?.failures)) {
      errorMessage.failures = processDiagnostics.redactValue(error.failures);
    }

    persistNormalizedMessages({
      options: runtimeOptions,
      provider: 'claude',
      providerSessionId: failureSessionId,
      runtimeId: runtimeOptions.runtimeId,
      messages: [errorMessage],
    });

    if (!finalSessionId && failureSessionId && !sessionCreatedSent) {
      sessionCreatedSent = true;
      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(failureSessionId);
      }
      ws.send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: failureSessionId,
        sessionId: failureSessionId,
        provider: 'claude',
        failed: true,
      }));
    }

    // Send error to WebSocket
    ws.send(errorMessage);
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: failureSessionId,
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
    if (session.idleCloseTimer) {
      clearTimeout(session.idleCloseTimer);
      session.idleCloseTimer = null;
    }
    session.inputQueue?.close();

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
  return Boolean(session && session.status === 'processing');
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

function normalizeSupplementMode(mode) {
  if (mode === 'context-only') {
    return { priority: 'later', shouldQuery: false };
  }
  if (mode === 'next') {
    return { priority: 'next', shouldQuery: true };
  }
  return { priority: 'now', shouldQuery: true };
}

function sendWriterMessage(writer, message) {
  if (!writer || typeof writer.send !== 'function') {
    return;
  }
  writer.send(message);
}

function pushClaudeSupplement({
  sessionId,
  content,
  displayContent = null,
  clientMessageId = null,
  mode = 'now',
  writer = null,
} = {}) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const normalizedContent = typeof content === 'string' ? content.trim() : '';
  const normalizedDisplayContent =
    typeof displayContent === 'string' && displayContent.trim()
      ? displayContent.trim()
      : normalizedContent;
  if (!normalizedSessionId || !normalizedContent) {
    return { success: false, error: 'sessionId and content are required' };
  }

  const session = getSession(normalizedSessionId);
  if (!session?.inputQueue) {
    return { success: false, error: 'Claude session is not accepting supplemental input' };
  }

  const { priority, shouldQuery } = normalizeSupplementMode(mode);
  if (shouldQuery) {
    try {
      session.runtimeOptions?.onConcurrencyResume?.();
    } catch (error) {
      if (error?.code === 'SESSION_LIMIT_EXCEEDED') {
        return {
          success: false,
          error: error.message,
          code: error.code,
          activeCount: error.activeCount,
          limit: error.limit,
          source: error.source,
          userId: error.userId,
        };
      }
      throw error;
    }
  }

  updateSessionWriter(normalizedSessionId, writer);

  const timestamp = new Date().toISOString();
  const messageId = typeof clientMessageId === 'string' && clientMessageId.trim()
    ? `supplement_${clientMessageId.trim().replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120)}`
    : null;
  const persistedMessage = createNormalizedMessage({
    kind: 'text',
    role: 'user',
    content: normalizedDisplayContent,
    sessionId: normalizedSessionId,
    provider: 'claude',
    timestamp,
    ...(messageId ? { id: messageId } : {}),
    isSupplement: true,
    supplementMode: mode,
  });

  persistNormalizedMessages({
    options: session.runtimeOptions,
    provider: 'claude',
    providerSessionId: normalizedSessionId,
    runtimeId: session.runtimeId,
    messages: [persistedMessage],
  });

  markSessionProcessing(normalizedSessionId);
  const claudeMessageId = createRequestId();
  void appendClaudeDisplayCommand({
    runtimeHomePath: session.runtimeOptions?.runtimeHomePath,
    projectPath: session.runtimeOptions?.projectPath || session.runtimeOptions?.cwd,
    sessionId: normalizedSessionId,
    messageId: claudeMessageId,
    displayCommand: normalizedDisplayContent,
    modelContent: normalizedContent,
    uid: session.runtimeOptions?.runtimeUid,
    gid: session.runtimeOptions?.runtimeGid,
  }).catch((error) => {
    console.warn(
      `[ClaudeDisplayCommand] Failed to persist supplemental display metadata for ${normalizedSessionId}:`,
      error?.message || error,
    );
  });
  session.inputQueue.push(buildClaudeUserMessage(normalizedContent, [], {
    uuid: claudeMessageId,
    priority,
    shouldQuery,
    timestamp,
  }));

  const targetWriter = writer || session.writer;
  sendWriterMessage(targetWriter, {
    type: 'claude-supplement-ack',
    sessionId: normalizedSessionId,
    clientMessageId,
    status: 'injected',
    mode,
    timestamp,
  });
  if (shouldQuery) {
    sendWriterMessage(targetWriter, createNormalizedMessage({
      kind: 'status',
      text: 'Processing',
      sessionId: normalizedSessionId,
      provider: 'claude',
      canInterrupt: true,
    }));
  }

  return { success: true };
}

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  mapCliOptionsToSDK,
  resolveToolApproval,
  resolveClaudeModel,
  loadMcpConfig,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  pushClaudeSupplement,
  createClaudePromptFactory,
  buildClaudeUserMessage,
  buildToolInteractionContext,
  createClaudeTurnLifecycleTracker,
  createPendingInteractionTracker,
};
