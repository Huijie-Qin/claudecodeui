import { promises as fs } from 'node:fs';
import path from 'node:path';

const CLAUDE_PROJECTS_DIRECTORY = path.join('.claude', 'projects');
const DISPLAY_COMMANDS_FILE_NAME = 'display-commands.jsonl';
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

function normalizeClaudeProjectStorageName(projectPath) {
  const normalizedProjectPath = normalizeIdentifier(projectPath);
  return normalizedProjectPath
    ? normalizedProjectPath.replace(/[^a-zA-Z0-9-]/g, '-')
    : '';
}

function resolveClaudeProjectsRoot(runtimeHomePath) {
  const normalizedRuntimeHomePath = normalizeIdentifier(runtimeHomePath);
  return normalizedRuntimeHomePath
    ? path.join(normalizedRuntimeHomePath, CLAUDE_PROJECTS_DIRECTORY)
    : null;
}

export function resolveClaudeDisplayCommandPath(runtimeHomePath, projectPath, sessionId) {
  const projectsRoot = resolveClaudeProjectsRoot(runtimeHomePath);
  const projectStorageName = normalizeClaudeProjectStorageName(projectPath);
  const normalizedSessionId = normalizeIdentifier(sessionId);
  if (
    !projectsRoot
    || !projectStorageName
    || !normalizedSessionId
    || !SAFE_SESSION_ID_PATTERN.test(normalizedSessionId)
  ) {
    return null;
  }

  return path.join(
    projectsRoot,
    projectStorageName,
    normalizedSessionId,
    DISPLAY_COMMANDS_FILE_NAME,
  );
}

async function findClaudeDisplayCommandPaths(runtimeHomePath, sessionId) {
  const projectsRoot = resolveClaudeProjectsRoot(runtimeHomePath);
  const normalizedSessionId = normalizeIdentifier(sessionId);
  if (
    !projectsRoot
    || !normalizedSessionId
    || !SAFE_SESSION_ID_PATTERN.test(normalizedSessionId)
  ) {
    return [];
  }

  let entries;
  try {
    entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const displayCommandPaths = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const projectDirectory = path.join(projectsRoot, entry.name);
    try {
      await fs.access(path.join(projectDirectory, `${normalizedSessionId}.jsonl`));
      displayCommandPaths.push(path.join(
        projectDirectory,
        normalizedSessionId,
        DISPLAY_COMMANDS_FILE_NAME,
      ));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return displayCommandPaths;
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
  projectPath,
  sessionId,
  messageId,
  displayCommand,
  modelContent,
}) {
  const filePath = resolveClaudeDisplayCommandPath(runtimeHomePath, projectPath, sessionId);
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
  const displayCommands = new Map();
  const filePaths = await findClaudeDisplayCommandPaths(runtimeHomePath, sessionId);
  for (const filePath of filePaths) {
    await waitForPendingWrite(filePath);

    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue;
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
  }

  return displayCommands;
}
