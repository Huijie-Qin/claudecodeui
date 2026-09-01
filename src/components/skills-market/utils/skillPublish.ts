export type SkillPublishMode = 'update' | 'upload';

type SkillPublishStatePayload = {
  canManage?: boolean;
  skill?: {
    imported?: boolean;
    canPublish?: boolean;
    canUnpublish?: boolean;
    canUploadAndPublish?: boolean;
    origin?: 'market' | 'local';
    bindingType?: 'published' | 'imported';
  };
};

export function getSkillPublishMode(payload: SkillPublishStatePayload): SkillPublishMode | null {
  if (payload.canManage === false) return null;
  if (payload.skill?.canUploadAndPublish === true) return 'upload';
  if (payload.skill?.imported === true && payload.skill.canPublish === true) return 'update';
  return null;
}

export function canUnpublishSkill(payload: SkillPublishStatePayload): boolean {
  return payload.canManage !== false
    && payload.skill?.canUnpublish === true;
}
