import { collectClaudeForkCheckpoints } from './claude-fork-checkpoint.js';
import { readClaudeCompletedReplies } from './claude-fork-checkpoint-store.js';
import { forkClaudeSessionFiles, readClaudeForkSource } from './claude-session-fork-files.js';
import { readSessionForkMetadata, sessionForkSummaryFields } from './session-fork-metadata.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

function fail(statusCode, code, message) {
  throw Object.assign(new Error(message), { statusCode, code });
}

function responseFor(session) {
  const lineage = sessionForkSummaryFields(session);
  return {
    sessionId: session.provider_session_id,
    ...lineage,
    session: {
      id: session.provider_session_id,
      summary: session.summary,
      lastActivity: session.updated_at,
      __provider: 'claude',
      __workspaceId: session.workspace_id,
      ...lineage,
    },
  };
}

function inheritedDisplayMessages(messages, { sourceSessionId, sessionId, cutoff }) {
  return messages.filter(message => {
    const synthetic = message.kind === 'hook_activity'
      || (message.kind === 'task_notification' && message.syntheticSubagentStop === true)
      || (message.origin === 'hook' && message.mcpLoopReplacement === true);
    if (!synthetic || typeof message.id !== 'string') return false;
    if (['running', 'queued', 'pending', 'processing', 'waiting'].includes(message.status)) return false;
    const timestamp = Date.parse(message.completedAt || message.timestamp);
    return Number.isFinite(timestamp) && timestamp <= cutoff;
  }).map(message => ({
    ...message,
    // The DB key is (runtime_id, message_id): retaining the old id would move
    // the original message into the fork because the runtime home is shared.
    id: `fork_${sessionId}_${message.id}`,
    sessionId,
    forkedFrom: { sessionId: sourceSessionId, messageUuid: message.id },
    inherited: true,
    sequence: undefined,
    rowid: undefined,
  }));
}

/** Dependencies are explicit so permission/registration failures can be tested
 * without starting a CLI, touching an account database, or calling a model. */
export function createSessionForkService({
  multitenancy,
  access,
  history,
  registerFork,
  withSessionLock,
  isSessionActive = () => false,
  readSource = readClaudeForkSource,
  readCompletedReplies = readClaudeCompletedReplies,
  forkFiles = forkClaudeSessionFiles,
}) {
  const requests = new Map();
  return {
    async fork({ tenantId, userId, workspaceId, sourceSessionId, sourceMessageUuid, requestId, provider = 'claude' }) {
      if (provider !== 'claude') fail(400, 'FORK_PROVIDER_UNSUPPORTED', 'Branching is currently supported for Claude sessions');
      if (![tenantId, userId, workspaceId].every(value => Number.isInteger(value) && value > 0)) {
        fail(400, 'FORK_SCOPE_REQUIRED', 'tenantId and workspaceId are required');
      }
      if (!UUID_PATTERN.test(sourceSessionId || '') || !UUID_PATTERN.test(sourceMessageUuid || '')) {
        fail(400, 'FORK_INVALID_MESSAGE', 'A valid source session and original message UUID are required');
      }
      if (typeof requestId !== 'string' || !REQUEST_PATTERN.test(requestId)) {
        fail(400, 'FORK_REQUEST_ID_REQUIRED', 'A valid requestId is required');
      }
      const scope = { tenantId, userId, workspaceId, provider: 'claude' };
      access.requireWorkspace({ ...scope, requireEdit: true });
      const sourceSession = multitenancy.sessions.findOwnedSession({ ...scope, providerSessionId: sourceSessionId });
      if (!sourceSession) fail(404, 'FORK_SESSION_NOT_FOUND', 'Session not found');
      const existing = multitenancy.sessions.listSessions(scope).find(session => readSessionForkMetadata(session)?.requestId === requestId);
      if (existing) {
        const fork = readSessionForkMetadata(existing);
        if (fork.parentSessionId !== sourceSessionId || fork.sourceMessageUuid !== sourceMessageUuid) {
          fail(409, 'FORK_REQUEST_CONFLICT', 'This requestId was already used for a different branch');
        }
        return responseFor(existing);
      }
      const key = `${tenantId}:${userId}:${workspaceId}:${requestId}`;
      const pending = requests.get(key);
      if (pending) {
        if (pending.sourceSessionId !== sourceSessionId || pending.sourceMessageUuid !== sourceMessageUuid) {
          fail(409, 'FORK_REQUEST_CONFLICT', 'This requestId is already creating a different branch');
        }
        return pending.promise;
      }
      const promise = withSessionLock({ ...scope, sessionId: sourceSessionId }, async () => {
        if (isSessionActive(sourceSessionId)) fail(409, 'SESSION_BUSY', 'Wait for the current reply to finish before branching');
        const runtime = multitenancy.runtimes.findByProviderSession({ ...scope, providerSessionId: sourceSessionId })
          || multitenancy.runtimes.findByOwner({ ...scope, workspaceHostPath: sourceSession.workspace_path });
        if (!runtime?.runtime_home_path) fail(409, 'FORK_HISTORY_UNAVAILABLE', 'The persisted Claude history is unavailable');
        const source = await readSource({ runtimeHomePath: runtime.runtime_home_path, sourceSessionId });
        const completedReplyUuids = await readCompletedReplies({ runtimeHomePath: runtime.runtime_home_path, sessionId: sourceSessionId });
        if (!collectClaudeForkCheckpoints(source.sourceEntries, {
          completedReplyUuids,
        }).has(sourceMessageUuid)) {
          fail(409, 'FORK_REPLY_INCOMPLETE', 'This message is not a completed reply; reload the conversation and try again');
        }
        const checkpoint = source.sourceEntries.find(entry => entry.uuid === sourceMessageUuid);
        const cutoff = Date.parse(checkpoint.timestamp);
        const sourceHistory = await history.fetchHistory({
          ...scope, providerSessionId: sourceSessionId, ownedSession: sourceSession, limit: null,
        });
        const title = `${sourceSession.summary || 'New Session'} · 分支`.slice(0, 500);
        const fork = await forkFiles({
          runtimeHomePath: runtime.runtime_home_path, sourceSessionId, sourceMessageUuid, title, source,
        });
        try {
          // Recheck access after filesystem work, before publishing the session.
          access.requireWorkspace({ ...scope, requireEdit: true });
          if (!multitenancy.sessions.findOwnedSession({ ...scope, providerSessionId: sourceSessionId })) {
            fail(404, 'FORK_SESSION_NOT_FOUND', 'The source session was deleted');
          }
          const row = registerFork({
            session: {
              ...scope,
              providerSessionId: fork.sessionId,
              summary: title,
              status: 'completed',
              metadata: { fork: { parentSessionId: sourceSessionId, sourceMessageUuid, requestId, runtimeId: runtime.runtime_id, createdAt: new Date().toISOString() } },
            },
            runtimeId: runtime.runtime_id,
            messages: inheritedDisplayMessages(sourceHistory.messages, { sourceSessionId, sessionId: fork.sessionId, cutoff }),
          });
          return responseFor(row);
        } catch (error) {
          await fork.cleanup();
          throw error;
        }
      });
      requests.set(key, { promise, sourceSessionId, sourceMessageUuid });
      try { return await promise; }
      finally { requests.delete(key); }
    },
  };
}
