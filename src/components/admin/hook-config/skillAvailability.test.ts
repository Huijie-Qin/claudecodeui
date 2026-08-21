import assert from 'node:assert/strict';
import test from 'node:test';

import { findUnavailableHookSkills } from './skillAvailability';
import type { HookConfig, HookSkillResource } from './types';

const skills: HookSkillResource[] = [{
  skillId: 'builtin:hook-notification',
  name: 'hook-notification',
  displayName: 'Hook notification',
  description: '',
  version: 1,
}];

function hookWithActions(postActions: HookConfig['postActions']) {
  return { postActions } as Pick<HookConfig, 'postActions'>;
}

test('findUnavailableHookSkills accepts an exact built-in catalog match', () => {
  const issues = findUnavailableHookSkills(hookWithActions([{
    id: 'notify',
    type: 'invoke_skill',
    position: 0,
    config: {
      skillId: 'builtin:hook-notification',
      skillName: 'hook-notification',
    },
  }]), skills);
  assert.deepEqual(issues, []);
});

test('findUnavailableHookSkills reports invalid, missing, and mismatched Skill references', () => {
  const issues = findUnavailableHookSkills(hookWithActions([
    {
      id: 'legacy',
      type: 'invoke_skill',
      position: 0,
      config: { skillId: 'market-skill', skillName: 'legacy-notifier' },
    },
    {
      id: 'deleted',
      type: 'invoke_skill',
      position: 1,
      config: { skillId: 'builtin:deleted-notifier', skillName: 'deleted-notifier' },
    },
    {
      id: 'renamed',
      type: 'invoke_skill',
      position: 2,
      config: { skillId: 'builtin:hook-notification', skillName: 'wrong-name' },
    },
    {
      id: 'record',
      type: 'write_record',
      position: 3,
      config: {},
    },
  ]), skills);

  assert.deepEqual(issues.map(({ actionId, label, reason }) => ({ actionId, label, reason })), [
    { actionId: 'legacy', label: 'legacy-notifier', reason: 'invalid_id' },
    { actionId: 'deleted', label: 'deleted-notifier', reason: 'missing' },
    { actionId: 'renamed', label: 'wrong-name', reason: 'identity_mismatch' },
  ]);
});
