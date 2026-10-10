import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSCRIPT_TYPES = new Set(['user', 'assistant', 'attachment', 'system']);
const FORK_WORKER_PATH = fileURLToPath(new URL('./claude-session-fork-worker.js', import.meta.url));
const validSources = new WeakSet();

function forkError(message, statusCode = 409, code = 'CLAUDE_FORK_INVALID_HISTORY') {
  return Object.assign(new Error(message), { statusCode, code });
}

function requireUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw forkError(`Invalid ${label}`, 400, 'CLAUDE_FORK_INVALID_ID');
  }
  return value;
}

async function lstatIfExists(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function requirePathType(target, type) {
  const stat = await lstatIfExists(target);
  if (!stat) throw forkError('Claude source session was not found', 404, 'CLAUDE_FORK_NOT_FOUND');
  if (stat.isSymbolicLink() || (type === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw forkError('Claude session history contains an unsafe filesystem path');
  }
  return stat;
}

async function assertProjectPath(source) {
  for (const directory of [source.runtimeHomePath, source.configDirectory, source.projectsRoot, source.projectDirectory]) {
    await requirePathType(directory, 'directory');
  }
  if (await fs.realpath(source.projectDirectory) !== source.projectDirectory) {
    throw forkError('Claude session project directory changed');
  }
}

function parseJsonLines(content) {
  const lines = content.split(/\r?\n/);
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try {
      const entry = JSON.parse(lines[index]);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid entry');
      entries.push(entry);
    } catch {
      // A stopped append can leave an incomplete final line, but earlier
      // corruption must not silently remove part of the inherited context.
      if (index === lines.length - 1 && !content.endsWith('\n')) break;
      throw forkError('Claude session history contains an invalid record');
    }
  }
  return entries;
}

async function readPrivateFile(target) {
  await requirePathType(target, 'file');
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw forkError('Claude session history must be a regular file');
    return { content: await handle.readFile('utf8'), stat };
  } finally {
    await handle.close();
  }
}

/** Locate one session inside an explicitly selected user's runtime home. */
export async function readClaudeForkSource({ runtimeHomePath, sourceSessionId }) {
  requireUuid(sourceSessionId, 'source session id');
  if (typeof runtimeHomePath !== 'string' || !path.isAbsolute(runtimeHomePath)) {
    throw forkError('Claude runtime home must be an absolute path', 400);
  }
  await requirePathType(runtimeHomePath, 'directory');
  const resolvedHome = await fs.realpath(runtimeHomePath);
  const configDirectory = path.join(resolvedHome, '.claude');
  const projectsRoot = path.join(configDirectory, 'projects');
  await requirePathType(configDirectory, 'directory');
  await requirePathType(projectsRoot, 'directory');
  const matches = [];
  for (const entry of await fs.readdir(projectsRoot, { withFileTypes: true })) {
    // Never descend into symlinked projects, even if their target exists.
    if (!entry.isDirectory()) continue;
    const projectDirectory = path.join(projectsRoot, entry.name);
    await requirePathType(projectDirectory, 'directory');
    const filePath = path.join(projectDirectory, `${sourceSessionId}.jsonl`);
    if (await lstatIfExists(filePath)) matches.push({ projectDirectory, filePath });
  }
  if (matches.length === 0) throw forkError('Claude source session was not found', 404, 'CLAUDE_FORK_NOT_FOUND');
  if (matches.length !== 1) throw forkError('Claude source session has ambiguous history');
  const source = {
    runtimeHomePath: resolvedHome,
    configDirectory,
    projectsRoot,
    sourceSessionId,
    ...matches[0],
  };
  await assertProjectPath(source);
  const { content, stat } = await readPrivateFile(source.filePath);
  source.sourceEntries = parseJsonLines(content);
  if (source.sourceEntries.some((entry) => TRANSCRIPT_TYPES.has(entry.type)
    && entry.sessionId && entry.sessionId !== sourceSessionId)) {
    throw forkError('Claude session history does not belong to the source session');
  }
  source.stat = stat;
  validSources.add(source);
  return source;
}

async function assertUnchanged(source) {
  await assertProjectPath(source);
  const current = await requirePathType(source.filePath, 'file');
  if (current.ino !== source.stat.ino || current.dev !== source.stat.dev
    || current.size !== source.stat.size || current.mtimeMs !== source.stat.mtimeMs) {
    throw forkError('Claude source session changed; reload the conversation before branching');
  }
}

function transformWithSdk(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FORK_WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    let outputBytes = 0;
    let errorBytes = 0;
    const input = JSON.stringify(payload);
    const outputLimit = Math.max(Buffer.byteLength(input) * 3, 1024 * 1024);
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > outputLimit) child.kill('SIGKILL');
      else output.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errorBytes += chunk.length;
      if (errorBytes < 4096) errors.push(chunk);
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => {}); // Early worker exits are handled by close.
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(forkError(`Claude SDK could not branch this session: ${Buffer.concat(errors).toString('utf8') || 'worker failed'}`, 500));
        return;
      }
      try { resolve(JSON.parse(Buffer.concat(output).toString('utf8'))); }
      catch { reject(forkError('Claude SDK returned an invalid fork result', 500)); }
    });
    child.stdin.end(input);
  });
}

function remapMetadata(value, messageUuidMap) {
  if (typeof value === 'string') return messageUuidMap.get(value) || value;
  if (Array.isArray(value)) return value.map((item) => remapMetadata(item, messageUuidMap));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapMetadata(item, messageUuidMap)]));
}

function fixCompactionMetadata(entry, messageUuidMap) {
  for (const field of ['compactMetadata', 'compact_metadata']) {
    if (!entry[field]) continue;
    const metadata = entry[field];
    const preserved = metadata.preservedMessages;
    const segment = metadata.preservedSegment;
    const references = [
      ...(preserved ? [preserved.anchorUuid, ...(preserved.uuids || [])] : []),
      ...(segment ? [segment.anchorUuid, segment.headUuid, segment.tailUuid] : []),
    ].filter(Boolean);
    if (references.some((uuid) => !messageUuidMap.has(uuid))) {
      throw forkError('Claude compacted history has incomplete preserved messages');
    }
    entry[field] = remapMetadata(metadata, messageUuidMap);
  }
  return entry;
}

async function readDisplayRecords(source, messageUuidMap, sourceEntries) {
  const directory = path.join(source.projectDirectory, source.sourceSessionId);
  if (!await lstatIfExists(directory)) return [];
  await requirePathType(directory, 'directory');
  const filePath = path.join(directory, 'display-commands.jsonl');
  if (!await lstatIfExists(filePath)) return [];
  const { content } = await readPrivateFile(filePath);
  const messageIds = new Set(sourceEntries.filter((entry) => !entry.isSidechain
    && TRANSCRIPT_TYPES.has(entry.type)).map((entry) => entry.message?.id).filter(Boolean));
  const keptId = (value) => messageUuidMap.get(value) || (messageIds.has(value) ? value : null);
  return parseJsonLines(content).flatMap((entry) => {
    const messageId = keptId(entry.messageId);
    const anchor = entry.displayAfterAssistantId ? keptId(entry.displayAfterAssistantId) : undefined;
    if (!messageId || (entry.displayAfterAssistantId && !anchor)) return [];
    return [{
      ...entry,
      messageId,
      ...(anchor ? { displayAfterAssistantId: anchor } : {}),
      forkedFrom: { sessionId: source.sourceSessionId, messageUuid: entry.messageId },
    }];
  });
}

async function readCompletedReplyRecords(source, messageUuidMap) {
  const directory = path.join(source.projectDirectory, source.sourceSessionId);
  if (!await lstatIfExists(directory)) return [];
  await requirePathType(directory, 'directory');
  const filePath = path.join(directory, 'completed-replies.jsonl');
  if (!await lstatIfExists(filePath)) return [];
  const { content } = await readPrivateFile(filePath);
  return parseJsonLines(content).flatMap((entry) => {
    const mappedUuid = messageUuidMap.get(entry.sourceMessageUuid);
    if (!mappedUuid || typeof entry.completedAt !== 'string' || !Number.isFinite(Date.parse(entry.completedAt))) return [];
    // Completion is recorded after the assistant itself is persisted. Comparing
    // its timestamp to that reply would incorrectly discard the selected marker.
    // Membership in the inherited UUID map prevents copying any future reply.
    return [{
      version: 1,
      sourceMessageUuid: mappedUuid,
      completedAt: entry.completedAt,
      forkedFrom: { sessionId: source.sourceSessionId, messageUuid: entry.sourceMessageUuid },
    }];
  });
}

async function setOwnership(handle, owner) {
  const stat = await handle.stat();
  if (stat.uid !== owner.uid || stat.gid !== owner.gid) await handle.chown(owner.uid, owner.gid);
}

async function writePrivateFile(target, entries, owner) {
  const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    await setOwnership(handle, owner);
    await handle.writeFile(`${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await fs.unlink(target).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

/** Fork a stable native transcript, with no model invocation or shared env mutation. */
export async function forkClaudeSessionFiles({ runtimeHomePath, sourceSessionId, sourceMessageUuid, title, source: providedSource }) {
  requireUuid(sourceSessionId, 'source session id');
  requireUuid(sourceMessageUuid, 'source message id');
  const source = providedSource || await readClaudeForkSource({ runtimeHomePath, sourceSessionId });
  if (!validSources.has(source) || source.sourceSessionId !== sourceSessionId
    || await fs.realpath(runtimeHomePath) !== source.runtimeHomePath) {
    throw forkError('Invalid Claude source snapshot', 400);
  }
  await assertUnchanged(source);
  const cutoff = source.sourceEntries.findIndex((entry) => entry.uuid === sourceMessageUuid
    && entry.type === 'assistant' && !entry.isSidechain);
  if (cutoff < 0) throw forkError('The reply is not present in this Claude session', 400);
  const sourceEntries = source.sourceEntries.slice(0, cutoff + 1);
  const { sessionId, forkEntries: sdkEntries } = await transformWithSdk({
    sourceSessionId, sourceMessageUuid, sourceEntries, title,
  });
  requireUuid(sessionId, 'forked session id');
  if (sessionId === sourceSessionId) throw forkError('Claude SDK returned the source session id', 500);
  const messageUuidMap = new Map(sdkEntries.filter((entry) => entry.forkedFrom?.sessionId === sourceSessionId)
    .map((entry) => [entry.forkedFrom.messageUuid, entry.uuid]));
  if (!messageUuidMap.has(sourceMessageUuid)) throw forkError('Claude SDK omitted the branching reply', 500);
  const forkEntries = sdkEntries.filter((entry) => entry.type !== 'content-replacement')
    .map((entry) => fixCompactionMetadata(entry, messageUuidMap));
  // SDK 0.2.141 aggregates replacement records and leaves embedded UUIDs intact.
  // Rebuild from the cutoff snapshot so later edits cannot enter the branch.
  const replacements = sourceEntries.filter((entry) => entry.type === 'content-replacement'
    && entry.sessionId === sourceSessionId && Array.isArray(entry.replacements));
  forkEntries.splice(Math.max(forkEntries.length - 1, 0), 0, ...replacements.map((entry) => ({
    ...entry,
    uuid: randomUUID(),
    sessionId,
    replacements: remapMetadata(entry.replacements, messageUuidMap),
    forkedFrom: { sessionId: sourceSessionId, messageUuid: entry.uuid || sourceMessageUuid },
  })));
  const displayRecords = await readDisplayRecords(source, messageUuidMap, sourceEntries);
  const completedReplyRecords = await readCompletedReplyRecords(source, messageUuidMap);
  await assertUnchanged(source);
  const forkPath = path.join(source.projectDirectory, `${sessionId}.jsonl`);
  const forkDirectory = path.join(source.projectDirectory, sessionId);
  const temporaryPath = path.join(source.projectDirectory, `.ccui-fork-${randomUUID()}.tmp`);
  let createdFile = false;
  let createdDirectory = false;
  let createdTemporaryFile = false;
  const cleanup = async () => {
    await assertProjectPath(source);
    if (createdTemporaryFile) {
      await fs.unlink(temporaryPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      createdTemporaryFile = false;
    }
    if (createdDirectory) {
      await fs.rm(forkDirectory, { recursive: true, force: true });
      createdDirectory = false;
    }
    if (createdFile) {
      await fs.unlink(forkPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      createdFile = false;
    }
  };
  try {
    // Create the directory first, and publish the complete main transcript last.
    // This keeps list/watch consumers from seeing half-copied display metadata.
    if (displayRecords.length || completedReplyRecords.length) {
      await fs.mkdir(forkDirectory, { mode: 0o700 });
      createdDirectory = true;
      const directoryStat = await requirePathType(forkDirectory, 'directory');
      if (directoryStat.uid !== source.stat.uid || directoryStat.gid !== source.stat.gid) {
        await fs.chown(forkDirectory, source.stat.uid, source.stat.gid);
      }
      if (displayRecords.length) {
        await writePrivateFile(path.join(forkDirectory, 'display-commands.jsonl'), displayRecords, source.stat);
      }
      if (completedReplyRecords.length) {
        await writePrivateFile(path.join(forkDirectory, 'completed-replies.jsonl'), completedReplyRecords, source.stat);
      }
    }
    await writePrivateFile(temporaryPath, forkEntries, source.stat);
    createdTemporaryFile = true;
    await assertUnchanged(source);
    // Linking a complete private file publishes it atomically and fails if the
    // destination already exists. No watcher can read a partially written JSONL.
    await fs.link(temporaryPath, forkPath);
    createdFile = true;
    await fs.unlink(temporaryPath);
    createdTemporaryFile = false;
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { sessionId, projectDirectory: source.projectDirectory, messageUuidMap, sourceEntries, forkEntries, cleanup };
}
