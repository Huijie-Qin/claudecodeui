export const SLASH_COMMANDS_CHANGED_EVENT = 'cloudcli:slash-commands-changed';

export type SlashCommandsChangedDetail = {
  filePath?: string | null;
  projectName?: string | null;
  reason?: string;
  workspaceId?: number | string | null;
};

export function isSlashCommandSourcePath(filePath: string | null | undefined): boolean {
  if (!filePath) {
    return false;
  }

  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  return normalizedPath.includes('/.claude/commands/')
    || normalizedPath.startsWith('.claude/commands/')
    || normalizedPath.includes('/.claude/skills/')
    || normalizedPath.startsWith('.claude/skills/')
    || normalizedPath.includes('/.cloudcli/skills/sources/')
    || normalizedPath.startsWith('.cloudcli/skills/sources/')
    || normalizedPath.endsWith('/skill.md');
}

export function dispatchSlashCommandsChanged(detail: SlashCommandsChangedDetail = {}) {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent(SLASH_COMMANDS_CHANGED_EVENT, {
    detail,
  }));
}

export function dispatchSlashCommandsChangedForPath(
  filePath: string | null | undefined,
  detail: Omit<SlashCommandsChangedDetail, 'filePath'> = {},
) {
  if (!isSlashCommandSourcePath(filePath)) {
    return;
  }

  dispatchSlashCommandsChanged({
    ...detail,
    filePath,
  });
}
