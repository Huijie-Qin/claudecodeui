import type { SkillCandidate } from '../admin/agentTemplateSkillCatalog';

type PublishedPreset = { id: number; tenantId: number; name: string; displayName: string; description?: string };

// Tenant administrators reference already-published template presets. They do
// not search the platform market or create/validate/publish platform presets.
export function tenantTemplateSkillCandidates(presets: PublishedPreset[], tenantId: number): SkillCandidate[] {
  return presets.filter(preset => Number(preset.tenantId) === tenantId && Number.isInteger(Number(preset.id)) && Number(preset.id) > 0)
    .map(preset => ({
      ...preset,
      id: Number(preset.id),
      tenantId,
      presetId: Number(preset.id),
      sourceRef: `preset:${preset.id}`,
      status: 'published',
      marketSkill: { name: preset.name, displayName: preset.displayName },
    }));
}
