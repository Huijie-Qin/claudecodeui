import assert from 'node:assert/strict';
import test from 'node:test';

import { createHookSkillCatalogService } from './hook-skill-catalog.js';

const builtinSkill = {
  skillId: 'builtin:hook-notification',
  name: 'hook-notification',
  displayName: 'Hook Notification (Mock)',
  description: 'Local notification',
  version: 1,
  manifestPath: '/not/exposed/SKILL.md',
  content: 'not exposed',
};

function createService(skills = [builtinSkill]) {
  return createHookSkillCatalogService({ listBuiltinSkills: async () => skills });
}

test('Hook configuration lists only registered built-in Skills', async () => {
  const service = createService([
    builtinSkill,
    {
      skillId: 'public-market-skill',
      name: 'public-market-skill',
      displayName: 'Must not be exposed',
      description: '',
      version: 3,
    },
  ]);

  const listed = await service.listConfigurationSkills({ accountId: 'ignored-admin' });

  assert.deepEqual(listed, {
    skills: [{
      skillId: builtinSkill.skillId,
      name: builtinSkill.name,
      displayName: builtinSkill.displayName,
      description: builtinSkill.description,
      version: builtinSkill.version,
    }],
    source: { type: 'builtin', available: true },
  });
});

test('Hook publish accepts a registered built-in Skill', async () => {
  const service = createService();
  const validated = await service.validateHookSkills({
    accountId: 'ignored-admin',
    hook: {
      postActions: [{
        id: 'notify',
        type: 'invoke_skill',
        config: { skillId: builtinSkill.skillId, skillName: builtinSkill.name },
      }],
    },
  });

  assert.deepEqual(validated, [{
    skillId: builtinSkill.skillId,
    name: builtinSkill.name,
    displayName: builtinSkill.displayName,
    description: builtinSkill.description,
    version: builtinSkill.version,
  }]);
});

test('Hook catalog uploads and returns an admin-managed built-in Skill', async () => {
  const uploaded = {
    skillId: 'builtin:uploaded-notifier',
    name: 'uploaded-notifier',
    displayName: 'uploaded-notifier',
    description: 'Uploaded notification Skill',
    version: 1,
  };
  const calls = [];
  const service = createHookSkillCatalogService({
    listBuiltinSkills: async () => [builtinSkill],
    saveBuiltinSkill: async (input) => {
      calls.push(input);
      return uploaded;
    },
  });
  const files = [{ relativePath: 'uploaded-notifier/SKILL.md', buffer: Buffer.from('skill file') }];

  assert.deepEqual(
    await service.uploadBuiltinSkill({ files }),
    uploaded,
  );
  assert.deepEqual(calls, [{ files }]);
});

test('Hook catalog deletes only through the managed Skill store', async () => {
  const uploaded = {
    skillId: 'builtin:uploaded-notifier',
    name: 'uploaded-notifier',
    displayName: 'uploaded-notifier',
    description: 'Uploaded notification Skill',
    version: 1,
  };
  const calls = [];
  const service = createHookSkillCatalogService({
    deleteManagedSkill: async (input) => {
      calls.push(input);
      return uploaded;
    },
  });

  assert.deepEqual(await service.deleteBuiltinSkill({ skillId: uploaded.skillId }), uploaded);
  assert.deepEqual(calls, [{ skillId: uploaded.skillId }]);
});

test('Hook publish rejects public-market and forged built-in Skill references', async () => {
  const service = createService();

  await assert.rejects(
    service.validateHookSkills({
      hook: {
        postActions: [{
          id: 'public',
          type: 'invoke_skill',
          config: { skillId: 'market-skill-id', skillName: 'send-sms' },
        }],
      },
    }),
    /must select a built-in Hook Skill/,
  );

  await assert.rejects(
    service.validateHookSkills({
      hook: {
        postActions: [{
          id: 'forged',
          type: 'invoke_skill',
          config: { skillId: 'builtin:not-registered', skillName: 'not-registered' },
        }],
      },
    }),
    /is unavailable/,
  );
});

test('Hooks without a Skill action do not require any built-in Skill', async () => {
  const service = createService([]);
  assert.deepEqual(await service.validateHookSkills({ hook: { postActions: [] } }), []);
});
