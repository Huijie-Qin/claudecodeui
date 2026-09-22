import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { db } from '../../database/db.js';
import { multitenancyDb } from '../../database/multitenancy-db.js';
import { resolveWorkspaceSkillContext, syncManagedSkillAfterMutation } from '../workspace-skills.js';
import { workspaceAccess } from '../workspace-access.js';

import { createInvocationCapture } from './invocation-capture.js';
import { isCreatedSkillInvocation } from './invocation-eligibility.js';
import { fail, hash, redact } from './contracts.js';
import { withSkillLock } from './coordination.js';

import { skillEvaluationService } from './index.js';

db.exec(`CREATE TABLE IF NOT EXISTS skill_eval_invocations (
  id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  message_id TEXT NOT NULL, skill_name TEXT NOT NULL, data TEXT NOT NULL,
  UNIQUE(tenant_id,workspace_id,user_id,message_id)
)`);

// Only explicit, reproducible invocations become save actions. Nothing is inferred from a skill name in prose.
export async function beginSkillInvocation(options, prompt, getSessionId = () => options.sessionId) {
  const startedAt = Date.now();
  const match = /^\/([a-zA-Z0-9_-]+)\s+([\s\S]+)$/.exec(String(prompt).trim());
  if (!match || !options.workspaceId || !options.tenantId || !options.userId || options.images?.length || options.hookRecovery) return null;
  const scope = { tenantId: Number(options.tenantId), workspaceId: Number(options.workspaceId), userId: Number(options.userId),
    workspacePath: options.hostWorkspacePath || options.cwd || options.projectPath, name: match[1] };
  workspaceAccess.requireWorkspace({ ...scope, requireEdit: true });
  const context = await resolveWorkspaceSkillContext(scope);
  let history = '';
  if (options.sessionId) {
    const previous = multitenancyDb.sessionMessages.listMessages({ ...scope, provider: 'claude', providerSessionId: options.sessionId });
    if (!previous.messages.length || previous.messages.some((m) => !['text', 'status', 'complete'].includes(m.kind))) return null;
    history = previous.messages.filter((m) => m.kind === 'text').map((m) => `${m.role}: ${m.content || m.text || ''}`).join('\n\n');
  }
  if (history.length > 50000 || redact(history) !== history || redact(match[2]) !== match[2]) return null;
  return createInvocationCapture({ skillRoot: context.rootPath, save: ({ messageId, output }) => {
    const sessionId = getSessionId();
    if (!sessionId) return;
    db.prepare('INSERT OR IGNORE INTO skill_eval_invocations VALUES (?,?,?,?,?,?,?)').run(randomUUID(), scope.tenantId, scope.workspaceId,
      scope.userId, messageId, context.name, JSON.stringify({ prompt: match[2], expected_output: output, history, sessionId, startedAt }));
  } });
}

export function invocationForMessage(scope, messageId) {
  workspaceAccess.requireWorkspace({ ...scope, requireEdit: false });
  const row = db.prepare('SELECT * FROM skill_eval_invocations WHERE tenant_id=? AND workspace_id=? AND user_id=? AND message_id=?')
    .get(scope.tenantId, scope.workspaceId, scope.userId, messageId);
  return isCreatedSkillInvocation(db, row) ? { id: row.id, name: row.skill_name } : null;
}
export async function saveInvocation(scope, invocationId, expectedRevision) {
  workspaceAccess.requireWorkspace({ ...scope, requireEdit: true });
  const row = db.prepare('SELECT * FROM skill_eval_invocations WHERE id=? AND tenant_id=? AND workspace_id=? AND user_id=?')
    .get(invocationId, scope.tenantId, scope.workspaceId, scope.userId);
  if (!row || row.skill_name !== scope.name || !isCreatedSkillInvocation(db, row)) throw fail('Invocation not found', 'EVAL_NOT_FOUND', 404);
  const source = `invocation:${row.id}`, stored = JSON.parse(row.data);
  return withSkillLock(scope.workspacePath, scope.name, async () => {
    const current = await skillEvaluationService.files.load(scope);
    const saved = Object.entries(current.meta.sources).find(([id, value]) => value === source && current.document.evals.some((c) => c.id === Number(id)));
    if (saved) return { saved: true, caseId: Number(saved[0]) };
    if (current.revision !== expectedRevision) throw fail('Cases changed', 'EVAL_REVISION_CONFLICT', 409);
    const inputs = [];
    if (stored.history) {
      const relative = `evals/files/context-${hash(row.id).slice(0, 20)}.txt`;
      const full = path.join(current.context.rootPath, relative);
      await fs.mkdir(path.dirname(full), { recursive: true });
      try { await fs.writeFile(full, stored.history, { flag: 'wx', mode: 0o600 }); }
      catch (e) { if (e.code !== 'EEXIST' || await fs.readFile(full, 'utf8') !== stored.history) throw e; }
      inputs.push(relative);
      await syncManagedSkillAfterMutation(current.context, scope.workspacePath);
    }
    let caseId;
    await skillEvaluationService.files.mutate(scope, expectedRevision, (doc, next) => {
      caseId = next;
      doc.evals.push({ id: next, prompt: stored.prompt, expected_output: stored.expected_output, files: inputs });
    }, source);
    return { saved: true, caseId };
  });
}
