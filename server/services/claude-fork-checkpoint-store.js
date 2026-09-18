import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

export const CLAUDE_COMPLETED_REPLIES_FILE = 'completed-replies.jsonl';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pendingWrites = new Map();

async function requireDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe Claude checkpoint directory');
  return stat;
}

async function checkpointRoot(runtimeHomePath) {
  if (typeof runtimeHomePath !== 'string' || !path.isAbsolute(runtimeHomePath)) return null;
  await requireDirectory(runtimeHomePath);
  return path.join(runtimeHomePath, '.claude', 'projects');
}

export async function appendClaudeCompletedReply({
  runtimeHomePath, projectPath, sessionId, sourceMessageUuid, uid = null, gid = null,
}) {
  if (!UUID.test(sessionId || '') || !UUID.test(sourceMessageUuid || '')) return false;
  const root = await checkpointRoot(runtimeHomePath);
  const projectStorageName = typeof projectPath === 'string'
    ? projectPath.trim().replace(/[^a-zA-Z0-9-]/g, '-') : '';
  if (!root || !projectStorageName) return false;
  const filePath = path.join(root, projectStorageName, sessionId, CLAUDE_COMPLETED_REPLIES_FILE);
  const operation = (pendingWrites.get(filePath) || Promise.resolve()).catch(() => {}).then(async () => {
    const homeStat = await requireDirectory(runtimeHomePath);
    const owner = { uid: uid ?? homeStat.uid, gid: gid ?? homeStat.gid };
    if (!Number.isInteger(owner.uid) || owner.uid < 0 || !Number.isInteger(owner.gid) || owner.gid < 0) {
      throw new Error('Invalid Claude checkpoint ownership');
    }
    // The SDK may not have flushed the transcript yet. Create only the known
    // runtime project directories; the fork reader later verifies the UUID.
    for (const directory of [path.dirname(root), root, path.dirname(path.dirname(filePath)), path.dirname(filePath)]) {
      await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await requireDirectory(directory);
      await fs.chmod(directory, 0o700);
      if (stat.uid !== owner.uid || stat.gid !== owner.gid) await fs.chown(directory, owner.uid, owner.gid);
    }
    const existing = await fs.lstat(filePath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Unsafe Claude checkpoint file');
    const handle = await fs.open(filePath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Unsafe Claude checkpoint file');
      await handle.chmod(0o600);
      if (stat.uid !== owner.uid || stat.gid !== owner.gid) await handle.chown(owner.uid, owner.gid);
      await handle.writeFile(`${JSON.stringify({ version: 1, sourceMessageUuid, completedAt: new Date().toISOString() })}\n`);
      await handle.sync();
    } finally { await handle.close(); }
  });
  pendingWrites.set(filePath, operation);
  try { await operation; } finally { if (pendingWrites.get(filePath) === operation) pendingWrites.delete(filePath); }
  return true;
}

export async function readClaudeCompletedReplies({ runtimeHomePath, sessionId }) {
  const replies = new Set();
  if (!UUID.test(sessionId || '')) return replies;
  const root = await checkpointRoot(runtimeHomePath);
  if (!root) return replies;
  let projects;
  try {
    await requireDirectory(path.dirname(root));
    await requireDirectory(root);
    projects = await fs.readdir(root, { withFileTypes: true });
  } catch (error) { if (error.code === 'ENOENT') return replies; throw error; }
  let found = false;
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const directory = path.join(root, project.name, sessionId);
    const filePath = path.join(directory, CLAUDE_COMPLETED_REPLIES_FILE);
    await pendingWrites.get(filePath)?.catch(() => {});
    let handle;
    try {
      await requireDirectory(path.dirname(directory));
      await requireDirectory(directory);
      handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      if (!(await handle.stat()).isFile()) throw new Error('Unsafe Claude checkpoint file');
      if (found) throw new Error('Ambiguous Claude checkpoint history');
      found = true;
      for (const line of (await handle.readFile('utf8')).split(/\r?\n/)) {
        try {
          const record = JSON.parse(line);
          if (record.version === 1 && UUID.test(record.sourceMessageUuid || '')) replies.add(record.sourceMessageUuid);
        } catch { /* Ignore a partial append after an interrupted write. */ }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { await handle?.close(); }
  }
  return replies;
}
