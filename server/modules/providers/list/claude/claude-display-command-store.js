import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

const CLAUDE_PROJECTS_DIRECTORY = path.join('.claude', 'projects');
const DISPLAY_COMMANDS_FILE_NAME = 'display-commands.jsonl';
const SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const SLASH_COMMAND_PATTERN = /^\/[^\s/]+(?:\s[\s\S]*)?$/;
const SESSION_DIRECTORY_MODE = 0o700;
const DISPLAY_COMMAND_FILE_MODE = 0o600;
const DISPLAY_COMMAND_OPEN_FLAGS = fsConstants.O_APPEND
  | fsConstants.O_CREAT
  | fsConstants.O_WRONLY
  | (fsConstants.O_NOFOLLOW || 0);
const pendingWrites = new Map();

function normalizeIdentifier(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function normalizeOwnership(uid, gid) {
  if (uid == null && gid == null) {
    return null;
  }
  if (!isNonNegativeInteger(uid) || !isNonNegativeInteger(gid)) {
    throw new TypeError('Claude display command owner uid and gid must be non-negative integers');
  }
  return { uid, gid };
}

function assertPathType(stats, targetPath, expectedType) {
  if (stats.isSymbolicLink()) {
    throw new Error(`Claude display command path must not be a symbolic link: ${targetPath}`);
  }
  if (expectedType === 'directory' && !stats.isDirectory()) {
    throw new Error(`Claude display command path must be a directory: ${targetPath}`);
  }
  if (expectedType === 'file' && !stats.isFile()) {
    throw new Error(`Claude display command path must be a regular file: ${targetPath}`);
  }
}

async function lstatIfExists(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function securePrivateDirectory(directoryPath, ownership) {
  await fs.mkdir(directoryPath, {
    recursive: true,
    mode: SESSION_DIRECTORY_MODE,
  });
  const stats = await fs.lstat(directoryPath);
  assertPathType(stats, directoryPath, 'directory');

  await fs.chmod(directoryPath, SESSION_DIRECTORY_MODE);
  if (ownership && (stats.uid !== ownership.uid || stats.gid !== ownership.gid)) {
    await fs.chown(directoryPath, ownership.uid, ownership.gid);
  }
}

async function secureDisplayCommandDirectories(runtimeHomePath, filePath, ownership) {
  const projectsRoot = resolveClaudeProjectsRoot(runtimeHomePath);
  const projectDirectory = path.dirname(path.dirname(filePath));
  const sessionDirectory = path.dirname(filePath);
  const directories = [
    path.dirname(projectsRoot),
    projectsRoot,
    projectDirectory,
    sessionDirectory,
  ];

  for (const directoryPath of directories) {
    await securePrivateDirectory(directoryPath, ownership);
  }
}

async function appendPrivateRecord(filePath, record, ownership) {
  const existingStats = await lstatIfExists(filePath);
  if (existingStats) {
    assertPathType(existingStats, filePath, 'file');
  }

  const fileHandle = await fs.open(
    filePath,
    DISPLAY_COMMAND_OPEN_FLAGS,
    DISPLAY_COMMAND_FILE_MODE,
  );
  try {
    const stats = await fileHandle.stat();
    if (!stats.isFile()) {
      throw new Error(`Claude display command path must be a regular file: ${filePath}`);
    }
    await fileHandle.chmod(DISPLAY_COMMAND_FILE_MODE);
    if (ownership && (stats.uid !== ownership.uid || stats.gid !== ownership.gid)) {
      await fileHandle.chown(ownership.uid, ownership.gid);
    }
    await fileHandle.appendFile(`${record}\n`, 'utf8');
  } finally {
    await fileHandle.close();
  }
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
  uid = null,
  gid = null,
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
  const ownership = normalizeOwnership(uid, gid);

  await serializeWrite(filePath, async () => {
    await secureDisplayCommandDirectories(runtimeHomePath, filePath, ownership);
    await appendPrivateRecord(filePath, record, ownership);
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

export async function deleteClaudeDisplayCommands({
  runtimeHomePath,
  sessionId,
}) {
  const filePaths = await findClaudeDisplayCommandPaths(runtimeHomePath, sessionId);
  let deleted = false;

  for (const filePath of filePaths) {
    await waitForPendingWrite(filePath);
    try {
      await fs.unlink(filePath);
      deleted = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return deleted;
}
