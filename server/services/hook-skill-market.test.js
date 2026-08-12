import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHookSkillMarketService,
  resolveHookPublicSkillTenant,
} from './hook-skill-market.js';

function createFixture({ env = { HOOK_PUBLIC_SKILL_TENANT_ID: '7' }, pages } = {}) {
  const calls = [];
  const multitenancy = {
    tenants: {
      getTenantById: (tenantId) => tenantId === 7 ? { id: 7, code: 'hook-public' } : null,
    },
  };
  const skillPresets = {
    searchMarketSkills: async (args) => {
      calls.push(args);
      if (pages) return pages(args);
      return {
        skills: [{
          id: 'sms-skill-id',
          skillId: 'sms-skill-id',
          name: 'send-sms',
          displayName: 'Send SMS',
          description: 'Send an SMS message',
          version: 3,
        }],
        pageInfo: { page: 1, pageSize: args.pageSize, hasNextPage: false },
      };
    },
  };
  return {
    calls,
    service: createHookSkillMarketService({ multitenancy, skillPresets, env }),
    multitenancy,
  };
}

test('Hook public Skill tenant must be configured as an existing tenant id', () => {
  const { multitenancy } = createFixture();
  assert.throws(
    () => resolveHookPublicSkillTenant({ multitenancy, env: {} }),
    /HOOK_PUBLIC_SKILL_TENANT_ID/,
  );
  assert.throws(
    () => resolveHookPublicSkillTenant({
      multitenancy,
      env: { HOOK_PUBLIC_SKILL_TENANT_ID: '99' },
    }),
    /does not exist/,
  );
});

test('Hook configuration Skills are read only from the configured public tenant market', async () => {
  const { service, calls } = createFixture();
  const result = await service.listConfigurationSkills({ accountId: 'admin-user' });
  assert.deepEqual(result.skills, [{
    skillId: 'sms-skill-id',
    name: 'send-sms',
    displayName: 'Send SMS',
    description: 'Send an SMS message',
    version: 3,
  }]);
  assert.deepEqual(result.source, {
    configured: true,
    available: true,
    tenantId: 7,
  });
  assert.equal(calls[0].tenantCode, 'hook-public');
  assert.equal(calls[0].accountId, 'admin-user');
});

test('Hook publish validates the saved Skill id and runtime name against the public tenant market', async () => {
  const { service, calls } = createFixture();
  const hook = {
    postActions: [{
      id: 'notify',
      type: 'invoke_skill',
      config: { skillId: 'sms-skill-id', skillName: 'send-sms' },
    }],
  };
  assert.deepEqual(
    await service.validateHookSkills({ hook, accountId: 'admin-user' }),
    [{
      skillId: 'sms-skill-id',
      name: 'send-sms',
      displayName: 'Send SMS',
      description: 'Send an SMS message',
      version: 3,
    }],
  );
  assert.equal(calls.at(-1).searchContent, 'sms-skill-id');

  await assert.rejects(
    service.validateHookSkills({
      hook: {
        postActions: [{
          id: 'notify',
          type: 'invoke_skill',
          config: { skillId: 'sms-skill-id', skillName: 'renamed-skill' },
        }],
      },
      accountId: 'admin-user',
    }),
    /not available in the Hook public tenant/,
  );
});

test('Hooks without a Skill action do not require the public tenant configuration', async () => {
  const { service } = createFixture({ env: {} });
  assert.deepEqual(
    await service.validateHookSkills({ hook: { postActions: [] }, accountId: '' }),
    [],
  );
});
