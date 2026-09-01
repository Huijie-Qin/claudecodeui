import assert from 'node:assert/strict';
import test from 'node:test';

import { canUnpublishSkill, getSkillPublishMode } from './skillPublish';

test('getSkillPublishMode maps an unpublished local skill to its first publish action', () => {
  assert.equal(getSkillPublishMode({
    canManage: true,
    skill: { imported: false, canUploadAndPublish: true, canPublish: false },
  }), 'upload');
});

test('getSkillPublishMode maps a creator-owned imported skill to publish update', () => {
  assert.equal(getSkillPublishMode({
    canManage: true,
    skill: { imported: true, canUploadAndPublish: false, canPublish: true },
  }), 'update');
});

test('getSkillPublishMode hides publishing without workspace or creator permission', () => {
  assert.equal(getSkillPublishMode({
    canManage: false,
    skill: { imported: false, canUploadAndPublish: true },
  }), null);
  assert.equal(getSkillPublishMode({
    canManage: true,
    skill: { imported: true, canUploadAndPublish: false, canPublish: false },
  }), null);
});

test('canUnpublishSkill only allows the creator-owned local published binding', () => {
  assert.equal(canUnpublishSkill({
    canManage: true,
    skill: { canPublish: true, origin: 'local', bindingType: 'published' },
  }), true);
  assert.equal(canUnpublishSkill({
    canManage: true,
    skill: { canPublish: true, origin: 'market', bindingType: 'imported' },
  }), false);
  assert.equal(canUnpublishSkill({
    canManage: true,
    skill: { canPublish: false, origin: 'local', bindingType: 'published' },
  }), false);
});
