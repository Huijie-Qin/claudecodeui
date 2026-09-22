// A successful call is eligible only if this conversation had already created
// this exact skill. Check at read/save time because a draft may still be binding
// to the provider session when the invocation starts.
export function isCreatedSkillInvocation(db, row) {
  if (!row) return false;
  let invocation;
  try { invocation = JSON.parse(row.data); } catch { return false; }
  if (typeof invocation?.sessionId !== 'string' || !invocation.sessionId ||
      !Number.isFinite(invocation.startedAt)) return false;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='skill_creation_jobs'").get()) return false;
  const jobs = db.prepare(`SELECT data FROM skill_creation_jobs
    WHERE tenant_id=? AND workspace_id=? AND user_id=? AND conversation_key=?`)
    .all(row.tenant_id, row.workspace_id, row.user_id, `claude:${invocation.sessionId}`);
  return jobs.some(({ data }) => {
    try {
      const job = JSON.parse(data);
      return job.provider === 'claude' && job.sessionId === invocation.sessionId &&
        job.status === 'completed' && job.result?.name === row.skill_name &&
        typeof job.completedAt === 'string' && Date.parse(job.completedAt) <= invocation.startedAt;
    } catch { return false; }
  });
}

export function rebindSkillInvocations(db, scope, sessionId) {
  if (scope.provider !== 'claude' || scope.sessionId === sessionId) return;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='skill_eval_invocations'").get()) return;
  db.prepare(`UPDATE skill_eval_invocations SET data=json_set(data,'$.sessionId',?)
    WHERE tenant_id=? AND workspace_id=? AND user_id=? AND json_extract(data,'$.sessionId')=?`)
    .run(sessionId, scope.tenantId, scope.workspaceId, scope.userId, scope.sessionId);
}
