export type MarketSkill = {
  id?: string;
  skillId?: string;
  name: string;
  displayName?: string;
  description?: string;
  nspPath?: string;
  createUserId?: string;
  version?: number;
};

export type AdminSkillPreset = {
  id: number;
  tenantId: number;
  name: string;
  displayName: string;
  description?: string;
  skillId?: string;
  remoteId?: string;
  source?: { id?: string; skillId?: string };
  status: 'draft' | 'published' | 'disabled';
  lastValidationStatus?: string | null;
  preinstallScope?: 'none' | 'all_workspaces';
};

export type SkillCandidate = {
  id: number;
  tenantId: number;
  sourceRef: string;
  name: string;
  displayName: string;
  description?: string;
  presetId?: number;
  status?: AdminSkillPreset['status'];
  lastValidationStatus?: string | null;
  marketSkill: MarketSkill;
};

type SkillRef = { tenantId: number; presetId: number };

function identity(value: unknown) {
  return String(value ?? '').trim();
}

export function getSkillCandidateKey(skill: Pick<SkillCandidate, 'tenantId' | 'sourceRef'>) {
  return `${skill.tenantId}:${skill.sourceRef}`;
}

// A catalog request may start before a preset is prepared; never lose newer results.
export function mergeSkillPresets(presets: AdminSkillPreset[], prepared: AdminSkillPreset[]) {
  const entries = new Map<string, AdminSkillPreset>();
  for (const preset of [...presets, ...prepared]) entries.set(`${preset.tenantId}:${preset.id}`, preset);
  return [...entries.values()];
}

// Local presets enrich market entries; they must never expand the market's visibility.
export function buildSkillCandidates({ tenantId, marketSkills, presets, refs = [] }: {
  tenantId: number;
  marketSkills: MarketSkill[];
  presets: AdminSkillPreset[];
  refs?: SkillRef[];
}): SkillCandidate[] {
  const candidates = new Map<string, SkillCandidate>();
  const selectedPresetIds = new Set(refs.filter((ref) => ref.tenantId === tenantId).map((ref) => ref.presetId));
  const templatePresets = presets.filter((entry) => entry.preinstallScope !== 'all_workspaces')
    .sort((left, right) => Number(selectedPresetIds.has(right.id)) - Number(selectedPresetIds.has(left.id)));
  for (const skill of marketSkills) {
    const remoteId = identity(skill.id) || identity(skill.skillId);
    const sourceRef = remoteId || identity(skill.name);
    if (!sourceRef) continue;
    const preset = templatePresets.find((entry) => {
      if (Number(entry.tenantId) !== tenantId) return false;
      const presetRemoteId = identity(entry.remoteId) || identity(entry.source?.id);
      if (remoteId && presetRemoteId) return remoteId === presetRemoteId;
      const presetSkillId = identity(entry.skillId) || identity(entry.source?.skillId);
      if (remoteId || presetRemoteId || presetSkillId) {
        return Boolean(remoteId && presetSkillId && remoteId === presetSkillId);
      }
      // Legacy entries without remote identifiers may still be matched by name.
      return identity(entry.name) === identity(skill.name);
    });
    const presetId = Number(preset?.id) || undefined;
    candidates.set(sourceRef, {
      id: presetId || 0,
      presetId,
      tenantId,
      sourceRef,
      name: skill.name || sourceRef,
      displayName: skill.displayName || skill.name || sourceRef,
      description: skill.description || '',
      status: preset?.status,
      lastValidationStatus: preset?.lastValidationStatus,
      marketSkill: skill,
    });
  }
  return [...candidates.values()];
}

// Keep missing selections removable without presenting them as selectable skills.
export function getUnavailableSkillSelections({ tenantId, skills, presets, refs }: {
  tenantId: number;
  skills: SkillCandidate[];
  presets: AdminSkillPreset[];
  refs: SkillRef[];
}) {
  const visiblePresetIds = new Set(skills.map((skill) => skill.presetId).filter(Boolean));
  return refs.filter((ref) => ref.tenantId === tenantId && !visiblePresetIds.has(ref.presetId))
    .map((ref) => {
      const preset = presets.find((entry) => Number(entry.tenantId) === tenantId && Number(entry.id) === ref.presetId);
      return {
        id: ref.presetId,
        tenantId,
        name: preset?.name || `Skill #${ref.presetId}`,
        displayName: preset?.displayName || preset?.name || `Skill #${ref.presetId}`,
      };
    });
}
