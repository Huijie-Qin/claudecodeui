import { safeJsonParse } from '../../../lib/utils.js';
import type { ChatMessage, ClaudePermissionSuggestion, PermissionGrantResult } from '../types/types.js';

import { CLAUDE_SETTINGS_KEY, getClaudeSettings, safeLocalStorage } from './chatStorage';

const CLAUDE_PERMISSION_ERROR_MESSAGES = [
  'user denied tool use',
  'tool disallowed by settings',
  'permission request timed out',
  'permission request cancelled',
  'tool interaction timed out',
  'tool interaction cancelled',
  'user declined tool interaction',
];

function stringifyToolResultContent(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  if (Array.isArray(content)) {
    return content.map((item) => stringifyToolResultContent(item)).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') {
    const maybeText = content as { text?: unknown; content?: unknown; message?: unknown; error?: unknown };
    const text = stringifyToolResultContent(maybeText.text);
    const nestedContent = stringifyToolResultContent(maybeText.content);
    const message = stringifyToolResultContent(maybeText.message);
    const error = stringifyToolResultContent(maybeText.error);
    const parts = [text, nestedContent, message, error].filter(Boolean);
    if (parts.length) return parts.join('\n');
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

export function isClaudePermissionErrorContent(content: unknown): boolean {
  const normalizedContent = stringifyToolResultContent(content).toLowerCase().trim();
  return CLAUDE_PERMISSION_ERROR_MESSAGES.some((message) => normalizedContent.includes(message));
}

export function isClaudePermissionToolError(
  message: ChatMessage | null | undefined,
  provider: string,
): boolean {
  return Boolean(
    provider === 'claude' &&
    message?.toolResult?.isError &&
    isClaudePermissionErrorContent(message.toolResult.content),
  );
}

export function buildClaudeToolPermissionEntry(toolName?: string, toolInput?: unknown) {
  if (!toolName) return null;
  if (toolName !== 'Bash') return toolName;

  const parsed = safeJsonParse(toolInput);
  const command = typeof parsed?.command === 'string' ? parsed.command.trim() : '';
  if (!command) return toolName;

  const tokens = command.split(/\s+/);
  if (tokens.length === 0) return toolName;

  if (tokens[0] === 'git' && tokens[1]) {
    return `Bash(${tokens[0]} ${tokens[1]}:*)`;
  }
  return `Bash(${tokens[0]}:*)`;
}

export function formatToolInputForDisplay(input: unknown) {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export function getClaudePermissionSuggestion(
  message: ChatMessage | null | undefined,
  provider: string,
): ClaudePermissionSuggestion | null {
  if (!isClaudePermissionToolError(message, provider)) return null;
  if (!message) return null;

  const toolName = message?.toolName;
  const entry = buildClaudeToolPermissionEntry(toolName, message.toolInput);
  if (!entry) return null;

  const settings = getClaudeSettings();
  const isAllowed = settings.allowedTools.includes(entry);
  return { toolName: toolName || 'UnknownTool', entry, isAllowed };
}

export function grantClaudeToolPermission(entry: string | null): PermissionGrantResult {
  if (!entry) return { success: false };

  const settings = getClaudeSettings();
  const alreadyAllowed = settings.allowedTools.includes(entry);
  const nextAllowed = alreadyAllowed ? settings.allowedTools : [...settings.allowedTools, entry];
  const nextDisallowed = settings.disallowedTools.filter((tool) => tool !== entry);
  const updatedSettings = {
    ...settings,
    allowedTools: nextAllowed,
    disallowedTools: nextDisallowed,
    lastUpdated: new Date().toISOString(),
  };

  safeLocalStorage.setItem(CLAUDE_SETTINGS_KEY, JSON.stringify(updatedSettings));
  return { success: true, alreadyAllowed, updatedSettings };
}
