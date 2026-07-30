import { promises as fs } from 'node:fs';
import path from 'node:path';

const DISPLAY_COMMANDS_DIRECTORY = path.join('.cloudcli', 'claude-display-commands');
const SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const SLASH_COMMAND_PATTERN = /^\/[^\s/]+(?:\s[\s\S]*)?$/;
const pendingWrites = new Map();

function normalizeIdentifier(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeClaudeDisplayCommand(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized && SLASH_COMMAND_PATTERN.test(normalized)
    ? normalized
    : null;
}

export function resolveClaudeDisplayCommandPath(runtimeHomePath, sessionId) {
  const normalizedRuntimeHomePath = normalizeIdentifier(runtimeHomePath);
  const normalizedSessionId = normalizeIdentifier(sessionId);
  if (
    !normalizedRuntimeHomePath
    || !normalizedSessionId
    || !SAFE_SESSION_ID_PATTERN.test(normalizedSessionId)
  ) {
    return null;
  }

  return path.join(
    normalizedRuntimeHomePath,
    DISPLAY_COMMANDS_DIRECTORY,
    `${normalizedSessionId}.jsonl`,
  );
}

async function waitForPendingWrite(filePath) {
  const pendingWrite = pendingWrites.get(filePath);
  if (pendingWrite) {
    await pendingWrite.catch(() => {});
  }
}

async function serializeWrite(filePath, operation) {
  const previousWrite = pendingWrites.get(filePath) || Promise.resolve();
  const currentWrite = previousWrite
    .catch(() => {})
    .then(operation);
  pendingWrites.set(filePath, currentWrite);

  try {
    return await currentWrite;
  } finally {
    if (pendingWrites.get(filePath) === currentWrite) {
      pendingWrites.delete(filePath);
    }
  }
}

export async function appendClaudeDisplayCommand({
  runtimeHomePath,
  sessionId,
  messageId,
  displayCommand,
  modelContent,
}) {
  const filePath = resolveClaudeDisplayCommandPath(runtimeHomePath, sessionId);
  const normalizedMessageId = normalizeIdentifier(messageId);
  const normalizedDisplayCommand = normalizeClaudeDisplayCommand(displayCommand);
  const normalizedModelContent = typeof modelContent === 'string'
    ? modelContent.trim()
    : '';

  if (
    !filePath
    || !normalizedMessageId
    || !normalizedDisplayCommand
    || normalizedDisplayCommand === normalizedModelContent
  ) {
    return false;
  }

  const record = JSON.stringify({
    version: 1,
    messageId: normalizedMessageId,
    displayCommand: normalizedDisplayCommand,
  });

  await serializeWrite(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${record}\n`, 'utf8');
  });
  return true;
}

export async function readClaudeDisplayCommands({
  runtimeHomePath,
  sessionId,
}) {
  const filePath = resolveClaudeDisplayCommandPath(runtimeHomePath, sessionId);
  const displayCommands = new Map();
  if (!filePath) {
    return displayCommands;
  }

  await waitForPendingWrite(filePath);

  let content;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return displayCommands;
    }
    throw error;
  }

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const record = JSON.parse(line);
      const messageId = normalizeIdentifier(record?.messageId);
      const displayCommand = normalizeClaudeDisplayCommand(record?.displayCommand);
      if (messageId && displayCommand) {
        displayCommands.set(messageId, displayCommand);
      }
    } catch {
      // Ignore a partial final line if the process stopped during an append.
    }
  }

  return displayCommands;
}

export async function deleteClaudeDisplayCommands({
  runtimeHomePath,
  sessionId,
}) {
  const filePath = resolveClaudeDisplayCommandPath(runtimeHomePath, sessionId);
  if (!filePath) {
    return false;
  }

  await waitForPendingWrite(filePath);
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
