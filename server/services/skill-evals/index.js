import path from 'node:path';
import os from 'node:os';

import { db } from '../../database/db.js';
import { createSkillEvaluationDb } from '../../database/skill-evaluation-db.js';
import { workspaceAccess } from '../workspace-access.js';
import { claudeEnvService } from '../claude-env.js';

import { createEvaluationRuntime } from './runtime.js';
import { createSkillEvaluationService } from './service.js';
import { setSkillMutationGuard } from './coordination.js';

const repository = createSkillEvaluationDb(db);
const runtime = createEvaluationRuntime({
  resolveEnvironment: ({ tenantId, userId }) => claudeEnvService.resolveEffectiveEnv({ tenantId, userId,
    baseEnv: Object.fromEntries(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']
      .filter((name) => process.env[name]).map((name) => [name, process.env[name]])) }).env,
});
export const skillEvaluationService = createSkillEvaluationService({
  repository, runtime,
  storageRoot: process.env.SKILL_EVAL_STORAGE_ROOT || path.join(os.homedir(), '.cloudcli', 'skill-evaluations'),
  authorize: (scope, requireEdit) => workspaceAccess.requireWorkspace({ ...scope, requireEdit }),
});
setSkillMutationGuard(skillEvaluationService.files.guard);
