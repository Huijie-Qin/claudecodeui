import {
  deleteManagedBuiltinHookSkill,
  isBuiltinHookSkillId,
  listBuiltinHookSkills,
  saveManagedBuiltinHookSkill,
} from './hook-builtin-skills.js';

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
  };
}

export function createHookSkillCatalogService({
  deleteManagedSkill = deleteManagedBuiltinHookSkill,
  listBuiltinSkills = listBuiltinHookSkills,
  saveBuiltinSkill = saveManagedBuiltinHookSkill,
} = {}) {
  const getSkills = async () => (
    (await listBuiltinSkills())
      .map(normalizeBuiltinSkill)
      .filter(Boolean)
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
  );

  return {
    getSource: () => ({ type: 'builtin', available: true }),

    listConfigurationSkills: async () => ({
      skills: await getSkills(),
      source: { type: 'builtin', available: true },
    }),

    uploadBuiltinSkill: async ({ fileName, fileBuffer }) => (
      normalizeBuiltinSkill(await saveBuiltinSkill({ fileName, fileBuffer }))
    ),

    deleteBuiltinSkill: async ({ skillId }) => (
      normalizeBuiltinSkill(await deleteManagedSkill({ skillId }))
    ),

    validateHookSkills: async ({ hook }) => {
      const actions = (hook?.postActions || []).filter((action) => action.type === 'invoke_skill');
      if (!actions.length) return [];
      const builtinSkills = await getSkills();
      const builtinById = new Map(builtinSkills.map((skill) => [skill.skillId, skill]));
      const validated = new Map();
      for (const action of actions) {
        const skillId = String(action.config?.skillId || '').trim();
        const skillName = String(action.config?.skillName || '').trim();
        if (!skillId || !skillName || !isBuiltinHookSkillId(skillId)) {
          throw createHttpError(`Post action ${action.id} must select a built-in Hook Skill`);
        }
        const builtinSkill = builtinById.get(skillId);
        if (!builtinSkill || builtinSkill.name !== skillName) {
          throw createHttpError(`Built-in Hook Skill ${skillName || skillId} is unavailable`);
        }
        validated.set(skillId, builtinSkill);
      }
      return [...validated.values()];
    },
  };
}
