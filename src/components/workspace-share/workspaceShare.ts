export type WorkspaceSharePermission = 'view' | 'edit';

export type WorkspaceAclEntryInput = {
  userId: number;
  permission: string;
};

export type WorkspaceAclEntry = {
  userId: number;
  permission: WorkspaceSharePermission;
};

export function normalizeWorkspaceAclEntries(
  ownerUserId: number,
  entries: WorkspaceAclEntryInput[],
): WorkspaceAclEntry[] {
  const normalizedByUser = new Map<number, WorkspaceSharePermission>();

  for (const entry of entries) {
    const userId = Number(entry.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      continue;
    }

    if (userId === Number(ownerUserId)) {
      continue;
    }

    if (entry.permission !== 'view' && entry.permission !== 'edit') {
      continue;
    }

    normalizedByUser.set(userId, entry.permission);
  }

  return Array.from(normalizedByUser.entries()).map(([userId, permission]) => ({
    userId,
    permission,
  }));
}
