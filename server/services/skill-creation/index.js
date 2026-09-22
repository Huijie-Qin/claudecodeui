import { db } from '../../database/db.js';
import { multitenancyDb } from '../../database/multitenancy-db.js';
import { workspaceAccess } from '../workspace-access.js';
import { claudeEnvService } from '../claude-env.js';
import { createSkillSnippetService } from '../skill-snippets.js';
import { createEvaluationRuntime } from '../skill-evals/runtime.js';
import { fail } from '../skill-evals/contracts.js';
import { rebindSkillInvocations } from '../skill-evals/invocation-eligibility.js';

import { createSkillCreator } from './creator.js';
import { createConversationRegistrar } from './conversations.js';
import { createSkillCreationService } from './service.js';

const snippets = createSkillSnippetService(db);
const runtime = createEvaluationRuntime({ resolveEnvironment: ({ tenantId, userId }) => claudeEnvService.resolveEffectiveEnv({ tenantId, userId,
  baseEnv: Object.fromEntries(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'].filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
}).env });
export const skillCreationService = createSkillCreationService({ db, creator: createSkillCreator({ modelCall: runtime.modelCall }),
  listSnippets: () => snippets.list(), authorize: (scope, requireEdit) => workspaceAccess.requireWorkspace({ ...scope, requireEdit }),
  registerConversation: createConversationRegistrar({ db, sessions: multitenancyDb.sessions, access: workspaceAccess }),
  onConversationBound: (job, sessionId) => {
    if (job.sessionId === sessionId) return;
    if (sessionId.startsWith('pending:')) {
      db.prepare(`UPDATE session_index SET metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.skillCreation',json('true')) WHERE tenant_id=? AND workspace_id=? AND user_id=? AND provider=? AND provider_session_id=?`)
        .run(job.tenantId, job.workspaceId, job.userId, job.provider, sessionId);
    }
    // Keep earlier application messages when a creation-only/pending conversation starts real chat.
    db.prepare('UPDATE agent_session_messages SET provider_session_id=? WHERE tenant_id=? AND workspace_id=? AND user_id=? AND provider=? AND provider_session_id=?')
      .run(sessionId, job.tenantId, job.workspaceId, job.userId, job.provider, job.sessionId);
    rebindSkillInvocations(db, job, sessionId);
    multitenancyDb.sessions.markDeleted({ ...job, providerSessionId: job.sessionId });
  },
  authorizeSession: (scope) => {
    if (scope.sessionId && !multitenancyDb.sessions.findOwnedSession({ ...scope, providerSessionId: scope.sessionId })) throw fail('无权在此会话创建技能。', 'CREATION_SESSION_NOT_FOUND', 404);
  },
});
