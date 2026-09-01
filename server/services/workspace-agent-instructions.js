import { promises as fs } from 'fs';
import crypto from 'crypto';
import path from 'path';

const CLAUDE_MEMORY_FILE = 'CLAUDE.md';
const LEGACY_AGENT_FILE = 'Agent.md';
const DOT_CLAUDE_MEMORY_FILE = path.join('.claude', 'CLAUDE.md');

async function readManagedFileIfPresent(filePath, fileName) {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink()) {
      const error = new Error(`${fileName} must not be a symbolic link`);
      error.code = 'ELOOP';
      error.statusCode = 400;
      throw error;
    }
    if (!stats.isFile()) {
      const error = new Error(`${fileName} must be a file`);
      error.code = 'EINVAL';
      error.statusCode = 400;
      throw error;
    }
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function inspectFile(filePath, relativePath) {
  try {
    const stats = await fs.lstat(filePath);
    return {
      path: relativePath,
      exists: true,
      isRegularFile: stats.isFile() && !stats.isSymbolicLink(),
      isSymbolicLink: stats.isSymbolicLink(),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { path: relativePath, exists: false, isRegularFile: false, isSymbolicLink: false };
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

function createRevision(claudeMarkdown) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ claudeMarkdown }))
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

async function replaceManagedFile(workspacePath, fileName, content) {
  const targetPath = path.join(workspacePath, fileName);
  const previousContent = await readManagedFileIfPresent(targetPath, fileName);
  let temporaryPath = null;
  try {
    temporaryPath = await writeTemporaryFile(workspacePath, fileName, content);
    await fs.rename(temporaryPath, targetPath);
    return { targetPath, previousContent };
  } catch (error) {
    if (temporaryPath) await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function inspectWorkspaceInstructionFiles(workspacePath, legacyConflict = false) {
  const dotClaude = await inspectFile(
    path.join(workspacePath, DOT_CLAUDE_MEMORY_FILE),
    DOT_CLAUDE_MEMORY_FILE,
  );
  const customInstructionFiles = [
    dotClaude.exists ? dotClaude.path : null,
    legacyConflict ? LEGACY_AGENT_FILE : null,
  ].filter(Boolean);
  return {
    legacyRootMirror: false,
    legacyAgentConflict: legacyConflict,
    customInstructionFiles,
    hasCustomInstructions: customInstructionFiles.length > 0,
  };
}

/**
 * Move the former platform-managed Agent.md memory into the root CLAUDE.md.
 * A user-authored CLAUDE.md always wins; a differing Agent.md is preserved as
 * a legacy file so migration never destroys user content.
 */
export async function migrateLegacyWorkspaceAgentInstructions(workspacePath) {
  await assertWorkspaceDirectory(workspacePath);
  const claudePath = path.join(workspacePath, CLAUDE_MEMORY_FILE);
  const legacyAgentPath = path.join(workspacePath, LEGACY_AGENT_FILE);
  const [claudeMarkdown, legacyAgentMarkdown] = await Promise.all([
    readManagedFileIfPresent(claudePath, CLAUDE_MEMORY_FILE),
    readManagedFileIfPresent(legacyAgentPath, LEGACY_AGENT_FILE),
  ]);

  if (legacyAgentMarkdown === null) {
    return { migrated: false, removed: false, removedPath: null, legacyConflict: false };
  }
  if (claudeMarkdown === null) {
    const written = await replaceManagedFile(workspacePath, CLAUDE_MEMORY_FILE, legacyAgentMarkdown);
    await fs.rm(legacyAgentPath);
    return {
      migrated: true,
      removed: true,
      removedPath: legacyAgentPath,
      writtenPath: written.targetPath,
      legacyConflict: false,
    };
  }
  if (claudeMarkdown === legacyAgentMarkdown) {
    await fs.rm(legacyAgentPath);
    return { migrated: false, removed: true, removedPath: legacyAgentPath, legacyConflict: false };
  }
  return { migrated: false, removed: false, removedPath: null, legacyConflict: true };
}

export async function readWorkspaceAgentInstructions(workspacePath) {
  const migration = await migrateLegacyWorkspaceAgentInstructions(workspacePath);
  const claudePath = path.join(workspacePath, CLAUDE_MEMORY_FILE);
  const claudeMarkdown = await readManagedFileIfPresent(claudePath, CLAUDE_MEMORY_FILE);
  const customInstructions = await inspectWorkspaceInstructionFiles(
    workspacePath,
    migration.legacyConflict,
  );

  return {
    content: claudeMarkdown ?? '',
    source: claudeMarkdown === null ? 'empty' : 'claude',
    revision: createRevision(claudeMarkdown),
    migration,
    customInstructions,
  };
}

export async function writeWorkspaceAgentInstructions(workspacePath, content) {
  const normalizedContent = String(content ?? '');
  await assertWorkspaceDirectory(workspacePath);
  const migration = await migrateLegacyWorkspaceAgentInstructions(workspacePath);
  const written = await replaceManagedFile(workspacePath, CLAUDE_MEMORY_FILE, normalizedContent);
  const customInstructions = await inspectWorkspaceInstructionFiles(
    workspacePath,
    migration.legacyConflict,
  );

  return {
    content: normalizedContent,
    paths: [written.targetPath],
    revision: createRevision(normalizedContent),
    migration,
    customInstructions,
  };
}

export const workspaceAgentInstructionFiles = Object.freeze({
  claude: CLAUDE_MEMORY_FILE,
  legacyAgent: LEGACY_AGENT_FILE,
  agent: LEGACY_AGENT_FILE,
  rootClaude: CLAUDE_MEMORY_FILE,
  dotClaude: DOT_CLAUDE_MEMORY_FILE,
});
