import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Plus, RefreshCw, Shield, Trash2, UserMinus, UserPlus } from 'lucide-react';

import { api } from '../../utils/api';
import { useTenant } from '../../contexts/TenantContext';
import { copyTextToClipboard } from '../../utils/clipboard';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../shared/view/ui';
import { useAuth } from '../auth/context/AuthContext';

import { buildTenantMembershipPayload, normalizeTenantCode, type TenantPermission } from './adminPanelUtils';
import McpPresetsTab from './McpPresetsTab';
import RuntimeMonitorTab from './RuntimeMonitorTab';

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
  created_at?: string;
  last_login?: string | null;
  invitation_status?: 'active' | 'invited' | 'expired' | 'inactive';
  invitation_expires_at?: string | null;
};

type AdminMembership = {
  tenant_id: number;
  user_id: number;
  role: string;
  permission: TenantPermission;
  status: string;
  tenant_code: string;
  tenant_name: string;
  tenant_status: string;
  username: string;
  user_is_active: number;
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

type AdminCreateUserPayload = {
  user?: AdminUser;
  invitation?: {
    url?: string;
    expires_at?: string;
  };
  error?: string;
  message?: string;
};

type AdminMembershipsPayload = {
  memberships?: AdminMembership[];
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

function formatDateTime(value?: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function getUserStatusLabel(user: AdminUser): string {
  if (user.is_active === 1 || user.invitation_status === 'active') return 'Active';
  if (user.invitation_status === 'invited') return 'Pending invite';
  if (user.invitation_status === 'expired') return 'Invite expired';
  return 'Inactive';
}

function getUserStatusClassName(user: AdminUser): string {
  if (user.is_active === 1 || user.invitation_status === 'active') {
    return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  }
  if (user.invitation_status === 'invited') {
    return 'bg-amber-500/10 text-amber-700 dark:text-amber-300';
  }
  return 'bg-muted text-muted-foreground';
}

function membershipKey(membership: Pick<AdminMembership, 'tenant_id' | 'user_id'>): string {
  return `${membership.tenant_id}:${membership.user_id}`;
}

export default function AdminPanel({ open, onOpenChange }: AdminPanelProps) {
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [memberships, setMemberships] = useState<AdminMembership[]>([]);
  const [tenantCode, setTenantCode] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [createdInvite, setCreatedInvite] = useState<{ username: string; url: string; expiresAt?: string } | null>(null);
  const [copiedInviteUrl, setCopiedInviteUrl] = useState(false);
  const [copiedActivationUserId, setCopiedActivationUserId] = useState<number | null>(null);
  const [copyingActivationUserId, setCopyingActivationUserId] = useState<number | null>(null);
  const [deletingUserId, setDeletingUserId] = useState<number | null>(null);
  const [deletingMembership, setDeletingMembership] = useState<string | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [permission, setPermission] = useState<TenantPermission>('edit');
  const [activeTab, setActiveTab] = useState<'users' | 'tenants' | 'mcpPresets' | 'runtimes'>('users');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const { currentTenant, refreshTenants } = useTenant();
  const { user: currentUser } = useAuth();
  const currentUserId = currentUser?.id == null ? null : Number(currentUser.id);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const [tenantResponse, userResponse, membershipResponse] = await Promise.all([
        api.admin.tenants(),
        api.admin.users(),
        api.admin.memberships(),
      ]);

      if (!tenantResponse.ok) {
        setError(await readError(tenantResponse, 'Failed to load tenants'));
        return;
      }

      if (!userResponse.ok) {
        setError(await readError(userResponse, 'Failed to load users'));
        return;
      }

      if (!membershipResponse.ok) {
        setError(await readError(membershipResponse, 'Failed to load tenant access'));
        return;
      }

      const tenantPayload = await tenantResponse.json() as AdminTenantsPayload;
      const userPayload = await userResponse.json() as AdminUsersPayload;
      const membershipPayload = await membershipResponse.json() as AdminMembershipsPayload;
      setTenants(tenantPayload.tenants || []);
      setUsers(userPayload.users || []);
      setMemberships(membershipPayload.memberships || []);
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

  const createUserInvite = async () => {
    const username = newUsername.trim();

    setError(null);
    setCreatedInvite(null);
    setCopiedInviteUrl(false);
    if (username.length < 3) {
      setError('Username must be at least 3 characters');
      return;
    }

    setIsSaving(true);
    try {
      const response = await api.admin.createUser({ username });
      const payload = await response.json().catch(() => ({} as AdminCreateUserPayload)) as AdminCreateUserPayload;
      if (!response.ok || !payload.invitation?.url) {
        setError(payload.error || payload.message || 'Failed to create user invitation');
        return;
      }

      setNewUsername('');
      setCreatedInvite({
        username: payload.user?.username || username,
        url: payload.invitation.url,
        expiresAt: payload.invitation.expires_at,
      });
      await load();
    } finally {
      setIsSaving(false);
    }
  };

  const copyInviteLink = async () => {
    if (!createdInvite?.url) return;
    const copied = await copyTextToClipboard(createdInvite.url);
    setCopiedInviteUrl(copied);
    if (copied) {
      window.setTimeout(() => setCopiedInviteUrl(false), 1600);
    }
  };

  const copyActivationLinkForUser = async (targetUser: AdminUser) => {
    setError(null);
    setCopyingActivationUserId(targetUser.id);
    setCopiedActivationUserId(null);

    try {
      const response = await api.admin.createUserActivationLink(targetUser.id);
      const payload = await response.json().catch(() => ({} as AdminCreateUserPayload)) as AdminCreateUserPayload;
      if (!response.ok || !payload.invitation?.url) {
        setError(payload.error || payload.message || 'Failed to create activation link');
        return;
      }

      const copied = await copyTextToClipboard(payload.invitation.url);
      setCreatedInvite({
        username: payload.user?.username || targetUser.username,
        url: payload.invitation.url,
        expiresAt: payload.invitation.expires_at,
      });
      setCopiedInviteUrl(copied);

      if (copied) {
        setCopiedActivationUserId(targetUser.id);
        window.setTimeout(() => setCopiedActivationUserId(null), 1600);
      }

      await load();
    } finally {
      setCopyingActivationUserId(null);
    }
  };

  const deleteUser = async (targetUser: AdminUser) => {
    if (targetUser.id === currentUserId) {
      setError('You cannot delete your own user account');
      return;
    }

    const confirmed = window.confirm(`Delete user "${targetUser.username}"? This removes their tenant access and owned data.`);
    if (!confirmed) return;

    setError(null);
    setDeletingUserId(targetUser.id);

    try {
      const response = await api.admin.deleteUser(targetUser.id);
      if (!response.ok) {
        setError(await readError(response, 'Failed to delete user'));
        return;
      }

      if (createdInvite?.username === targetUser.username) {
        setCreatedInvite(null);
      }

      await load();
      await refreshTenants();
    } finally {
      setDeletingUserId(null);
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
      await refreshTenants();
    } finally {
      setIsSaving(false);
    }
  };

  const removeMembership = async (membership: AdminMembership) => {
    const confirmed = window.confirm(`Remove ${membership.username}'s access to ${membership.tenant_name}?`);
    if (!confirmed) return;

    setError(null);
    setDeletingMembership(membershipKey(membership));

    try {
      const response = await api.admin.deleteTenantUser(membership.tenant_id, membership.user_id);
      if (!response.ok) {
        setError(await readError(response, 'Failed to delete tenant access'));
        return;
      }

      await load();
      await refreshTenants();
    } finally {
      setDeletingMembership(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-6xl overflow-hidden p-0">
        <DialogTitle>System administration</DialogTitle>
        <div className="flex max-h-[88vh] flex-col">
          <div className="flex items-center gap-3 border-b border-border px-5 py-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Shield className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">System administration</h2>
              <p className="truncate text-xs text-muted-foreground">Tenants, users, internal MCP presets, and runtimes</p>
            </div>
          </div>

          <div className="flex gap-1 border-b border-border px-5 py-2">
            <Button
              variant={activeTab === 'users' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setActiveTab('users')}
            >
              Users
            </Button>
            <Button
              variant={activeTab === 'tenants' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setActiveTab('tenants')}
            >
              Tenant Access
            </Button>
            <Button
              variant={activeTab === 'mcpPresets' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setActiveTab('mcpPresets')}
            >
              MCP Server Presets
            </Button>
            <Button
              variant={activeTab === 'runtimes' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setActiveTab('runtimes')}
            >
              Runtime Monitor
            </Button>
          </div>

          {activeTab === 'users' ? (
            <div className="space-y-5 overflow-y-auto px-5 py-4">
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">Create user</h3>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">Username</span>
                    <Input
                      value={newUsername}
                      onChange={(event) => setNewUsername(event.target.value)}
                      placeholder="teammate"
                      autoCapitalize="none"
                      autoComplete="off"
                    />
                  </label>
                  <Button className="self-end" onClick={createUserInvite} disabled={isSaving}>
                    <UserPlus className="h-4 w-4" />
                    Create Invite
                  </Button>
                </div>
              </section>

              {createdInvite ? (
                <section className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-medium text-foreground">Invitation link</h3>
                      <p className="text-xs text-muted-foreground">
                        {createdInvite.username}
                        {createdInvite.expiresAt ? ` · Expires ${formatDateTime(createdInvite.expiresAt)}` : ''}
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void copyInviteLink()}>
                      {copiedInviteUrl ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      {copiedInviteUrl ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                  <Input value={createdInvite.url} readOnly className="font-mono text-xs" />
                </section>
              ) : null}

              <section className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">Grant tenant access</h3>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_auto]">
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
                  <h3 className="text-sm font-medium text-foreground">Users</h3>
                  <Button variant="ghost" size="icon" onClick={() => void load()} disabled={isLoading}>
                    <RefreshCw className={isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                  </Button>
                </div>
                <div className="max-h-72 overflow-auto rounded-md border border-border">
                  {users.length === 0 ? (
                    <div className="px-3 py-4 text-sm text-muted-foreground">No users</div>
                  ) : (
                    users.map((user) => (
                      <div
                        key={user.id}
                        className="grid gap-3 border-b border-border px-3 py-3 text-sm last:border-b-0 lg:grid-cols-[minmax(0,1fr)_auto]"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate font-medium text-foreground">{user.username}</span>
                            {user.is_system_admin === 1 ? (
                              <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
                                Admin
                              </span>
                            ) : null}
                            <span className={`rounded px-2 py-0.5 text-xs ${getUserStatusClassName(user)}`}>
                              {getUserStatusLabel(user)}
                            </span>
                          </div>
                          <div className="mt-1 truncate text-xs text-muted-foreground">
                            Last login {formatDateTime(user.last_login)}
                            {' · '}
                            {user.invitation_status === 'invited' && user.invitation_expires_at
                              ? `Invite expires ${formatDateTime(user.invitation_expires_at)}`
                              : `Created ${formatDateTime(user.created_at)}`}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {memberships.filter((membership) => membership.user_id === user.id).length === 0 ? (
                              <span className="text-xs text-muted-foreground">No tenant access</span>
                            ) : (
                              memberships
                                .filter((membership) => membership.user_id === user.id)
                                .map((membership) => (
                                  <span
                                    key={membershipKey(membership)}
                                    className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                                  >
                                    {membership.tenant_name} · {membership.permission}
                                  </span>
                                ))
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                          {user.is_active !== 1 ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void copyActivationLinkForUser(user)}
                              disabled={copyingActivationUserId === user.id}
                            >
                              {copiedActivationUserId === user.id ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                              {copiedActivationUserId === user.id ? 'Copied' : 'Activation Link'}
                            </Button>
                          ) : null}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void deleteUser(user)}
                            disabled={deletingUserId === user.id || user.id === currentUserId}
                          >
                            <Trash2 className="h-4 w-4" />
                            Delete
                          </Button>
                        </div>
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
          ) : null}

          {activeTab === 'tenants' ? (
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
                  <h3 className="text-sm font-medium text-foreground">Tenant access</h3>
                  <Button variant="ghost" size="icon" onClick={() => void load()} disabled={isLoading}>
                    <RefreshCw className={isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                  </Button>
                </div>
                <div className="max-h-72 overflow-auto rounded-md border border-border">
                  {tenants.length === 0 ? (
                    <div className="px-3 py-4 text-sm text-muted-foreground">No tenants</div>
                  ) : (
                    tenants.map((tenant) => {
                      const tenantMemberships = memberships.filter((membership) => membership.tenant_id === tenant.id);
                      return (
                        <div key={tenant.id} className="border-b border-border px-3 py-3 text-sm last:border-b-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-foreground">{tenant.name}</span>
                            <span className="text-xs text-muted-foreground">{tenant.code}</span>
                            <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{tenant.status}</span>
                          </div>
                          <div className="mt-3 space-y-2">
                            {tenantMemberships.length === 0 ? (
                              <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                                No authorized users
                              </div>
                            ) : (
                              tenantMemberships.map((membership) => (
                                <div
                                  key={membershipKey(membership)}
                                  className="grid gap-2 rounded-md bg-muted/30 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]"
                                >
                                  <span className="min-w-0 truncate text-foreground">{membership.username}</span>
                                  <span className="self-center rounded bg-background px-2 py-0.5 text-xs text-muted-foreground">
                                    {membership.permission}
                                  </span>
                                  <span className="self-center rounded bg-background px-2 py-0.5 text-xs text-muted-foreground">
                                    {membership.status}
                                  </span>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => void removeMembership(membership)}
                                    disabled={deletingMembership === membershipKey(membership)}
                                  >
                                    <UserMinus className="h-4 w-4" />
                                    Remove
                                  </Button>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">Tenants</h3>
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
          ) : null}

          {activeTab === 'mcpPresets' ? (
            <div className="overflow-y-auto px-5 py-4">
              <McpPresetsTab tenants={tenants} currentTenantId={currentTenant?.id} />
            </div>
          ) : null}

          {activeTab === 'runtimes' ? (
            <div className="overflow-y-auto px-5 py-4">
              <RuntimeMonitorTab />
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
