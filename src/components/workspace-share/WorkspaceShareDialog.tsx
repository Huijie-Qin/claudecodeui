import { useCallback, useEffect, useState } from 'react';
import { Share2, Trash2 } from 'lucide-react';
import { api } from '../../utils/api';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../shared/view/ui';
import type { Project } from '../../types/app';
import {
  normalizeWorkspaceAclEntries,
  type WorkspaceAclEntry,
  type WorkspaceSharePermission,
} from './workspaceShare';

type WorkspaceShareDialogProps = {
  project: Project | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type WorkspaceAclApiEntry = {
  userId?: number;
  user_id?: number;
  permission?: string;
  username?: string;
};

type WorkspaceShareEntry = WorkspaceAclEntry & {
  username?: string;
};

type WorkspaceSharePayload = {
  acl?: WorkspaceAclApiEntry[];
  error?: string;
  message?: string;
};

type WorkspaceShareErrorPayload = {
  error?: string;
  message?: string;
};

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => ({} as WorkspaceShareErrorPayload));
  return payload.error || payload.message || fallback;
}

function mapApiAclEntries(ownerUserId: number, acl: WorkspaceAclApiEntry[] = []): WorkspaceShareEntry[] {
  const normalized = normalizeWorkspaceAclEntries(
    ownerUserId,
    acl.map((entry) => ({
      userId: Number(entry.userId ?? entry.user_id),
      permission: entry.permission || '',
    })),
  );

  return normalized.map((entry) => ({
    ...entry,
    username: acl.find((apiEntry) => Number(apiEntry.userId ?? apiEntry.user_id) === entry.userId)?.username,
  }));
}

export default function WorkspaceShareDialog({ project, open, onOpenChange }: WorkspaceShareDialogProps) {
  const [entries, setEntries] = useState<WorkspaceShareEntry[]>([]);
  const [newUserId, setNewUserId] = useState('');
  const [newPermission, setNewPermission] = useState<WorkspaceSharePermission>('edit');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ownerUserId = Number(project?.ownerUserId ?? 0);

  const load = useCallback(async () => {
    if (!project?.workspaceId) {
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const response = await api.workspaceShare.get(project.workspaceId);
      if (!response.ok) {
        setError(await readError(response, 'Failed to load sharing settings'));
        return;
      }

      const payload = await response.json() as WorkspaceSharePayload;
      setEntries(mapApiAclEntries(ownerUserId, payload.acl || []));
    } catch (caughtError) {
      console.error('[WorkspaceShareDialog] Failed to load sharing settings:', caughtError);
      setError('Failed to load sharing settings');
    } finally {
      setIsLoading(false);
    }
  }, [ownerUserId, project?.workspaceId]);

  useEffect(() => {
    if (open) {
      void load();
    } else {
      setEntries([]);
      setNewUserId('');
      setNewPermission('edit');
      setError(null);
    }
  }, [load, open]);

  const addEntry = () => {
    const userId = Number(newUserId);
    const normalized = normalizeWorkspaceAclEntries(ownerUserId, [
      ...entries,
      { userId, permission: newPermission },
    ]);

    if (!Number.isInteger(userId) || userId <= 0) {
      setError('Enter a valid user ID');
      return;
    }

    if (userId === ownerUserId) {
      setError('Owner is already included');
      return;
    }

    setEntries(normalized.map((entry) => ({
      ...entry,
      username: entries.find((existing) => existing.userId === entry.userId)?.username,
    })));
    setNewUserId('');
    setNewPermission('edit');
    setError(null);
  };

  const save = async () => {
    if (!project?.workspaceId) {
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const payload = normalizeWorkspaceAclEntries(ownerUserId, entries);
      const response = await api.workspaceShare.update(project.workspaceId, payload);
      if (!response.ok) {
        setError(await readError(response, 'Failed to save sharing settings'));
        return;
      }

      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  const projectName = project?.displayName || project?.name || 'Workspace';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl overflow-hidden p-0">
        <DialogTitle>Share workspace</DialogTitle>
        <div className="flex max-h-[82vh] flex-col">
          <div className="flex items-center gap-3 border-b border-border px-5 py-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Share2 className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-foreground">Share workspace</h2>
              <p className="truncate text-xs text-muted-foreground">{projectName}</p>
            </div>
          </div>

          <div className="space-y-4 overflow-y-auto px-5 py-4">
            <div className="space-y-2">
              {isLoading ? (
                <div className="rounded-md border border-border px-3 py-4 text-sm text-muted-foreground">
                  Loading
                </div>
              ) : entries.length === 0 ? (
                <div className="rounded-md border border-border px-3 py-4 text-sm text-muted-foreground">
                  No shared users
                </div>
              ) : (
                entries.map((entry) => (
                  <div key={entry.userId} className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      User #{entry.userId}{entry.username ? ` - ${entry.username}` : ''}
                    </span>
                    <select
                      className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={entry.permission}
                      onChange={(event) => {
                        setEntries((prev) => prev.map((item) => (
                          item.userId === entry.userId
                            ? { ...item, permission: event.target.value as WorkspaceSharePermission }
                            : item
                        )));
                      }}
                    >
                      <option value="view">View</option>
                      <option value="edit">Edit</option>
                    </select>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setEntries((prev) => prev.filter((item) => item.userId !== entry.userId))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))
              )}
            </div>

            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px_auto]">
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">User ID</span>
                <Input
                  value={newUserId}
                  onChange={(event) => setNewUserId(event.target.value)}
                  inputMode="numeric"
                  placeholder="42"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">Access</span>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={newPermission}
                  onChange={(event) => setNewPermission(event.target.value as WorkspaceSharePermission)}
                >
                  <option value="edit">Edit</option>
                  <option value="view">View</option>
                </select>
              </label>
              <Button className="self-end" variant="outline" onClick={addEntry}>
                Add
              </Button>
            </div>

            {error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}
          </div>

          <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={isSaving || isLoading || !project?.workspaceId}>
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
