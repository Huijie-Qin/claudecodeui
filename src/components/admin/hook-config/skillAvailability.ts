import type { HookConfig, HookSkillResource } from './types';

export type HookSkillAvailabilityIssue = {
  actionId: string;
  skillId: string;
  skillName: string;
  label: string;
  reason: 'invalid_id' | 'missing' | 'identity_mismatch';
};

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function findUnavailableHookSkills(
  hook: Pick<HookConfig, 'postActions'>,
  skills: HookSkillResource[],
): HookSkillAvailabilityIssue[] {
  const skillsById = new Map(skills.map((skill) => [skill.skillId, skill]));
  const issues: HookSkillAvailabilityIssue[] = [];
  for (const action of hook.postActions) {
    if (action.type !== 'invoke_skill') continue;
    const skillId = text(action.config?.skillId);
    const skillName = text(action.config?.skillName);
    const label = skillName || skillId || action.id;
    if (!skillId.startsWith('builtin:')) {
      issues.push({ actionId: action.id, skillId, skillName, label, reason: 'invalid_id' });
      continue;
    }
    const skill = skillsById.get(skillId);
    if (!skill) {
      issues.push({ actionId: action.id, skillId, skillName, label, reason: 'missing' });
      continue;
    }
    if (!skillName || skill.name !== skillName) {
      issues.push({ actionId: action.id, skillId, skillName, label, reason: 'identity_mismatch' });
    }
  }
  return issues;
}
