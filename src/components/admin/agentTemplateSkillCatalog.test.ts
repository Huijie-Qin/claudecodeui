import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSkillCandidates, getSkillCandidateKey, getUnavailableSkillSelections, mergeSkillPresets, type AdminSkillPreset } from './agentTemplateSkillCatalog';

function preset(values: Partial<AdminSkillPreset> = {}): AdminSkillPreset {
  return {
    id: 20, tenantId: 2, name: 'market-research', displayName: '市场研究',
    remoteId: 'market-id', skillId: 'market-id', status: 'published',
    lastValidationStatus: 'healthy', ...values,
  };
}

test('template choices contain exactly market entries, excluding stale and other-tenant presets', () => {
  const marketSkills = [
    { id: 'market-id', name: 'market-research' },
    { id: 'unconfigured-id', name: 'new-skill' },
  ];
  const skills = buildSkillCandidates({
    tenantId: 2, marketSkills,
    presets: [
      preset({ id: 1, tenantId: 1 }),
      preset(),
      preset({ id: 21, remoteId: 'deleted-id', name: 'old-skill' }),
    ],
  });
  assert.deepEqual(skills.map((skill) => skill.sourceRef), marketSkills.map((skill) => skill.id));
  assert.equal(skills[0].presetId, 20);
  assert.equal(skills[1].presetId, undefined);
  assert.deepEqual(buildSkillCandidates({ tenantId: 2, marketSkills: [], presets: [preset()] }), []);
});

test('a recreated skill with the same name does not inherit the old preset ID or validation', () => {
  const skills = buildSkillCandidates({
    tenantId: 2,
    marketSkills: [{ id: 'new-id', skillId: 'market-research', name: 'market-research', displayName: '市场研究' }],
    presets: [preset({ remoteId: 'deleted-id', skillId: 'market-research' })],
  });
  assert.equal(skills[0].presetId, undefined);
  assert.equal(skills[0].lastValidationStatus, undefined);
});

test('stable IDs associate renamed skills with their existing preset', () => {
  const skills = buildSkillCandidates({
    tenantId: 2,
    marketSkills: [{ id: 'market-id', name: 'renamed-skill', displayName: '市场研究新版' }],
    presets: [preset()],
  });
  assert.equal(skills[0].presetId, 20);
  assert.equal(skills[0].displayName, '市场研究新版');
});

test('legacy name matching is allowed only when both sides have no remote ID', () => {
  const legacy = preset({ remoteId: undefined, skillId: undefined });
  const options = { tenantId: 2, presets: [legacy] };
  assert.equal(buildSkillCandidates({ ...options, marketSkills: [{ name: 'market-research' }] })[0].presetId, 20);
  assert.equal(buildSkillCandidates({ ...options, marketSkills: [{ id: 'new-id', name: 'market-research' }] })[0].presetId, undefined);
});

test('missing selections remain removable separately, without becoming new choices', () => {
  const presets = [preset(), preset({ id: 21, remoteId: 'deleted-id', name: 'old-skill', displayName: '旧技能' })];
  const skills = buildSkillCandidates({ tenantId: 2, marketSkills: [{ id: 'market-id', name: 'market-research' }], presets });
  const refs = [{ tenantId: 2, presetId: 20 }, { tenantId: 2, presetId: 21 }, { tenantId: 2, presetId: 99 }, { tenantId: 1, presetId: 30 }];
  const missing = getUnavailableSkillSelections({ tenantId: 2, skills, presets, refs });
  assert.deepEqual(missing.map((entry) => [entry.id, entry.displayName]), [[21, '旧技能'], [99, 'Skill #99']]);
  assert.equal(skills.length, 1);
  assert.equal(refs.length, 4);
  assert.deepEqual(getUnavailableSkillSelections({ tenantId: 2, skills: [], presets, refs }).map((entry) => entry.id), [20, 21, 99]);
});

test('the complete inventory retains later-page skills', () => {
  const marketSkills = Array.from({ length: 130 }, (_, i) => ({ id: `market-${i}`, name: `skill-${i}` }));
  const skills = buildSkillCandidates({ tenantId: 2, marketSkills, presets: [preset({ remoteId: 'market-129' })] });
  assert.equal(skills.length, 130);
  assert.equal(skills[129].presetId, 20);
});

test('same-name Skills keep separate references and stable keys before and after preparation', () => {
  const marketSkills = [
    { id: 'source-A', skillId: 'shared-alias', name: 'review', displayName: '审查', createUserId: 'alice' },
    { id: 'source-B', skillId: 'shared-alias', name: 'review', displayName: '审查', createUserId: 'bob' },
  ];
  const before = buildSkillCandidates({ tenantId: 2, marketSkills, presets: [] });
  const presets = [preset({ id: 31, remoteId: 'source-A', skillId: 'shared-alias' }), preset({ id: 32, remoteId: 'source-B', skillId: 'shared-alias' })];
  const after = buildSkillCandidates({ tenantId: 2, marketSkills, presets });
  assert.deepEqual(after.map((skill) => skill.presetId), [31, 32]);
  assert.deepEqual(before.map(getSkillCandidateKey), after.map(getSkillCandidateKey));
  assert.equal(new Set(after.map(getSkillCandidateKey)).size, 2);
  const refs = [{ tenantId: 2, presetId: 32 }];
  assert.deepEqual(after.filter((skill) => refs.some((ref) => ref.presetId === skill.presetId)).map((skill) => skill.sourceRef), ['source-B']);
  assert.deepEqual(getUnavailableSkillSelections({ tenantId: 2, skills: after, presets, refs }), []);
});

test('a stale catalog response does not overwrite prepared presets when switching tenants', () => {
  const fetched = [preset({ status: 'draft' }), preset({ tenantId: 1, id: 21 })];
  const prepared = [preset(), preset({ id: 22, remoteId: 'source-B' })];
  const merged = mergeSkillPresets(fetched, prepared);
  assert.equal(merged.length, 3);
  assert.equal(merged.find((entry) => entry.id === 20)?.status, 'published');
  const skills = buildSkillCandidates({ tenantId: 2, marketSkills: [{ id: 'source-B', name: 'market-research' }], presets: merged });
  assert.equal(skills[0].presetId, 22);
  assert.equal(skills[0].status, 'published');
});

test('tenant preinstalls never mark a template Skill as selected or prepared', () => {
  const options = { tenantId: 2, marketSkills: [{ id: 'market-id', name: 'market-research' }] };
  assert.equal(buildSkillCandidates({ ...options, presets: [preset({ preinstallScope: 'all_workspaces' })] })[0].presetId, undefined);
  assert.equal(buildSkillCandidates({ ...options, presets: [preset({ preinstallScope: 'all_workspaces' }), preset({ id: 31, preinstallScope: 'none' })] })[0].presetId, 31);
});

test('legacy shared records split by migration preserve the selected template reference', () => {
  const skills = buildSkillCandidates({
    tenantId: 2,
    marketSkills: [{ id: 'market-id', name: 'market-research' }],
    presets: [preset({ id: 30 }), preset({ id: 31 })],
    refs: [{ tenantId: 2, presetId: 31 }],
  });
  assert.equal(skills[0].presetId, 31);
});
