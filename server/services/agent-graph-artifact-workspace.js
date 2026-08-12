import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import { applyWorkspaceOwnership } from './workspace-ownership.js';

const EXECUTIONS_DIRECTORY = path.join('.ccui', 'agent-graph-executions');
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const ARTIFACT_TYPES = new Set(['dataset', 'file', 'report', 'other']);
const DEFAULT_READ_LIMIT = 16_000;
const MAX_READ_LIMIT = 64_000;
const registryWriteQueues = new Map();

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireSafeId(value, label) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!SAFE_ID_PATTERN.test(id)) throw createHttpError(`Invalid ${label}`);
  return id;
}

function executionPaths(workspacePath, executionId) {
  const workspaceRoot = path.resolve(workspacePath);
  const id = requireSafeId(executionId, 'Agent Graph execution id');
  const root = path.join(workspaceRoot, EXECUTIONS_DIRECTORY, id);
  return {
    workspaceRoot,
    root,
    contextDirectory: path.join(root, 'context'),
    artifactsDirectory: path.join(root, 'artifacts'),
    resultsDirectory: path.join(root, 'results'),
    traceDirectory: path.join(root, 'trace'),
    registryPath: path.join(root, 'artifacts', 'registry.json'),
    contextPath: path.join(root, 'context', 'execution_context.json'),
    tracePath: path.join(root, 'trace', 'execution_trace.json'),
  };
}

async function writeFileAtomic(filePath, content) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, content);
  await fs.rename(tempPath, filePath);
}

async function writeJsonAtomic(filePath, value) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonIfMissing(filePath, value) {
  try {
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(fallback);
    if (error instanceof SyntaxError) throw createHttpError('Agent Graph Artifact Registry is invalid', 500);
    throw error;
  }
}

async function applyOwnership(paths, targets, reason) {
  await applyWorkspaceOwnership({
    workspaceRoot: paths.workspaceRoot,
    targetPaths: targets,
    reason,
  });
}

function normalizeArtifactType(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ARTIFACT_TYPES.has(normalized) ? normalized : 'other';
}

function safeArtifactName(value, fallback = 'Agent artifact') {
  const name = typeof value === 'string' ? value.trim() : '';
  return (name || fallback).slice(0, 240);
}

function inferRowCount(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length;
  if (typeof value !== 'object') return null;
  for (const key of ['rows', 'data', 'items', 'results', 'records']) {
    if (Array.isArray(value[key])) return value[key].length;
  }
  for (const child of Object.values(value).slice(0, 20)) {
    const count = inferRowCount(child, depth + 1);
    if (count !== null) return count;
  }
  return null;
}

function serializeToolResponse(toolResponse) {
  try {
    return `${JSON.stringify(toolResponse, null, 2)}\n`;
  } catch {
    return `${String(toolResponse)}\n`;
  }
}

function artifactReference(artifact, description = '') {
  return {
    artifactId: artifact.artifactId,
    type: artifact.type,
    description: description || artifact.name,
  };
}

function artifactMetadataForAgent(artifact) {
  return {
    artifactId: artifact.artifactId,
    executionId: artifact.executionId,
    type: artifact.type,
    name: artifact.name,
    producerAgentId: artifact.producerAgentId,
    metadata: artifact.metadata || {},
    createdAt: artifact.createdAt,
  };
}

async function withRegistryWriteLock(registryPath, callback) {
  const previous = registryWriteQueues.get(registryPath) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  registryWriteQueues.set(registryPath, current);
  await previous.catch(() => {});
  try {
    return await callback();
  } finally {
    release();
    if (registryWriteQueues.get(registryPath) === current) registryWriteQueues.delete(registryPath);
  }
}

export async function initializeExecutionWorkspace({ workspacePath, executionId, context = null, trace = [] }) {
  const paths = executionPaths(workspacePath, executionId);
  let rootCreated = false;
  try {
    await fs.access(paths.root);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    rootCreated = true;
  }
  await Promise.all([
    fs.mkdir(paths.contextDirectory, { recursive: true }),
    fs.mkdir(paths.artifactsDirectory, { recursive: true }),
    fs.mkdir(paths.resultsDirectory, { recursive: true }),
    fs.mkdir(paths.traceDirectory, { recursive: true }),
  ]);
  const registry = await readJson(paths.registryPath, []);
  await Promise.all([
    writeJsonIfMissing(paths.registryPath, Array.isArray(registry) ? registry : []),
    context
      ? writeJsonAtomic(paths.contextPath, context)
      : writeJsonIfMissing(paths.contextPath, { executionId }),
    trace.length
      ? writeJsonAtomic(paths.tracePath, trace)
      : writeJsonIfMissing(paths.tracePath, []),
  ]);
  if (rootCreated) await applyOwnership(paths, [paths.root], 'agent_graph_execution_workspace');
  return { executionId, artifactCount: Array.isArray(registry) ? registry.length : 0 };
}

export async function listArtifacts({ workspacePath, executionId }) {
  const paths = executionPaths(workspacePath, executionId);
  const registry = await readJson(paths.registryPath, []);
  return Array.isArray(registry) ? structuredClone(registry) : [];
}

export async function getArtifactMetadata({ workspacePath, executionId, artifactId }) {
  const id = requireSafeId(artifactId, 'Artifact id');
  const artifact = (await listArtifacts({ workspacePath, executionId }))
    .find((entry) => entry.artifactId === id);
  if (!artifact) throw createHttpError('Agent Graph Artifact not found', 404);
  return artifact;
}

export async function registerArtifact({
  workspacePath,
  executionId,
  artifactId,
  producerAgentId,
  type = 'other',
  name,
  content,
  extension = 'json',
  mediaType = 'application/json',
  metadata = {},
  createdAt = new Date().toISOString(),
}) {
  const paths = executionPaths(workspacePath, executionId);
  await initializeExecutionWorkspace({ workspacePath, executionId });
  const id = requireSafeId(artifactId, 'Artifact id');
  const safeExtension = /^[a-zA-Z0-9]{1,12}$/.test(extension) ? extension.toLowerCase() : 'bin';
  const filename = `${id}.${safeExtension}`;
  const artifactPath = path.join(paths.artifactsDirectory, filename);
  const payload = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  await writeFileAtomic(artifactPath, payload);
  const artifact = {
    artifactId: id,
    executionId,
    type: normalizeArtifactType(type),
    name: safeArtifactName(name),
    location: path.posix.join('artifacts', filename),
    producerAgentId: requireSafeId(producerAgentId, 'Artifact producer Agent id'),
    metadata: {
      mediaType,
      sizeBytes: payload.byteLength,
      ...metadata,
    },
    createdAt,
  };
  await withRegistryWriteLock(paths.registryPath, async () => {
    const registry = await readJson(paths.registryPath, []);
    const nextRegistry = [...registry.filter((entry) => entry.artifactId !== id), artifact];
    await writeJsonAtomic(paths.registryPath, nextRegistry);
  });
  await applyOwnership(paths, [artifactPath, paths.registryPath], 'agent_graph_artifact_write');
  return structuredClone(artifact);
}

export async function captureMcpToolResult({
  workspacePath,
  executionId,
  producerAgentId,
  artifactId,
  toolName,
  toolUseId,
  toolResponse,
  createdAt,
  largeResultThreshold = 12_000,
  previewLimit = 4_000,
}) {
  const serialized = serializeToolResponse(toolResponse);
  const artifact = await registerArtifact({
    workspacePath,
    executionId,
    producerAgentId,
    artifactId,
    type: 'dataset',
    name: `${toolName || 'MCP'} result`,
    content: serialized,
    extension: 'json',
    mediaType: 'application/json',
    metadata: {
      source: 'mcp-tool-result',
      toolName: toolName || null,
      toolUseId: toolUseId || null,
      rowCount: inferRowCount(toolResponse),
    },
    createdAt,
  });
  const truncated = Buffer.byteLength(serialized, 'utf8') > largeResultThreshold;
  return {
    artifact,
    reference: artifactReference(artifact),
    claudePayload: {
      artifact: artifactReference(artifact, `Saved output from ${toolName || 'MCP tool'}`),
      stored: true,
      truncated,
      originalSizeBytes: Buffer.byteLength(serialized, 'utf8'),
      preview: truncated ? `${serialized.slice(0, previewLimit)}\n...[read the Artifact for more]` : serialized,
      instruction: 'Use artifact_list, artifact_get_metadata, or artifact_read. Do not use a physical Workspace path.',
    },
  };
}

export async function readArtifact({ workspacePath, executionId, artifactId, offset = 0, limit = DEFAULT_READ_LIMIT }) {
  const paths = executionPaths(workspacePath, executionId);
  const artifact = await getArtifactMetadata({ workspacePath, executionId, artifactId });
  const normalizedOffset = Math.max(0, Number(offset) || 0);
  const normalizedLimit = Math.max(1, Math.min(MAX_READ_LIMIT, Number(limit) || DEFAULT_READ_LIMIT));
  const relativeLocation = String(artifact.location || '');
  const artifactPath = path.resolve(paths.root, relativeLocation);
  const relative = path.relative(paths.root, artifactPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw createHttpError('Artifact location is invalid', 500);
  }
  const content = await fs.readFile(artifactPath);
  const slice = content.subarray(normalizedOffset, normalizedOffset + normalizedLimit);
  const mediaType = String(artifact.metadata?.mediaType || 'application/octet-stream');
  const textLike = /^(?:text\/|application\/(?:json|xml|javascript))/.test(mediaType);
  return {
    artifact,
    offset: normalizedOffset,
    nextOffset: normalizedOffset + slice.byteLength,
    complete: normalizedOffset + slice.byteLength >= content.byteLength,
    encoding: textLike ? 'utf8' : 'base64',
    content: textLike ? slice.toString('utf8') : slice.toString('base64'),
  };
}

export async function syncExecutionWorkspace({ workspacePath, run, result = null }) {
  const paths = executionPaths(workspacePath, run.id);
  await initializeExecutionWorkspace({
    workspacePath,
    executionId: run.id,
    context: run.context,
    trace: run.trace,
  });
  await Promise.all([
    writeJsonAtomic(paths.contextPath, run.context),
    writeJsonAtomic(paths.tracePath, run.trace || []),
  ]);
  const targets = [paths.contextPath, paths.tracePath];
  if (result?.resultId) {
    const resultPath = path.join(paths.resultsDirectory, `${requireSafeId(result.resultId, 'Agent Result id')}.json`);
    await writeJsonAtomic(resultPath, result);
    targets.push(resultPath);
  }
  await applyOwnership(paths, targets, 'agent_graph_execution_snapshot');
}

function mcpText(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export async function createArtifactAccessMcpServer({
  workspacePath,
  executionId,
  producerAgentId,
  idFactory,
  onArtifactCreated = () => {},
}) {
  const [{ createSdkMcpServer, tool }, { z }] = await Promise.all([
    import('@anthropic-ai/claude-agent-sdk'),
    import('zod'),
  ]);
  return createSdkMcpServer({
    name: 'artifact-workspace',
    version: '1.0.0',
    tools: [
      tool('artifact_list', 'List Artifact references available in this Graph Execution. Physical paths are never returned.', {}, async () => {
        const artifacts = await listArtifacts({ workspacePath, executionId });
        return mcpText(artifacts.map((entry) => ({
          artifactId: entry.artifactId,
          type: entry.type,
          name: entry.name,
          producerAgentId: entry.producerAgentId,
          metadata: entry.metadata,
          createdAt: entry.createdAt,
        })));
      }),
      tool('artifact_get_metadata', 'Get metadata for an Artifact by reference id.', {
        artifactId: z.string().min(1),
      }, async ({ artifactId }) => mcpText(artifactMetadataForAgent(
        await getArtifactMetadata({ workspacePath, executionId, artifactId }),
      ))),
      tool('artifact_read', 'Read a bounded chunk of an Artifact by reference id.', {
        artifactId: z.string().min(1),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(MAX_READ_LIMIT).optional(),
      }, async ({ artifactId, offset, limit }) => {
        const result = await readArtifact({ workspacePath, executionId, artifactId, offset, limit });
        return mcpText({ ...result, artifact: artifactMetadataForAgent(result.artifact) });
      }),
      tool('artifact_write', 'Save a durable dataset, file, report, or other output in this Graph Execution and return its Artifact Reference.', {
        type: z.enum(['dataset', 'file', 'report', 'other']),
        name: z.string().min(1).max(240),
        content: z.string(),
        description: z.string().max(1_000).optional(),
        mediaType: z.string().max(120).optional(),
        extension: z.string().regex(/^[a-zA-Z0-9]{1,12}$/).optional(),
      }, async ({ type, name, content, description, mediaType, extension }) => {
        const artifact = await registerArtifact({
          workspacePath,
          executionId,
          producerAgentId,
          artifactId: idFactory(),
          type,
          name,
          content,
          extension: extension || (type === 'report' ? 'md' : 'txt'),
          mediaType: mediaType || 'text/plain',
          metadata: { source: 'agent-artifact-write' },
        });
        onArtifactCreated(artifact);
        return mcpText(artifactReference(artifact, description || name));
      }),
    ],
  });
}

export const agentGraphArtifactWorkspace = {
  initializeExecutionWorkspace,
  registerArtifact,
  captureMcpToolResult,
  listArtifacts,
  getArtifactMetadata,
  readArtifact,
  syncExecutionWorkspace,
  createArtifactAccessMcpServer,
};
