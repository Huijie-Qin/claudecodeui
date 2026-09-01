export type WorkspaceSkillKind = 'managed' | 'unmanaged' | 'system';
export type WorkspaceSkillStatus = 'enabled' | 'disabled' | 'available' | 'invalid';

export type WorkspaceSkill = {
  name: string;
  displayName?: string;
  description?: string;
  kind: WorkspaceSkillKind;
  status: WorkspaceSkillStatus;
  enabled: boolean;
  manageable: boolean;
  sourceType: string;
  sourceUrl?: string;
  resolvedCommit?: string;
  sourceSubdir?: string;
  sourceFileName?: string;
  sourcePath?: string;
  runtimePath?: string;
  manifestPath?: string;
  parseError?: string;
  diagnostics?: Array<{ code: string; message: string; path?: string }>;
  origin?: 'market' | 'local';
  bindingType?: 'published' | 'imported';
  published?: boolean;
  imported?: boolean;
  locallyModified?: boolean;
  targetPath?: string;
  localVersion?: number;
  marketVersion?: number;
  updateAvailable?: boolean;
  remoteDeleted?: boolean;
  createUserId?: string;
  files?: WorkspaceSkillEntry[];
};

export type WorkspaceSkillEntry = {
  path: string;
  type: 'directory' | 'file' | 'symlink';
  size?: number;
  mimeType?: string;
};

export type SkillDetailVersionFields = {
  importedVersion?: number;
  localVersion?: number;
  marketVersion?: number;
  version?: number;
};

const KIND_ORDER: Record<WorkspaceSkillKind, number> = {
  managed: 0,
  unmanaged: 1,
  system: 2,
};

const STATUS_ORDER: Record<WorkspaceSkillStatus, number> = {
  invalid: 0,
  enabled: 1,
  disabled: 2,
  available: 3,
};

export function sortWorkspaceSkills(skills: WorkspaceSkill[]): WorkspaceSkill[] {
  return [...skills].sort((left, right) => {
    const kindDiff = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
    if (kindDiff !== 0) return kindDiff;
    const statusDiff = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
    if (statusDiff !== 0) return statusDiff;
    return left.name.localeCompare(right.name);
  });
}

export function filterWorkspaceSkills(skills: WorkspaceSkill[], query: string): WorkspaceSkill[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return skills;

  return skills.filter((skill) => getSkillSearchText(skill).includes(normalizedQuery));
}

export function getSkillKindLabelKey(skill: WorkspaceSkill): string {
  return `skillsMarket.kind.${skill.kind}`;
}

export function getSkillStatusLabelKey(skill: WorkspaceSkill): string {
  return `skillsMarket.status.${skill.status}`;
}

export function getSkillDisplayName(skill: WorkspaceSkill): string {
  return skill.displayName || skill.name;
}

export function getSkillDetailDisplayVersions(detail: SkillDetailVersionFields): {
  localVersion?: number;
  marketVersion?: number;
} {
  return {
    marketVersion: typeof detail.marketVersion === 'number'
      ? detail.marketVersion
      : typeof detail.version === 'number' ? detail.version : undefined,
    localVersion: typeof detail.localVersion === 'number'
      ? detail.localVersion
      : typeof detail.importedVersion === 'number' ? detail.importedVersion : undefined,
  };
}

export function canEditSkillDetailEntries(source: 'market' | 'mine', canManage: boolean): boolean {
  return source === 'mine' && canManage;
}

function getSkillSearchText(skill: WorkspaceSkill): string {
  return [
    skill.name,
    skill.displayName,
    skill.description,
    skill.kind,
    skill.status,
    skill.sourceType,
    skill.sourceUrl,
    skill.resolvedCommit,
    skill.sourceSubdir,
    skill.sourceFileName,
    skill.parseError,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
