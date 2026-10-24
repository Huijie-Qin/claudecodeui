import crypto from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

const RESULT_DIRECTORY = ['.cloudcli', 'hook-results', 'mcp-loops'];
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);

async function assertDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`MCP loop result path is not a safe directory: ${directory}`);
  }
  return stat;
}

async function assertDestination(destination) {
  try {
    const stat = await fs.lstat(destination);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`MCP loop result path is not a safe file: ${destination}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

// The file contains the complete terminal envelope. Only its runtime-visible
// path is returned to the conversation; no business data is included here.
export async function writeMcpLoopResultFile(job, { mode = 'local', completedAtMs = Date.now() } = {}) {
  if (!job || typeof job.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(job.id)) {
    throw new Error('MCP loop result requires a safe job ID');
  }
  if (typeof job.workspaceRoot !== 'string' || !path.isAbsolute(job.workspaceRoot)) {
    throw new Error('MCP loop result requires an absolute workspace root');
  }
  if (!TERMINAL_STATUSES.has(job.status)) throw new Error('MCP loop result is not terminal');
  if (mode !== 'local' && mode !== 'docker') throw new Error('Unsupported MCP loop result runtime mode');

  const payload = {
    mcpLoop: true,
    replacesToolUseId: job.toolUseId,
    status: job.status,
    attempts: job.attemptCount,
    elapsedMs: Math.max(0, (job.completedAtMs || completedAtMs) - job.startedAtMs),
    result: job.lastResult,
    ...(job.error ? { error: job.error } : {}),
  };
  const content = `${JSON.stringify(payload, null, 2)}\n`;

  // Canonicalize trusted system aliases such as macOS /tmp. Never follow a
  // symlink at the workspace root or in the writable result directory tree.
  await assertDirectory(job.workspaceRoot);
  const workspaceRoot = await fs.realpath(job.workspaceRoot);
  let directory = workspaceRoot;
  for (const segment of RESULT_DIRECTORY) {
    directory = path.join(directory, segment);
    try { await fs.mkdir(directory, { mode: 0o755 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const stat = await assertDirectory(directory);
    // .cloudcli may contain private resources: add only traversal permission
    // to an existing directory, as Hook resource materialization does.
    const targetMode = segment === '.cloudcli' ? (stat.mode & 0o777) | 0o111 : 0o755;
    if ((stat.mode & 0o777) !== targetMode) await fs.chmod(directory, targetMode);
  }
  const assertResultDirectory = async () => {
    let ancestor = workspaceRoot;
    await assertDirectory(ancestor);
    for (const segment of RESULT_DIRECTORY) {
      ancestor = path.join(ancestor, segment);
      await assertDirectory(ancestor);
    }
    if (await fs.realpath(directory) !== directory) {
      throw new Error('MCP loop result directory changed outside the workspace');
    }
  };
  await assertResultDirectory();
  const destination = path.join(directory, `${job.id}.json`);
  await assertDestination(destination);
  const temporary = path.join(directory, `.${job.id}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.chmod(0o644);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertResultDirectory();
    await assertDestination(destination);
    await fs.rename(temporary, destination);
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  }
  return {
    resultFile: mode === 'docker'
      ? path.posix.join('/workspace', ...RESULT_DIRECTORY, `${job.id}.json`)
      : destination,
  };
}
