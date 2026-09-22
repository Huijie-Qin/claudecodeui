import { hash } from '../skill-evals/contracts.js';

export function createConversationRegistrar({ db, sessions, access }) {
  return (job) => {
    access.requireWorkspace({ ...job, requireEdit: false });
    const providerSessionId = job.sessionId || `skill-creation:${hash(JSON.stringify([job.tenantId, job.workspaceId, job.userId, job.provider, job.conversationKey])).slice(0, 32)}`;
    const record = db.prepare('SELECT status FROM session_index WHERE tenant_id=? AND workspace_id=? AND user_id=? AND provider=? AND provider_session_id=?')
      .get(job.tenantId, job.workspaceId, job.userId, job.provider, providerSessionId);
    if (record?.status === 'deleted') return null;
    const existing = sessions.findOwnedSession({ ...job, providerSessionId });
    const metadata = existing?.metadata_json ? JSON.parse(existing.metadata_json) : {};
    if (!existing || !metadata.skillCreation) {
      sessions.upsertSession({
        tenantId: job.tenantId, workspaceId: job.workspaceId, userId: job.userId, provider: job.provider,
        // Job phases such as queued/generating are not session lifecycle states.
        status: existing?.status || 'active', providerSessionId, summary: existing?.summary || `创建技能：${job.description.trim().slice(0, 60)}`, metadata: { ...metadata, skillCreation: true } });
    }
    return providerSessionId;
  };
}
