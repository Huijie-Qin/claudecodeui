import { promises as fs } from 'fs';
import crypto from 'crypto';
import path from 'path';

const AGENT_INSTRUCTIONS_FILE = 'Agent.md';
const ROOT_CLAUDE_INSTRUCTIONS_FILE = 'CLAUDE.md';
const DOT_CLAUDE_INSTRUCTIONS_FILE = path.join('.claude', 'CLAUDE.md');

async function readManagedFileIfPresent(filePath) {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink()) {
      const error = new Error('Agent.md must not be a symbolic link');
      error.code = 'ELOOP';
      error.statusCode = 400;
      throw error;
    }
    if (!stats.isFile()) {
      const error = new Error('Agent.md must be a file');
      error.code = 'EINVAL';
      error.statusCode = 400;
      throw error;
    }
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function inspectUserInstructionFile(
  filePath,
  relativePath,
  { includeContent = false, expectedByteLength = null } = {},
) {
  try {
    const stats = await fs.lstat(filePath);
    const isRegularFile = stats.isFile() && !stats.isSymbolicLink();
    return {
      path: relativePath,
      exists: true,
      isRegularFile,
      isSymbolicLink: stats.isSymbolicLink(),
      content: includeContent
        && isRegularFile
        && (expectedByteLength === null || stats.size === expectedByteLength)
        ? await fs.readFile(filePath, 'utf8')
        : null,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        path: relativePath,
        exists: false,
        isRegularFile: false,
        isSymbolicLink: false,
        content: null,
      };
    }
    throw error;
  }
}

async function assertWorkspaceDirectory(workspacePath) {
  const workspaceStats = await fs.stat(workspacePath);
  if (!workspaceStats.isDirectory()) {
    const error = new Error('Workspace path is not a directory');
    error.code = 'ENOTDIR';
    throw error;
  }
}

function createRevision(agentMarkdown) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ agentMarkdown }))
    .digest('hex');
}

async function writeTemporaryFile(workspacePath, fileName, content) {
  const temporaryPath = path.join(
    workspacePath,
    `.${fileName}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await fs.writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
  return temporaryPath;
}

async function restoreFile(workspacePath, targetPath, fileName, previousContent) {
  if (previousContent === null) {
    await fs.rm(targetPath, { force: true });
    return;
  }

  const restorePath = await writeTemporaryFile(workspacePath, `${fileName}.restore`, previousContent);
  await fs.rename(restorePath, targetPath);
}

async function inspectWorkspaceInstructionFiles(workspacePath, agentMarkdown) {
  const rootClaudePath = path.join(workspacePath, ROOT_CLAUDE_INSTRUCTIONS_FILE);
  const dotClaudePath = path.join(workspacePath, DOT_CLAUDE_INSTRUCTIONS_FILE);
  const [rootClaude, dotClaude] = await Promise.all([
    inspectUserInstructionFile(rootClaudePath, ROOT_CLAUDE_INSTRUCTIONS_FILE, {
      includeContent: agentMarkdown !== null,
      expectedByteLength: agentMarkdown === null ? null : Buffer.byteLength(agentMarkdown, 'utf8'),
    }),
    inspectUserInstructionFile(dotClaudePath, DOT_CLAUDE_INSTRUCTIONS_FILE),
  ]);

  const legacyRootMirror = agentMarkdown !== null
    && rootClaude.isRegularFile
    && rootClaude.content === agentMarkdown;
  const customInstructionFiles = [
    rootClaude.exists && !legacyRootMirror ? rootClaude.path : null,
    dotClaude.exists ? dotClaude.path : null,
  ].filter(Boolean);

  return {
    legacyRootMirror,
    customInstructionFiles,
    hasCustomInstructions: customInstructionFiles.length > 0,
  };
}

/**
 * Remove the root CLAUDE.md created by older CloudCLI versions only when it is
 * still byte-for-byte identical to Agent.md. User-authored or symlinked files
 * are never removed.
 */
async function removeRootClaudeMirrorIfUnchanged(workspacePath, expectedContent) {
  const rootClaudePath = path.join(workspacePath, ROOT_CLAUDE_INSTRUCTIONS_FILE);
  if (expectedContent === null) {
    return { removed: false, removedPath: null };
  }

  const rootClaude = await inspectUserInstructionFile(
    rootClaudePath,
    ROOT_CLAUDE_INSTRUCTIONS_FILE,
    { includeContent: true, expectedByteLength: Buffer.byteLength(expectedContent, 'utf8') },
  );
  if (!rootClaude.isRegularFile || rootClaude.content !== expectedContent) {
    return { removed: false, removedPath: null };
  }

  // Re-read before deletion so an edit made during migration is preserved.
  const latestRootClaude = await inspectUserInstructionFile(
    rootClaudePath,
    ROOT_CLAUDE_INSTRUCTIONS_FILE,
    { includeContent: true, expectedByteLength: Buffer.byteLength(expectedContent, 'utf8') },
  );
  if (!latestRootClaude.isRegularFile || latestRootClaude.content !== expectedContent) {
    return { removed: false, removedPath: null };
  }

  await fs.rm(rootClaudePath);
  return { removed: true, removedPath: rootClaudePath };
}

export async function migrateLegacyWorkspaceAgentInstructions(workspacePath) {
  await assertWorkspaceDirectory(workspacePath);
  const agentPath = path.join(workspacePath, AGENT_INSTRUCTIONS_FILE);
  const agentMarkdown = await readManagedFileIfPresent(agentPath);
  return removeRootClaudeMirrorIfUnchanged(workspacePath, agentMarkdown);
}

export async function readWorkspaceAgentInstructions(workspacePath) {
  await assertWorkspaceDirectory(workspacePath);
  const agentPath = path.join(workspacePath, AGENT_INSTRUCTIONS_FILE);
  const agentMarkdown = await readManagedFileIfPresent(agentPath);
  const customInstructions = await inspectWorkspaceInstructionFiles(workspacePath, agentMarkdown);

  return {
    content: agentMarkdown ?? '',
    source: agentMarkdown === null ? 'empty' : 'agent',
    revision: createRevision(agentMarkdown),
    customInstructions,
  };
}

export async function writeWorkspaceAgentInstructions(workspacePath, content) {
  const normalizedContent = String(content ?? '');
  const agentPath = path.join(workspacePath, AGENT_INSTRUCTIONS_FILE);
  await assertWorkspaceDirectory(workspacePath);

  const previousAgent = await readManagedFileIfPresent(agentPath);
  let agentTemporaryPath = null;
  let agentReplaced = false;

  try {
    agentTemporaryPath = await writeTemporaryFile(workspacePath, AGENT_INSTRUCTIONS_FILE, normalizedContent);
    await fs.rename(agentTemporaryPath, agentPath);
    agentTemporaryPath = null;
    agentReplaced = true;
  } catch (error) {
    if (agentTemporaryPath) {
      await fs.rm(agentTemporaryPath, { force: true }).catch(() => {});
    }
    if (agentReplaced) {
      await restoreFile(workspacePath, agentPath, AGENT_INSTRUCTIONS_FILE, previousAgent).catch(() => {});
    }
    throw error;
  }

  let migration = { removed: false, removedPath: null };
  try {
    migration = await removeRootClaudeMirrorIfUnchanged(workspacePath, previousAgent);
  } catch (error) {
    // Cleaning up an old duplicate must never turn a successful Agent.md save
    // into a failed request. The duplicate can be retried on the next session.
    migration = {
      removed: false,
      removedPath: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const customInstructions = await inspectWorkspaceInstructionFiles(workspacePath, normalizedContent);

  return {
    content: normalizedContent,
    paths: [agentPath],
    revision: createRevision(normalizedContent),
    migration,
    customInstructions,
  };
}

export const workspaceAgentInstructionFiles = Object.freeze({
  agent: AGENT_INSTRUCTIONS_FILE,
  rootClaude: ROOT_CLAUDE_INSTRUCTIONS_FILE,
  dotClaude: DOT_CLAUDE_INSTRUCTIONS_FILE,
});
