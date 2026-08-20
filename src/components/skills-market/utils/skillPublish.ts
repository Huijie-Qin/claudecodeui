export type SkillPublishMode = 'update' | 'upload';

type SkillPublishStatePayload = {
  canManage?: boolean;
  skill?: {
    imported?: boolean;
    canPublish?: boolean;
    canUploadAndPublish?: boolean;
  };
};

export function getSkillPublishMode(payload: SkillPublishStatePayload): SkillPublishMode | null {
  if (payload.canManage === false) return null;
  if (payload.skill?.canUploadAndPublish === true) return 'upload';
  if (payload.skill?.imported === true && payload.skill.canPublish === true) return 'update';
  return null;
}
