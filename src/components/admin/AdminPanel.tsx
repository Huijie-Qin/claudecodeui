import { useCallback, useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { Check, ChevronDown, Copy, KeyRound, Plus, RefreshCw, Search, Shield, Trash2, UserMinus, UserPlus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../utils/api';
import { useTenant } from '../../contexts/TenantContext';
import { copyTextToClipboard } from '../../utils/clipboard';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
} from '../../shared/view/ui';
import { useAuth } from '../auth/context/AuthContext';

import {
  buildTenantMembershipPayload,
  normalizeTenantCode,
  parseBatchUsernames,
  type TenantPermission,
} from './adminPanelUtils';
import McpPresetsTab from './McpPresetsTab';
import PlatformAnalyticsTab from './PlatformAnalyticsTab';
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

type AdminPasswordResetPayload = {
  user?: AdminUser;
  passwordReset?: {
    url?: string;
    expires_at?: string;
  };
  error?: string;
  message?: string;
};

type AdminBatchSummary = {
  total: number;
  succeeded: number;
  failed: number;
};

type AdminBatchCreateUserResult = {
  username: string;
  success: boolean;
  user?: AdminUser;
  invitation?: {
    url?: string;
    expires_at?: string;
  };
  error?: string;
};

type AdminBatchCreateUsersPayload = {
  results?: AdminBatchCreateUserResult[];
  summary?: AdminBatchSummary;
  error?: string;
  message?: string;
};

type AdminMembershipsPayload = {
  memberships?: AdminMembership[];
  error?: string;
};

type AdminBatchMembershipResult = {
  tenantId: number;
  userId: number;
  success: boolean;
  membership?: AdminMembership;
  error?: string;
};

type AdminBatchMembershipsPayload = {
  results?: AdminBatchMembershipResult[];
  summary?: AdminBatchSummary;
  error?: string;
  message?: string;
};

type AdminBatchClaudeEnvResult = {
  userId: number;
  username?: string;
  success: boolean;
  error?: string;
};

type AdminBatchClaudeEnvPayload = {
  results?: AdminBatchClaudeEnvResult[];
  summary?: AdminBatchSummary;
  error?: string;
  message?: string;
};

type AdminErrorPayload = {
  error?: string;
  message?: string;
};

type AdminToast = {
  message: string;
  type: 'success' | 'error';
} | null;

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => ({} as AdminErrorPayload));
  return payload.error || payload.message || fallback;
}
function formatDateTime(value?: string | null, emptyLabel = 'Never'): string {
  if (!value) return emptyLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
function getUserStatusKey(user: AdminUser): string {
  if (user.is_active === 1 || user.invitation_status === 'active') return 'active';
  if (user.invitation_status === 'invited') return 'pendingInvite';
  if (user.invitation_status === 'expired') return 'inviteExpired';
  return 'inactive';
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

function translateStatus(t: TFunction, value: string): string {
  return t(`statuses.${value}`, { defaultValue: value });
}

function translatePermission(t: TFunction, value: TenantPermission): string {
  return t(`permissions.${value}`, { defaultValue: value });
}
function toggleSelectedId(values: string[], id: number, checked: boolean): string[] {
  const value = String(id);
  if (checked) {
    return values.includes(value) ? values : [...values, value];
  }

  return values.filter((item) => item !== value);
}
function matchesQuery(value: string, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return value.toLowerCase().includes(normalizedQuery);
}
export default function AdminPanel({ open, onOpenChange }: AdminPanelProps) {
  const { t } = useTranslation('admin');
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [memberships, setMemberships] = useState<AdminMembership[]>([]);
  const [tenantCode, setTenantCode] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [createdInvite, setCreatedInvite] = useState<{ username: string; url: string; expiresAt?: string } | null>(null);
  const [createdPasswordReset, setCreatedPasswordReset] = useState<{ username: string; url: string; expiresAt?: string } | null>(null);
  const [bulkUsernames, setBulkUsernames] = useState('');
  const [batchCreatedInvites, setBatchCreatedInvites] = useState<AdminBatchCreateUserResult[]>([]);
  const [batchCreateSummary, setBatchCreateSummary] = useState<AdminBatchSummary | null>(null);
  const [copiedInviteUrl, setCopiedInviteUrl] = useState(false);
  const [copiedPasswordResetUrl, setCopiedPasswordResetUrl] = useState(false);
  const [copiedBatchInviteUrls, setCopiedBatchInviteUrls] = useState(false);
  const [copiedActivationUserId, setCopiedActivationUserId] = useState<number | null>(null);
  const [copiedPasswordResetUserId, setCopiedPasswordResetUserId] = useState<number | null>(null);
  const [copyingActivationUserId, setCopyingActivationUserId] = useState<number | null>(null);
  const [copyingPasswordResetUserId, setCopyingPasswordResetUserId] = useState<number | null>(null);
  const [deletingUserId, setDeletingUserId] = useState<number | null>(null);
  const [deletingMembership, setDeletingMembership] = useState<string | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedBatchTenantIds, setSelectedBatchTenantIds] = useState<string[]>([]);
  const [selectedBatchUserIds, setSelectedBatchUserIds] = useState<string[]>([]);
  const [batchUserSearch, setBatchUserSearch] = useState('');
  const [batchTenantSearch, setBatchTenantSearch] = useState('');
  const [claudeEnvBaseUrl, setClaudeEnvBaseUrl] = useState('');
  const [claudeEnvModel, setClaudeEnvModel] = useState('');
  const [claudeEnvDas, setClaudeEnvDas] = useState('');
  const [claudeEnvUserSearch, setClaudeEnvUserSearch] = useState('');
  const [selectedClaudeEnvUserIds, setSelectedClaudeEnvUserIds] = useState<string[]>([]);
  const [claudeEnvSummary, setClaudeEnvSummary] = useState<AdminBatchSummary | null>(null);
  const [claudeEnvResults, setClaudeEnvResults] = useState<AdminBatchClaudeEnvResult[]>([]);
  const [permission, setPermission] = useState<TenantPermission>('edit');
  const [batchPermission, setBatchPermission] = useState<TenantPermission>('edit');
  const [batchGrantSummary, setBatchGrantSummary] = useState<AdminBatchSummary | null>(null);
  const [batchGrantResults, setBatchGrantResults] = useState<AdminBatchMembershipResult[]>([]);
  const [activeTab, setActiveTab] = useState<'analytics' | 'users' | 'tenants' | 'claudeEnv' | 'mcpPresets' | 'runtimes'>('analytics');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<AdminToast>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const { currentTenant, refreshTenants } = useTenant();
  const { user: currentUser } = useAuth();
  const currentUserId = currentUser?.id == null ? null : Number(currentUser.id);

  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
  }, []);

  useEffect(() => {
    if (!toast) return undefined;

    const timer = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

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
        setError(await readError(tenantResponse, t('errors.loadTenants')));
        return;
      }

      if (!userResponse.ok) {
        setError(await readError(userResponse, t('errors.loadUsers')));
        return;
      }

      if (!membershipResponse.ok) {
        setError(await readError(membershipResponse, t('errors.loadTenantAccess')));
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
      setError(t('errors.loadAdminData'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

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
      setError(t('errors.tenantRequired'));
      return;
    }

    setIsSaving(true);
    try {
      const response = await api.admin.createTenant({ code, name });
      if (!response.ok) {
        setError(await readError(response, t('errors.createTenant')));
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
      setError(t('errors.usernameMinLength'));
      return;
    }

    setIsSaving(true);
    try {
      const response = await api.admin.createUser({ username });
      const payload = await response.json().catch(() => ({} as AdminCreateUserPayload)) as AdminCreateUserPayload;
      if (!response.ok || !payload.invitation?.url) {
        setError(payload.error || payload.message || t('errors.createUserInvite'));
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

  const createUserInvitesBatch = async () => {
    const usernames = parseBatchUsernames(bulkUsernames);

    setError(null);
    setBatchCreatedInvites([]);
    setBatchCreateSummary(null);
    setCopiedBatchInviteUrls(false);
    if (usernames.length === 0) {
      setError(t('errors.batchUsersRequired'));
      return;
    }

    setIsSaving(true);
    try {
      const response = await api.admin.createUsersBatch({ usernames });
      const payload = await response.json().catch(() => ({} as AdminBatchCreateUsersPayload)) as AdminBatchCreateUsersPayload;
      if (!response.ok) {
        setError(payload.error || payload.message || t('errors.batchCreateUserInvites'));
        return;
      }

      const results = payload.results || [];
      const summary = payload.summary || {
        total: results.length,
        succeeded: results.filter((result) => result.success).length,
        failed: results.filter((result) => !result.success).length,
      };

      setBatchCreatedInvites(results);
      setBatchCreateSummary(summary);
      if (summary.succeeded > 0) {
        setBulkUsernames('');
        showToast(t('toast.batchCreateUsersSuccess', {
          succeeded: summary.succeeded,
          failed: summary.failed,
        }), summary.failed > 0 ? 'error' : 'success');
        await load();
      } else {
        showToast(t('errors.batchCreateUserInvites'), 'error');
      }
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

  const copyPasswordResetLink = async () => {
    if (!createdPasswordReset?.url) return;
    const copied = await copyTextToClipboard(createdPasswordReset.url);
    setCopiedPasswordResetUrl(copied);
    if (copied) {
      window.setTimeout(() => setCopiedPasswordResetUrl(false), 1600);
    }
  };

  const copyBatchInviteLinks = async () => {
    const links = batchCreatedInvites
      .filter((result) => result.success && result.invitation?.url)
      .map((result) => `${result.username}: ${result.invitation?.url}`);
    if (links.length === 0) return;

    const copied = await copyTextToClipboard(links.join('\n'));
    setCopiedBatchInviteUrls(copied);
    if (copied) {
      window.setTimeout(() => setCopiedBatchInviteUrls(false), 1600);
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
        setError(payload.error || payload.message || t('errors.createActivationLink'));
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

  const copyPasswordResetLinkForUser = async (targetUser: AdminUser) => {
    setError(null);
    setCopyingPasswordResetUserId(targetUser.id);
    setCopiedPasswordResetUserId(null);
    setCreatedPasswordReset(null);
    setCopiedPasswordResetUrl(false);

    try {
      const response = await api.admin.createUserPasswordResetLink(targetUser.id);
      const payload = await response.json().catch(() => ({} as AdminPasswordResetPayload)) as AdminPasswordResetPayload;
      if (!response.ok || !payload.passwordReset?.url) {
        setError(payload.error || payload.message || t('errors.createPasswordResetLink'));
        return;
      }

      const copied = await copyTextToClipboard(payload.passwordReset.url);
      setCreatedPasswordReset({
        username: payload.user?.username || targetUser.username,
        url: payload.passwordReset.url,
        expiresAt: payload.passwordReset.expires_at,
      });
      setCopiedPasswordResetUrl(copied);

      if (copied) {
        setCopiedPasswordResetUserId(targetUser.id);
        window.setTimeout(() => setCopiedPasswordResetUserId(null), 1600);
      }

      await load();
    } finally {
      setCopyingPasswordResetUserId(null);
    }
  };

  const deleteUser = async (targetUser: AdminUser) => {
    if (targetUser.id === currentUserId) {
      setError(t('errors.deleteOwnUser'));
      return;
    }

    const confirmed = window.confirm(t('confirm.deleteUser', { username: targetUser.username }));
    if (!confirmed) return;

    setError(null);
    setDeletingUserId(targetUser.id);

    try {
      const response = await api.admin.deleteUser(targetUser.id);
      if (!response.ok) {
        setError(await readError(response, t('errors.deleteUser')));
        return;
      }

      if (createdInvite?.username === targetUser.username) {
        setCreatedInvite(null);
      }
      if (createdPasswordReset?.username === targetUser.username) {
        setCreatedPasswordReset(null);
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
      const message = t('errors.selectTenantAndUser');
      setError(message);
      showToast(message, 'error');
      return;
    }

    const selectedTenant = tenants.find((tenant) => tenant.id === tenantId);
    const selectedUser = users.find((user) => user.id === userId);
    setIsSaving(true);
    try {
      const response = await api.admin.upsertTenantUser(
        tenantId,
        userId,
        buildTenantMembershipPayload(permission),
      );

      if (!response.ok) {
        const message = await readError(response, t('errors.grantTenantAccess'));
        setError(message);
        showToast(message, 'error');
        return;
      }

      setSelectedTenantId('');
      setSelectedUserId('');
      setPermission('edit');
      showToast(t('toast.grantTenantAccessSuccess', {
        tenantName: selectedTenant?.name || t('fields.tenant'),
        username: selectedUser?.username || t('fields.user'),
      }), 'success');
      await load();
      await refreshTenants();
    } catch (caughtError) {
      console.error('[AdminPanel] Failed to grant tenant access:', caughtError);
      const message = t('errors.grantTenantAccess');
      setError(message);
      showToast(message, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const grantMembershipsBatch = async () => {
    const tenantIds = selectedBatchTenantIds.map(Number).filter(Boolean);
    const userIds = selectedBatchUserIds.map(Number).filter(Boolean);

    setError(null);
    setBatchGrantSummary(null);
    setBatchGrantResults([]);
    if (tenantIds.length === 0 || userIds.length === 0) {
      const message = t('errors.selectTenantsAndUsers');
      setError(message);
      showToast(message, 'error');
      return;
    }

    setIsSaving(true);
    try {
      const response = await api.admin.upsertTenantUsersBatch({
        tenantIds,
        userIds,
        ...buildTenantMembershipPayload(batchPermission),
      });
      const payload = await response.json().catch(() => ({} as AdminBatchMembershipsPayload)) as AdminBatchMembershipsPayload;
      if (!response.ok) {
        const message = payload.error || payload.message || t('errors.batchGrantTenantAccess');
        setError(message);
        showToast(message, 'error');
        return;
      }

      const results = payload.results || [];
      const summary = payload.summary || {
        total: results.length,
        succeeded: results.filter((result) => result.success).length,
        failed: results.filter((result) => !result.success).length,
      };
      setBatchGrantResults(results);
      setBatchGrantSummary(summary);
      showToast(t('toast.batchGrantTenantAccessSuccess', {
        succeeded: summary.succeeded,
        failed: summary.failed,
      }), summary.failed > 0 ? 'error' : 'success');

      if (summary.succeeded > 0) {
        setSelectedBatchTenantIds([]);
        setSelectedBatchUserIds([]);
        setBatchPermission('edit');
        await load();
        await refreshTenants();
      }
    } catch (caughtError) {
      console.error('[AdminPanel] Failed to batch grant tenant access:', caughtError);
      const message = t('errors.batchGrantTenantAccess');
      setError(message);
      showToast(message, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const updateClaudeEnvBatch = async () => {
    const userIds = selectedClaudeEnvUserIds.map(Number).filter(Boolean);
    const anthropicBaseUrl = claudeEnvBaseUrl.trim();
    const anthropicModel = claudeEnvModel.trim();
    const das = claudeEnvDas.trim();

    setError(null);
    setClaudeEnvSummary(null);
    setClaudeEnvResults([]);
    if (userIds.length === 0) {
      const message = t('errors.selectClaudeEnvUsers');
      setError(message);
      showToast(message, 'error');
      return;
    }
    if (!anthropicBaseUrl && !anthropicModel && !das) {
      const message = t('errors.claudeEnvRequired');
      setError(message);
      showToast(message, 'error');
      return;
    }

    setIsSaving(true);
    try {
      const response = await api.admin.updateClaudeEnvBatch({
        userIds,
        ...(anthropicBaseUrl ? { anthropicBaseUrl } : {}),
        ...(anthropicModel ? { anthropicModel } : {}),
        ...(das ? { das } : {}),
      });
      const payload = await response.json().catch(() => ({} as AdminBatchClaudeEnvPayload)) as AdminBatchClaudeEnvPayload;
      if (!response.ok) {
        const message = payload.error || payload.message || t('errors.batchUpdateClaudeEnv');
        setError(message);
        showToast(message, 'error');
        return;
      }

      const results = payload.results || [];
      const summary = payload.summary || {
        total: results.length,
        succeeded: results.filter((result) => result.success).length,
        failed: results.filter((result) => !result.success).length,
      };
      setClaudeEnvResults(results);
      setClaudeEnvSummary(summary);
      showToast(t('toast.batchUpdateClaudeEnvSuccess', {
        succeeded: summary.succeeded,
        failed: summary.failed,
      }), summary.failed > 0 ? 'error' : 'success');

      if (summary.succeeded > 0) {
        setSelectedClaudeEnvUserIds([]);
      }
    } catch (caughtError) {
      console.error('[AdminPanel] Failed to update Claude environment:', caughtError);
      const message = t('errors.batchUpdateClaudeEnv');
      setError(message);
      showToast(message, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const removeMembership = async (membership: AdminMembership) => {
    const confirmed = window.confirm(t('confirm.removeAccess', {
      username: membership.username,
      tenantName: membership.tenant_name,
    }));
    if (!confirmed) return;

    setError(null);
    setDeletingMembership(membershipKey(membership));

    try {
      const response = await api.admin.deleteTenantUser(membership.tenant_id, membership.user_id);
      if (!response.ok) {
        setError(await readError(response, t('errors.deleteTenantAccess')));
        return;
      }

      await load();
      await refreshTenants();
    } finally {
      setDeletingMembership(null);
    }
  };

  const selectClassName = 'h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
  const checklistClassName = 'h-40 overflow-y-auto rounded-md border border-input bg-background p-2 shadow-sm';
  const collapsibleTriggerClassName = 'group flex w-full items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-left hover:bg-muted/40';
  const filteredBatchUsers = users.filter((user) => matchesQuery(user.username, batchUserSearch));
  const filteredBatchTenants = tenants.filter((tenant) => matchesQuery(`${tenant.name} ${tenant.code}`, batchTenantSearch));
  const filteredClaudeEnvUsers = users.filter((user) => matchesQuery(user.username, claudeEnvUserSearch));
  const renderBatchGrantSection = () => (
    <Collapsible className="space-y-3">
      <CollapsibleTrigger className={collapsibleTriggerClassName}>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{t('batch.grantTitle')}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{t('batch.grantHint')}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <section className="space-y-3 pt-3">
      <div className="grid items-stretch gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px_120px]">
        <div className="grid grid-rows-[16px_40px_160px] gap-2">
          <span className="text-xs leading-4 text-muted-foreground">
            {t('fields.user')} · {selectedBatchUserIds.length}
          </span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              value={batchUserSearch}
              onChange={(event) => setBatchUserSearch(event.target.value)}
              placeholder={t('batch.searchUsers')}
            />
          </div>
          <div className={checklistClassName}>
            {users.length === 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">{t('users.empty')}</div>
            ) : filteredBatchUsers.length === 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">{t('batch.noMatches')}</div>
            ) : (
              filteredBatchUsers.map((user) => (
                <label
                  key={user.id}
                  className="flex min-h-8 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground hover:bg-muted/60"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-input accent-primary"
                    checked={selectedBatchUserIds.includes(String(user.id))}
                    onChange={(event) => setSelectedBatchUserIds((values) => (
                      toggleSelectedId(values, user.id, event.target.checked)
                    ))}
                  />
                  <span className="min-w-0 truncate">{user.username}</span>
                </label>
              ))
            )}
          </div>
        </div>
        <div className="grid grid-rows-[16px_40px_160px] gap-2">
          <span className="text-xs leading-4 text-muted-foreground">
            {t('fields.tenant')} · {selectedBatchTenantIds.length}
          </span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              value={batchTenantSearch}
              onChange={(event) => setBatchTenantSearch(event.target.value)}
              placeholder={t('batch.searchTenants')}
            />
          </div>
          <div className={checklistClassName}>
            {tenants.length === 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">{t('tenants.empty')}</div>
            ) : filteredBatchTenants.length === 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">{t('batch.noMatches')}</div>
            ) : (
              filteredBatchTenants.map((tenant) => (
                <label
                  key={tenant.id}
                  className="flex min-h-8 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground hover:bg-muted/60"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-input accent-primary"
                    checked={selectedBatchTenantIds.includes(String(tenant.id))}
                    onChange={(event) => setSelectedBatchTenantIds((values) => (
                      toggleSelectedId(values, tenant.id, event.target.checked)
                    ))}
                  />
                  <span className="min-w-0 truncate">{tenant.name}</span>
                </label>
              ))
            )}
          </div>
        </div>
        <label className="grid grid-rows-[16px_40px_160px] gap-2">
          <span className="text-xs leading-4 text-muted-foreground">{t('fields.access')}</span>
          <select
            className={selectClassName}
            value={batchPermission}
            onChange={(event) => setBatchPermission(event.target.value as TenantPermission)}
          >
            <option value="edit">{t('permissions.edit')}</option>
            <option value="view">{t('permissions.view')}</option>
          </select>
          <span aria-hidden="true" />
        </label>
        <div className="grid grid-rows-[16px_40px_160px] gap-2">
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <Button className="self-end" onClick={grantMembershipsBatch} disabled={isSaving}>
            {t('batch.grantButton')}
          </Button>
        </div>
      </div>
      {batchGrantSummary ? (
        <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {t('batch.summary', {
            total: batchGrantSummary.total,
            succeeded: batchGrantSummary.succeeded,
            failed: batchGrantSummary.failed,
          })}
        </div>
      ) : null}
      {batchGrantResults.some((result) => !result.success) ? (
        <div className="max-h-24 overflow-auto rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {batchGrantResults.filter((result) => !result.success).map((result) => {
            const tenant = tenants.find((item) => item.id === result.tenantId);
            const user = users.find((item) => item.id === result.userId);
            return (
              <div key={`${result.tenantId}:${result.userId}`}>
                {(user?.username || result.userId)} / {(tenant?.name || result.tenantId)}: {result.error}
              </div>
            );
          })}
        </div>
      ) : null}
        </section>
      </CollapsibleContent>
    </Collapsible>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="relative max-h-[88vh] max-w-6xl overflow-hidden p-0">
        <DialogTitle>{t('title')}</DialogTitle>
        {toast ? (
          <div
            className={`animate-in slide-in-from-bottom-2 pointer-events-none absolute bottom-4 right-4 z-20 flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-white shadow-lg ${
              toast.type === 'success' ? 'bg-emerald-600' : 'bg-destructive'
            }`}
            role="status"
            aria-live="polite"
          >
            {toast.type === 'success' ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
            <span>{toast.message}</span>
          </div>
        ) : null}
        <div className="flex max-h-[88vh] flex-col">
          <div className="flex items-center gap-3 border-b border-border px-5 py-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Shield className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
              <p className="truncate text-xs text-muted-foreground">{t('subtitle')}</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-1 border-b border-border px-5 py-2">
            <Button
              variant={activeTab === 'analytics' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setActiveTab('analytics')}
            >
              {t('tabs.analytics')}
            </Button>
            <Button
              variant={activeTab === 'users' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setActiveTab('users')}
            >
              {t('tabs.users')}
            </Button>
            <Button
              variant={activeTab === 'tenants' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setActiveTab('tenants')}
            >
              {t('tabs.tenants')}
            </Button>
            <Button
              variant={activeTab === 'claudeEnv' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setActiveTab('claudeEnv')}
            >
              {t('tabs.claudeEnv')}
            </Button>
            <Button
              variant={activeTab === 'mcpPresets' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setActiveTab('mcpPresets')}
            >
              {t('tabs.mcpPresets')}
            </Button>
            <Button
              variant={activeTab === 'runtimes' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setActiveTab('runtimes')}
            >
              {t('tabs.runtimes')}
            </Button>
          </div>

          {activeTab === 'analytics' ? (
            <div className="overflow-y-auto px-5 py-4">
              <PlatformAnalyticsTab />
            </div>
          ) : null}

          {activeTab === 'users' ? (
            <div className="space-y-5 overflow-y-auto px-5 py-4">
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">{t('users.createTitle')}</h3>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">{t('fields.username')}</span>
                    <Input
                      value={newUsername}
                      onChange={(event) => setNewUsername(event.target.value)}
                      placeholder={t('users.usernamePlaceholder')}
                      autoCapitalize="none"
                      autoComplete="off"
                    />
                  </label>
                  <Button className="self-end" onClick={createUserInvite} disabled={isSaving}>
                    <UserPlus className="h-4 w-4" />
                    {t('users.createInvite')}
                  </Button>
                </div>
              </section>

              <Collapsible className="space-y-3">
                <CollapsibleTrigger className={collapsibleTriggerClassName}>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">{t('batch.createUsersTitle')}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">{t('batch.createUsersHint')}</span>
                  </span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <section className="space-y-3 pt-3">
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                      <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">{t('batch.usernames')}</span>
                        <textarea
                          className="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          value={bulkUsernames}
                          onChange={(event) => setBulkUsernames(event.target.value)}
                          placeholder={t('batch.usernamesPlaceholder')}
                          autoCapitalize="none"
                          autoComplete="off"
                        />
                      </label>
                      <Button className="self-end" onClick={createUserInvitesBatch} disabled={isSaving}>
                        <UserPlus className="h-4 w-4" />
                        {t('batch.createUsersButton')}
                      </Button>
                    </div>
                  </section>
                </CollapsibleContent>
              </Collapsible>

              {batchCreateSummary ? (
                <section className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-medium text-foreground">{t('batch.createUsersResult')}</h3>
                      <p className="text-xs text-muted-foreground">
                        {t('batch.summary', {
                          total: batchCreateSummary.total,
                          succeeded: batchCreateSummary.succeeded,
                          failed: batchCreateSummary.failed,
                        })}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void copyBatchInviteLinks()}
                      disabled={!batchCreatedInvites.some((result) => result.success && result.invitation?.url)}
                    >
                      {copiedBatchInviteUrls ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      {copiedBatchInviteUrls ? t('common.copied') : t('batch.copyInviteLinks')}
                    </Button>
                  </div>
                  <div className="max-h-36 overflow-auto rounded-md border border-border bg-background">
                    {batchCreatedInvites.map((result) => (
                      <div
                        key={result.username}
                        className="grid gap-2 border-b border-border px-3 py-2 text-xs last:border-b-0 sm:grid-cols-[140px_minmax(0,1fr)]"
                      >
                        <span className={result.success ? 'font-medium text-foreground' : 'font-medium text-destructive'}>
                          {result.username}
                        </span>
                        {result.success && result.invitation?.url ? (
                          <span className="truncate font-mono text-muted-foreground">{result.invitation.url}</span>
                        ) : (
                          <span className="text-destructive">{result.error || t('errors.batchCreateUserInvites')}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {createdInvite ? (
                <section className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-medium text-foreground">{t('users.invitationLink')}</h3>
                      <p className="text-xs text-muted-foreground">
                        {createdInvite.username}
                        {createdInvite.expiresAt
                          ? ` · ${t('users.expires', { time: formatDateTime(createdInvite.expiresAt, t('common.never')) })}`
                          : ''}
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void copyInviteLink()}>
                      {copiedInviteUrl ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      {copiedInviteUrl ? t('common.copied') : t('common.copy')}
                    </Button>
                  </div>
                  <Input value={createdInvite.url} readOnly className="font-mono text-xs" />
                </section>
              ) : null}

              {createdPasswordReset ? (
                <section className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-medium text-foreground">{t('users.passwordResetLinkTitle')}</h3>
                      <p className="text-xs text-muted-foreground">
                        {createdPasswordReset.username}
                        {createdPasswordReset.expiresAt
                          ? ` - ${t('users.expires', { time: formatDateTime(createdPasswordReset.expiresAt, t('common.never')) })}`
                          : ''}
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void copyPasswordResetLink()}>
                      {copiedPasswordResetUrl ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      {copiedPasswordResetUrl ? t('common.copied') : t('common.copy')}
                    </Button>
                  </div>
                  <Input value={createdPasswordReset.url} readOnly className="font-mono text-xs" />
                </section>
              ) : null}

              <section className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">{t('users.grantAccessTitle')}</h3>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_auto]">
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">{t('fields.user')}</span>
                    <select
                      className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={selectedUserId}
                      onChange={(event) => setSelectedUserId(event.target.value)}
                    >
                      <option value="">{t('common.select')}</option>
                      {users.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.username}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">{t('fields.tenant')}</span>
                    <select
                      className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={selectedTenantId}
                      onChange={(event) => setSelectedTenantId(event.target.value)}
                    >
                      <option value="">{t('common.select')}</option>
                      {tenants.map((tenant) => (
                        <option key={tenant.id} value={tenant.id}>
                          {tenant.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs leading-4 text-muted-foreground">{t('fields.access')}</span>
                    <select
                      className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={permission}
                      onChange={(event) => setPermission(event.target.value as TenantPermission)}
                    >
                      <option value="edit">{t('permissions.edit')}</option>
                      <option value="view">{t('permissions.view')}</option>
                    </select>
                  </label>
                  <Button className="self-end" onClick={grantMembership} disabled={isSaving}>
                    {t('common.grant')}
                  </Button>
                </div>
              </section>

              {renderBatchGrantSection()}

              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium text-foreground">{t('users.listTitle')}</h3>
                  <Button variant="ghost" size="icon" onClick={() => void load()} disabled={isLoading}>
                    <RefreshCw className={isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                  </Button>
                </div>
                <div className="max-h-72 overflow-auto rounded-md border border-border">
                  {users.length === 0 ? (
                    <div className="px-3 py-4 text-sm text-muted-foreground">{t('users.empty')}</div>
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
                                {t('common.admin')}
                              </span>
                            ) : null}
                            <span className={`rounded px-2 py-0.5 text-xs ${getUserStatusClassName(user)}`}>
                              {t(`statuses.${getUserStatusKey(user)}`)}
                            </span>
                          </div>
                          <div className="mt-1 truncate text-xs text-muted-foreground">
                            {t('users.lastLogin', { time: formatDateTime(user.last_login, t('common.never')) })}
                            {' · '}
                            {user.invitation_status === 'invited' && user.invitation_expires_at
                              ? t('users.inviteExpires', { time: formatDateTime(user.invitation_expires_at, t('common.never')) })
                              : t('users.created', { time: formatDateTime(user.created_at, t('common.never')) })}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {memberships.filter((membership) => membership.user_id === user.id).length === 0 ? (
                              <span className="text-xs text-muted-foreground">{t('users.noTenantAccess')}</span>
                            ) : (
                              memberships
                                .filter((membership) => membership.user_id === user.id)
                                .map((membership) => (
                                  <span
                                    key={membershipKey(membership)}
                                    className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                                  >
                                    {membership.tenant_name} · {translatePermission(t, membership.permission)}
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
                              {copiedActivationUserId === user.id ? t('common.copied') : t('users.activationLink')}
                            </Button>
                          ) : null}
                          {user.is_active === 1 ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void copyPasswordResetLinkForUser(user)}
                              disabled={copyingPasswordResetUserId === user.id}
                            >
                              {copiedPasswordResetUserId === user.id ? <Check className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
                              {copiedPasswordResetUserId === user.id ? t('common.copied') : t('users.passwordResetLink')}
                            </Button>
                          ) : null}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void deleteUser(user)}
                            disabled={deletingUserId === user.id || user.id === currentUserId}
                          >
                            <Trash2 className="h-4 w-4" />
                            {t('common.delete')}
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

          {activeTab === 'claudeEnv' ? (
            <div className="space-y-5 overflow-y-auto px-5 py-4">
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">{t('claudeEnv.title')}</h3>
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,280px)]">
                  <div className="grid gap-3 md:grid-cols-3">
                    <label className="space-y-1">
                      <span className="text-xs text-muted-foreground">{t('claudeEnv.baseUrl')}</span>
                      <Input
                        value={claudeEnvBaseUrl}
                        onChange={(event) => setClaudeEnvBaseUrl(event.target.value)}
                        placeholder={t('claudeEnv.baseUrlPlaceholder')}
                        autoCapitalize="none"
                        autoComplete="off"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs text-muted-foreground">{t('claudeEnv.model')}</span>
                      <Input
                        value={claudeEnvModel}
                        onChange={(event) => setClaudeEnvModel(event.target.value)}
                        placeholder={t('claudeEnv.modelPlaceholder')}
                        autoCapitalize="none"
                        autoComplete="off"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs text-muted-foreground">{t('claudeEnv.das')}</span>
                      <Input
                        value={claudeEnvDas}
                        onChange={(event) => setClaudeEnvDas(event.target.value)}
                        placeholder={t('claudeEnv.dasPlaceholder')}
                        autoCapitalize="none"
                        autoComplete="off"
                      />
                    </label>
                  </div>
                  <Button className="self-end" onClick={updateClaudeEnvBatch} disabled={isSaving}>
                    <Check className="h-4 w-4" />
                    {t('claudeEnv.saveButton')}
                  </Button>
                </div>
              </section>

              <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium text-foreground">
                    {t('claudeEnv.usersTitle', { count: selectedClaudeEnvUserIds.length })}
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedClaudeEnvUserIds(users.map((user) => String(user.id)))}
                      disabled={users.length === 0}
                    >
                      {t('claudeEnv.selectAll')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedClaudeEnvUserIds([])}
                      disabled={selectedClaudeEnvUserIds.length === 0}
                    >
                      {t('claudeEnv.clearSelection')}
                    </Button>
                  </div>
                </div>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    value={claudeEnvUserSearch}
                    onChange={(event) => setClaudeEnvUserSearch(event.target.value)}
                    placeholder={t('batch.searchUsers')}
                  />
                </div>
                <div className="max-h-72 overflow-y-auto rounded-md border border-input bg-background p-2 shadow-sm">
                  {users.length === 0 ? (
                    <div className="px-2 py-3 text-sm text-muted-foreground">{t('users.empty')}</div>
                  ) : filteredClaudeEnvUsers.length === 0 ? (
                    <div className="px-2 py-3 text-sm text-muted-foreground">{t('batch.noMatches')}</div>
                  ) : (
                    filteredClaudeEnvUsers.map((user) => (
                      <label
                        key={user.id}
                        className="flex min-h-8 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground hover:bg-muted/60"
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-input accent-primary"
                          checked={selectedClaudeEnvUserIds.includes(String(user.id))}
                          onChange={(event) => setSelectedClaudeEnvUserIds((values) => (
                            toggleSelectedId(values, user.id, event.target.checked)
                          ))}
                        />
                        <span className="min-w-0 truncate">{user.username}</span>
                        <span className={`ml-auto rounded px-2 py-0.5 text-xs ${getUserStatusClassName(user)}`}>
                          {t(`statuses.${getUserStatusKey(user)}`)}
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </section>

              {claudeEnvSummary ? (
                <section className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  {t('batch.summary', {
                    total: claudeEnvSummary.total,
                    succeeded: claudeEnvSummary.succeeded,
                    failed: claudeEnvSummary.failed,
                  })}
                </section>
              ) : null}
              {claudeEnvResults.some((result) => !result.success) ? (
                <section className="max-h-24 overflow-auto rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {claudeEnvResults.filter((result) => !result.success).map((result) => (
                    <div key={result.userId}>
                      {(result.username || result.userId)}: {result.error}
                    </div>
                  ))}
                </section>
              ) : null}

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
                <h3 className="text-sm font-medium text-foreground">{t('tenants.createTitle')}</h3>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">{t('fields.code')}</span>
                    <Input
                      value={tenantCode}
                      onChange={(event) => setTenantCode(normalizeTenantCode(event.target.value))}
                      placeholder={t('tenants.codePlaceholder')}
                      autoCapitalize="none"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">{t('fields.name')}</span>
                    <Input
                      value={tenantName}
                      onChange={(event) => setTenantName(event.target.value)}
                      placeholder={t('tenants.namePlaceholder')}
                    />
                  </label>
                  <Button className="self-end" onClick={createTenant} disabled={isSaving}>
                    <Plus className="h-4 w-4" />
                    {t('common.create')}
                  </Button>
                </div>
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">{t('tenants.grantAccessTitle')}</h3>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_auto]">
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">{t('fields.tenant')}</span>
                    <select
                      className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={selectedTenantId}
                      onChange={(event) => setSelectedTenantId(event.target.value)}
                    >
                      <option value="">{t('common.select')}</option>
                      {tenants.map((tenant) => (
                        <option key={tenant.id} value={tenant.id}>
                          {tenant.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">{t('fields.user')}</span>
                    <select
                      className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={selectedUserId}
                      onChange={(event) => setSelectedUserId(event.target.value)}
                    >
                      <option value="">{t('common.select')}</option>
                      {users.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.username}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs leading-4 text-muted-foreground">{t('fields.access')}</span>
                    <select
                      className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={permission}
                      onChange={(event) => setPermission(event.target.value as TenantPermission)}
                    >
                      <option value="edit">{t('permissions.edit')}</option>
                      <option value="view">{t('permissions.view')}</option>
                    </select>
                  </label>
                  <Button className="self-end" onClick={grantMembership} disabled={isSaving}>
                    {t('common.grant')}
                  </Button>
                </div>
              </section>

              {renderBatchGrantSection()}

              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium text-foreground">{t('tenants.accessTitle')}</h3>
                  <Button variant="ghost" size="icon" onClick={() => void load()} disabled={isLoading}>
                    <RefreshCw className={isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                  </Button>
                </div>
                <div className="max-h-72 overflow-auto rounded-md border border-border">
                  {tenants.length === 0 ? (
                    <div className="px-3 py-4 text-sm text-muted-foreground">{t('tenants.empty')}</div>
                  ) : (
                    tenants.map((tenant) => {
                      const tenantMemberships = memberships.filter((membership) => membership.tenant_id === tenant.id);
                      return (
                        <div key={tenant.id} className="border-b border-border px-3 py-3 text-sm last:border-b-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-foreground">{tenant.name}</span>
                            <span className="text-xs text-muted-foreground">{tenant.code}</span>
                            <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{translateStatus(t, tenant.status)}</span>
                          </div>
                          <div className="mt-3 space-y-2">
                            {tenantMemberships.length === 0 ? (
                              <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                                {t('tenants.noAuthorizedUsers')}
                              </div>
                            ) : (
                              tenantMemberships.map((membership) => (
                                <div
                                  key={membershipKey(membership)}
                                  className="grid gap-2 rounded-md bg-muted/30 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]"
                                >
                                  <span className="min-w-0 truncate text-foreground">{membership.username}</span>
                                  <span className="self-center rounded bg-background px-2 py-0.5 text-xs text-muted-foreground">
                                    {translatePermission(t, membership.permission)}
                                  </span>
                                  <span className="self-center rounded bg-background px-2 py-0.5 text-xs text-muted-foreground">
                                    {translateStatus(t, membership.status)}
                                  </span>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => void removeMembership(membership)}
                                    disabled={deletingMembership === membershipKey(membership)}
                                  >
                                    <UserMinus className="h-4 w-4" />
                                    {t('common.remove')}
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
                <h3 className="text-sm font-medium text-foreground">{t('tenants.listTitle')}</h3>
                <div className="max-h-48 overflow-auto rounded-md border border-border">
                  {tenants.length === 0 ? (
                    <div className="px-3 py-4 text-sm text-muted-foreground">{t('tenants.empty')}</div>
                  ) : (
                    tenants.map((tenant) => (
                      <div
                        key={tenant.id}
                        className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0"
                      >
                        <span className="truncate font-medium text-foreground">{tenant.name}</span>
                        <span className="truncate text-muted-foreground">{tenant.code}</span>
                        <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{translateStatus(t, tenant.status)}</span>
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
