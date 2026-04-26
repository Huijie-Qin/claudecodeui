import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Shield } from 'lucide-react';

import { api } from '../../utils/api';
import { useTenant } from '../../contexts/TenantContext';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../shared/view/ui';

import { buildTenantMembershipPayload, normalizeTenantCode, type TenantPermission } from './adminPanelUtils';

type AdminTenant = {
  id: number;
  code: string;
  name: string;
  status: string;
};

type AdminUser = {
  id: number;
  username: string;
  is_active: number;
  is_system_admin: number;
};

type AdminPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type AdminTenantsPayload = {
  tenants?: AdminTenant[];
  error?: string;
};

type AdminUsersPayload = {
  users?: AdminUser[];
  error?: string;
};

type AdminErrorPayload = {
  error?: string;
  message?: string;
};

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => ({} as AdminErrorPayload));
  return payload.error || payload.message || fallback;
}

export default function AdminPanel({ open, onOpenChange }: AdminPanelProps) {
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [tenantCode, setTenantCode] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [permission, setPermission] = useState<TenantPermission>('edit');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const { refreshTenants } = useTenant();

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const [tenantResponse, userResponse] = await Promise.all([
        api.admin.tenants(),
        api.admin.users(),
      ]);

      if (!tenantResponse.ok) {
        setError(await readError(tenantResponse, 'Failed to load tenants'));
        return;
      }

      if (!userResponse.ok) {
        setError(await readError(userResponse, 'Failed to load users'));
        return;
      }

      const tenantPayload = await tenantResponse.json() as AdminTenantsPayload;
      const userPayload = await userResponse.json() as AdminUsersPayload;
      setTenants(tenantPayload.tenants || []);
      setUsers(userPayload.users || []);
    } catch (caughtError) {
      console.error('[AdminPanel] Failed to load admin data:', caughtError);
      setError('Failed to load admin data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void load();
    }
  }, [load, open]);

  const createTenant = async () => {
    const code = normalizeTenantCode(tenantCode);
    const name = tenantName.trim();

    setError(null);
    if (!code || !name) {
      setError('Tenant code and name are required');
      return;
    }

    setIsSaving(true);
    try {
      const response = await api.admin.createTenant({ code, name });
      if (!response.ok) {
        setError(await readError(response, 'Failed to create tenant'));
        return;
      }

      setTenantCode('');
      setTenantName('');
      await load();
      await refreshTenants();
    } finally {
      setIsSaving(false);
    }
  };

  const grantMembership = async () => {
    const tenantId = Number(selectedTenantId);
    const userId = Number(selectedUserId);

    setError(null);
    if (!tenantId || !userId) {
      setError('Select a tenant and a user');
      return;
    }

    setIsSaving(true);
    try {
      const response = await api.admin.upsertTenantUser(
        tenantId,
        userId,
        buildTenantMembershipPayload(permission),
      );

      if (!response.ok) {
        setError(await readError(response, 'Failed to grant tenant access'));
        return;
      }

      setSelectedTenantId('');
      setSelectedUserId('');
      setPermission('edit');
      await load();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-hidden p-0">
        <DialogTitle>System administration</DialogTitle>
        <div className="flex max-h-[88vh] flex-col">
          <div className="flex items-center gap-3 border-b border-border px-5 py-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Shield className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">System administration</h2>
              <p className="truncate text-xs text-muted-foreground">Tenants, users, and memberships</p>
            </div>
          </div>

          <div className="space-y-5 overflow-y-auto px-5 py-4">
            <section className="space-y-3">
              <h3 className="text-sm font-medium text-foreground">Create tenant</h3>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">Code</span>
                  <Input
                    value={tenantCode}
                    onChange={(event) => setTenantCode(normalizeTenantCode(event.target.value))}
                    placeholder="acme"
                    autoCapitalize="none"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">Name</span>
                  <Input
                    value={tenantName}
                    onChange={(event) => setTenantName(event.target.value)}
                    placeholder="Acme"
                  />
                </label>
                <Button className="self-end" onClick={createTenant} disabled={isSaving}>
                  <Plus className="h-4 w-4" />
                  Create
                </Button>
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-medium text-foreground">Grant tenant access</h3>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_auto]">
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">Tenant</span>
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={selectedTenantId}
                    onChange={(event) => setSelectedTenantId(event.target.value)}
                  >
                    <option value="">Select</option>
                    {tenants.map((tenant) => (
                      <option key={tenant.id} value={tenant.id}>
                        {tenant.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">User</span>
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={selectedUserId}
                    onChange={(event) => setSelectedUserId(event.target.value)}
                  >
                    <option value="">Select</option>
                    {users.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.username}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">Access</span>
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={permission}
                    onChange={(event) => setPermission(event.target.value as TenantPermission)}
                  >
                    <option value="edit">Edit</option>
                    <option value="view">View</option>
                  </select>
                </label>
                <Button className="self-end" onClick={grantMembership} disabled={isSaving}>
                  Grant
                </Button>
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium text-foreground">Tenants</h3>
                <Button variant="ghost" size="icon" onClick={() => void load()} disabled={isLoading}>
                  <RefreshCw className={isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                </Button>
              </div>
              <div className="max-h-48 overflow-auto rounded-md border border-border">
                {tenants.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-muted-foreground">No tenants</div>
                ) : (
                  tenants.map((tenant) => (
                    <div
                      key={tenant.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0"
                    >
                      <span className="truncate font-medium text-foreground">{tenant.name}</span>
                      <span className="truncate text-muted-foreground">{tenant.code}</span>
                      <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{tenant.status}</span>
                    </div>
                  ))
                )}
              </div>
            </section>

            {error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
