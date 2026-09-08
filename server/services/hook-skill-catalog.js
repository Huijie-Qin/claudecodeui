import {
  deleteManagedBuiltinHookSkill,
  isBuiltinHookSkillId,
  listBuiltinHookSkills,
  saveManagedBuiltinHookSkill,
} from './hook-builtin-skills.js';
import { describeHookSkillSource } from './hook-workspace-resources.js';

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeBuiltinSkill(skill) {
  const skillId = String(skill?.skillId ?? '').trim();
  const name = String(skill?.name ?? '').trim();
  if (!skillId || !name || !isBuiltinHookSkillId(skillId)) return null;
  return {
    skillId,
    name,
    displayName: String(skill?.displayName || name).trim() || name,
    description: typeof skill?.description === 'string' ? skill.description : '',
    version: Number.isFinite(Number(skill?.version)) ? Number(skill.version) : 0,
    ...(typeof skill?.contentHash === 'string' && skill.contentHash
      ? { contentHash: skill.contentHash }
      : {}),
  };
}

export function createHookSkillCatalogService({
  deleteManagedSkill = deleteManagedBuiltinHookSkill,
  listBuiltinSkills = listBuiltinHookSkills,
  saveBuiltinSkill = saveManagedBuiltinHookSkill,
} = {}) {
  const getSkills = async () => {
    const skills = await Promise.all((await listBuiltinSkills()).map(async (skill) => {
      const normalized = normalizeBuiltinSkill(skill);
      if (!normalized) return null;
      if (normalized.contentHash) return normalized;
      const description = await describeHookSkillSource(skill);
      return { ...normalized, contentHash: description.contentHash };
    }));
    return skills.filter(Boolean)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  };

  return {
    getSource: () => ({ type: 'builtin', available: true }),

    listConfigurationSkills: async () => ({
      skills: await getSkills(),
      source: { type: 'builtin', available: true },
    }),

    uploadBuiltinSkill: async ({ files }) => (
      normalizeBuiltinSkill(await saveBuiltinSkill({ files }))
    ),

    deleteBuiltinSkill: async ({ skillId }) => (
      normalizeBuiltinSkill(await deleteManagedSkill({ skillId }))
    ),

    validateHookSkills: async ({ hook }) => {
      const actions = (hook?.postActions || []).filter((action) => action.type === 'invoke_skill');
      if (!actions.length) return [];
      const rawBuiltinSkills = await listBuiltinSkills();
      const builtinById = new Map(rawBuiltinSkills.map((skill) => [
        String(skill?.skillId || ''),
        { raw: skill, normalized: normalizeBuiltinSkill(skill) },
      ]));
      const validated = new Map();
      for (const action of actions) {
        const skillId = String(action.config?.skillId || '').trim();
        const skillName = String(action.config?.skillName || '').trim();
        if (!skillId || !skillName || !isBuiltinHookSkillId(skillId)) {
          throw createHttpError(`Post action ${action.id} must select a built-in Hook Skill`);
        }
        const entry = builtinById.get(skillId);
        const builtinSkill = entry?.normalized;
        if (!builtinSkill || builtinSkill.name !== skillName) {
          throw createHttpError(`Built-in Hook Skill ${skillName || skillId} is unavailable`);
        }
        if (!validated.has(skillId)) {
          const contentHash = builtinSkill.contentHash
            || (await describeHookSkillSource(entry.raw)).contentHash;
          validated.set(skillId, { ...builtinSkill, contentHash });
        }
      }
      return [...validated.values()];
    },
  };
}
