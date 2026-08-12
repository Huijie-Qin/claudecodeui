const PUBLIC_TENANT_ENV_NAME = 'HOOK_PUBLIC_SKILL_TENANT_ID';
const CONFIGURATION_PAGE_SIZE = 500;
const MAX_CONFIGURATION_PAGES = 20;

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireAccountId(value) {
  const accountId = String(value || '').trim();
  if (!accountId) throw createHttpError('User username is required');
  return accountId;
}

function normalizeMarketSkill(skill) {
  const skillId = String(skill?.skillId ?? skill?.id ?? '').trim();
  const name = String(skill?.name ?? '').trim();
  if (!skillId || !name) return null;
  return {
    skillId,
    name,
    displayName: String(skill?.displayName || name).trim() || name,
    description: typeof skill?.description === 'string' ? skill.description : '',
    version: Number.isFinite(Number(skill?.version)) ? Number(skill.version) : 0,
  };
}

export function resolveHookPublicSkillTenant({ multitenancy, env = process.env } = {}) {
  const rawTenantId = String(env?.[PUBLIC_TENANT_ENV_NAME] || '').trim();
  const tenantId = Number(rawTenantId);
  if (!rawTenantId || !Number.isInteger(tenantId) || tenantId <= 0) {
    throw createHttpError(`${PUBLIC_TENANT_ENV_NAME} must be configured as a positive tenant id`);
  }
  const tenant = multitenancy?.tenants?.getTenantById?.(tenantId);
  if (!tenant?.code) {
    throw createHttpError(`Hook public Skill tenant ${tenantId} does not exist or has no tenant code`);
  }
  return {
    tenantId,
    tenantCode: String(tenant.code),
  };
}

export function createHookSkillMarketService({
  multitenancy,
  skillPresets,
  env = process.env,
} = {}) {
  const getTenant = () => resolveHookPublicSkillTenant({ multitenancy, env });

  const search = async ({ searchContent = '', page = 1, pageSize = CONFIGURATION_PAGE_SIZE, accountId }) => {
    if (typeof skillPresets?.searchMarketSkills !== 'function') {
      throw createHttpError('Skill Market service is unavailable', 503);
    }
    const tenant = getTenant();
    const result = await skillPresets.searchMarketSkills({
      searchContent,
      page,
      pageSize,
      tenantCode: tenant.tenantCode,
      accountId: requireAccountId(accountId),
    });
    return {
      tenant,
      skills: (result?.skills || []).map(normalizeMarketSkill).filter(Boolean),
      pageInfo: result?.pageInfo || null,
    };
  };

  const findSkill = async ({ skillId, skillName, accountId }) => {
    const refs = [...new Set([skillId, skillName].map((value) => String(value || '').trim()).filter(Boolean))];
    for (const searchContent of refs) {
      const result = await search({ searchContent, page: 1, pageSize: 100, accountId });
      const match = result.skills.find((skill) => (
        skill.skillId === skillId
        || (!skillId && skill.name === skillName)
      ));
      if (match) return match;
    }
    return null;
  };

  return {
    getSource: () => {
      try {
        const tenant = getTenant();
        return {
          configured: true,
          available: false,
          tenantId: tenant.tenantId,
        };
      } catch (error) {
        return {
          configured: false,
          available: false,
          error: error instanceof Error ? error.message : 'Hook public Skill tenant is unavailable',
        };
      }
    },

    listConfigurationSkills: async ({ accountId }) => {
      const byId = new Map();
      let page = 1;
      let tenant = null;
      while (page <= MAX_CONFIGURATION_PAGES) {
        const result = await search({ page, accountId });
        tenant = result.tenant;
        for (const skill of result.skills) byId.set(skill.skillId, skill);
        if (!result.pageInfo?.hasNextPage) break;
        page += 1;
      }
      if (page > MAX_CONFIGURATION_PAGES) {
        throw createHttpError('Hook public tenant Skill Market contains too many Skills to load safely', 503);
      }
      return {
        skills: [...byId.values()].sort((left, right) => left.displayName.localeCompare(right.displayName)),
        source: {
          configured: true,
          available: true,
          tenantId: tenant?.tenantId,
        },
      };
    },

    validateHookSkills: async ({ hook, accountId }) => {
      const actions = (hook?.postActions || []).filter((action) => action.type === 'invoke_skill');
      if (!actions.length) return [];
      getTenant();
      const validated = new Map();
      for (const action of actions) {
        const skillId = String(action.config?.skillId || '').trim();
        const skillName = String(action.config?.skillName || '').trim();
        if (!skillId || !skillName) {
          throw createHttpError(`Post action ${action.id} must select a Skill from the Hook Skill Market`);
        }
        const marketSkill = await findSkill({ skillId, skillName, accountId });
        if (!marketSkill || marketSkill.name !== skillName) {
          throw createHttpError(`Skill ${skillName} is not available in the Hook public tenant Skill Market`);
        }
        validated.set(skillId, marketSkill);
      }
      return [...validated.values()];
    },
  };
}

export { PUBLIC_TENANT_ENV_NAME as HOOK_PUBLIC_SKILL_TENANT_ENV_NAME };
