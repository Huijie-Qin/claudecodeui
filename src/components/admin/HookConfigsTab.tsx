import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BookOpen,
  Building2,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Database,
  FileText,
  Globe2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  UsersRound,
  Webhook,
  Wrench,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import { Badge, Button, Card, Dialog, DialogContent, DialogTitle, Input } from '../../shared/view/ui';
import { api } from '../../utils/api';

import HookConfigEditor from './hook-config/HookConfigEditor';
import HookDiagnosticsPanel from './hook-config/HookDiagnosticsPanel';
import {
  EVENT_DEFINITIONS,
  EVENT_GROUPS,
  createEmptyHook,
  shouldShowBusinessData,
} from './hook-config/catalog';
import { findUnavailableHookSkills } from './hook-config/skillAvailability';
import type {
  HookConfig,
  HookConfigDraft,
  HookEventName,
  HookResources,
} from './hook-config/types';

const EMPTY_RESOURCES: HookResources = {
  events: [],
  builtinTools: [],
  mcpTools: [],
  skills: [],
  environmentVariables: [],
};

const DIRECTORY_INPUT_ATTRIBUTES = {
  webkitdirectory: '',
  directory: '',
};

type Toast = { type: 'success' | 'error'; message: string } | null;

type HookDataRecord = {
  id: string;
  executionId: string;
  sessionId: string | null;
  type: string;
  data: unknown;
  createdAt: string;
};

type HookBindingUser = {
  id: number;
  username: string;
  isActive: boolean;
  isSystemAdmin: boolean;
  bound: boolean;
};

type HookBindingTenant = {
  id: number;
  code: string;
  name: string;
  active: boolean;
  activeUserCount: number;
  bound: boolean;
};

type HookBindingScope = 'users' | 'tenants' | 'all_users';

type HookExampleCatalogItem = {
  id: string;
  name: string;
  description: string;
  eventName: HookEventName;
  exists: boolean;
};

async function readError(response: Response, fallback: string) {
  try {
    const data = await response.json() as { error?: string };
    return data.error || fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string | null | undefined, language: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(language, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function statusVariant(status: HookConfig['status']) {
  if (status === 'published') return 'default' as const;
  return status === 'disabled' ? 'outline' as const : 'secondary' as const;
}

function normalizeHookConfig(hook: HookConfig): HookConfig {
  return {
    ...hook,
    boundUserCount: Number(hook.boundUserCount || 0),
    boundTenantCount: Number(hook.boundTenantCount || 0),
    hasDataRecords: Boolean(hook.hasDataRecords),
    bindingController: hook.bindingController === 'sql_check' ? 'sql_check' : 'admin',
    extensionLogic: hook.extensionLogic
      ? { ...hook.extensionLogic, outputs: hook.extensionLogic.outputs || [] }
      : null,
    postActions: Array.isArray(hook.postActions) ? hook.postActions : [],
    claudeResponse: hook.claudeResponse?.bindings
      ? hook.claudeResponse
      : { bindings: {} },
  };
}

function HookExamplesDialog({
  open,
  examples,
  selectedIds,
  loading,
  saving,
  error,
  onClose,
  onToggle,
  onCreate,
}: {
  open: boolean;
  examples: HookExampleCatalogItem[];
  selectedIds: string[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onToggle: (exampleId: string) => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation('admin');
  const selected = new Set(selectedIds);
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !saving) onClose(); }}>
      <DialogContent className="max-h-[86vh] max-w-2xl overflow-hidden">
        <DialogTitle className="sr-only">{t('hooks.examples.dialogTitle')}</DialogTitle>
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <BookOpen className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-foreground">{t('hooks.examples.dialogTitle')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('hooks.examples.dialogDescription')}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} disabled={saving} aria-label={t('hooks.close')}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="max-h-[calc(86vh-138px)] overflow-y-auto p-4 sm:p-5">
          {loading ? (
            <div className="flex min-h-44 items-center justify-center gap-2 text-sm text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              {t('hooks.examples.loading')}
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>
          ) : (
            <div className="space-y-2">
              {examples.map((example) => {
                const checked = selected.has(example.id);
                return (
                  <button
                    key={example.id}
                    type="button"
                    disabled={example.exists || saving}
                    onClick={() => onToggle(example.id)}
                    className={cn(
                      'flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors',
                      checked ? 'border-primary/50 bg-primary/5' : 'border-border hover:bg-muted/30',
                      example.exists && 'cursor-not-allowed bg-muted/20 opacity-65',
                    )}
                  >
                    <span className={cn(
                      'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]',
                      checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                    )}>{checked ? '✓' : ''}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{example.name}</span>
                        <Badge variant="outline">{t(`hooks.events.${example.eventName}.label`)}</Badge>
                        {example.exists ? <Badge variant="secondary">{t('hooks.examples.exists')}</Badge> : null}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">{example.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border bg-muted/10 px-5 py-3">
          <span className="mr-auto text-xs text-muted-foreground">
            {t('hooks.examples.selectedCount', { count: selectedIds.length })}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>
            {t('hooks.cancel')}
          </Button>
          <Button type="button" size="sm" onClick={onCreate} disabled={loading || saving || selectedIds.length === 0}>
            {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            {t('hooks.examples.createSelected')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MoreEventsDialog({
  open,
  selectedEvents,
  busy,
  onOpenChange,
  onToggle,
  onSave,
}: {
  open: boolean;
  selectedEvents: HookEventName[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: (eventName: HookEventName) => void;
  onSave: () => void;
}) {
  const { t } = useTranslation('admin');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-3xl overflow-hidden">
        <DialogTitle>{t('hooks.moreEvents')}</DialogTitle>
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <h3 className="min-w-0 flex-1 text-sm font-semibold text-foreground">{t('hooks.moreEvents')}</h3>
          <Button type="button" variant="ghost" size="icon" onClick={() => onOpenChange(false)} aria-label={t('hooks.close')}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="max-h-[calc(86vh-132px)] overflow-y-auto p-4 sm:p-5">
          <div className="space-y-5">
            {EVENT_GROUPS.map((group) => {
              const events = EVENT_DEFINITIONS.filter((event) => event.group === group);
              return (
                <section key={group}>
                  <h4 className="mb-2 text-xs font-semibold text-muted-foreground">{t(`hooks.eventGroups.${group}`)}</h4>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {events.map((event) => {
                      const selected = selectedEvents.includes(event.name);
                      return (
                        <button
                          key={event.name}
                          type="button"
                          onClick={() => onToggle(event.name)}
                          className={cn(
                            'flex items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors',
                            selected ? 'border-primary/50 bg-primary/5' : 'border-border hover:bg-muted/30',
                          )}
                        >
                          <span className={cn(
                            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]',
                            selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                          )}>{selected ? '✓' : ''}</span>
                          <span className="min-w-0">
                            <span className="block text-xs font-medium text-foreground">{t(`hooks.events.${event.name}.label`)}</span>
                            <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{t(`hooks.events.${event.name}.description`)}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t('hooks.cancel')}</Button>
          <Button type="button" size="sm" disabled={busy || !selectedEvents.length} onClick={onSave}>
            {t('hooks.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HookUserBindingsDialog({
  hook,
  scope,
  users,
  tenants,
  selectedUserIds,
  selectedTenantIds,
  loading,
  saving,
  error,
  onClose,
  onScopeChange,
  onToggle,
  onToggleTenant,
  onClear,
  onSave,
}: {
  hook: HookConfig | null;
  scope: HookBindingScope;
  users: HookBindingUser[];
  tenants: HookBindingTenant[];
  selectedUserIds: number[];
  selectedTenantIds: number[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onScopeChange: (scope: HookBindingScope) => void;
  onToggle: (userId: number) => void;
  onToggleTenant: (tenantId: number) => void;
  onClear: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation('admin');
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (hook) setQuery('');
  }, [hook?.id]);

  const selectedUsers = useMemo(() => new Set(selectedUserIds), [selectedUserIds]);
  const selectedTenants = useMemo(() => new Set(selectedTenantIds), [selectedTenantIds]);
  const filteredUsers = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return users;
    return users.filter((user) => user.username.toLowerCase().includes(normalizedQuery));
  }, [query, users]);
  const filteredTenants = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return tenants;
    return tenants.filter((tenant) => (
      tenant.name.toLowerCase().includes(normalizedQuery)
      || tenant.code.toLowerCase().includes(normalizedQuery)
    ));
  }, [query, tenants]);
  const activeUserCount = users.filter((user) => user.isActive).length;
  const selectionCount = scope === 'users'
    ? selectedUserIds.length
    : scope === 'tenants'
      ? selectedTenantIds.length
      : activeUserCount;
  const scopeOptions: Array<{ value: HookBindingScope; icon: typeof UsersRound }> = [
    { value: 'users', icon: UsersRound },
    { value: 'tenants', icon: Building2 },
    { value: 'all_users', icon: Globe2 },
  ];

  return (
    <Dialog open={Boolean(hook)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[86vh] max-w-xl overflow-hidden p-0">
        <DialogTitle className="sr-only">{t('hooks.bindings.title')}</DialogTitle>
        <div className="border-b border-border bg-gradient-to-br from-primary/10 via-background to-background px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
              <UsersRound className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-foreground">{t('hooks.bindings.title')}</h3>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{hook?.name}</p>
            </div>
            <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label={t('hooks.close')}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-primary/15 bg-background/75 px-3 py-2 text-[11px] leading-4 text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span>{t(`hooks.bindings.scopeHints.${scope}`)}</span>
          </div>
        </div>

        <div className="space-y-3 p-4 sm:p-5">
          <div className="grid grid-cols-3 gap-2 rounded-xl bg-muted/60 p-1.5">
            {scopeOptions.map((option) => {
              const Icon = option.icon;
              const active = scope === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setQuery('');
                    onScopeChange(option.value);
                  }}
                  className={cn(
                    'flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-2 text-[11px] font-medium transition-all',
                    active
                      ? 'bg-background text-primary shadow-sm ring-1 ring-border'
                      : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {t(`hooks.bindings.scopes.${option.value}`)}
                </button>
              );
            })}
          </div>

          {error ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>
          ) : null}

          {scope !== 'all_users' ? (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t(scope === 'users' ? 'hooks.bindings.search' : 'hooks.bindings.searchTenant')}
                className="h-10 rounded-xl pl-9"
              />
            </div>
          ) : null}

          <div className="max-h-[36vh] min-h-48 overflow-y-auto rounded-xl border border-border bg-muted/10 p-1.5">
            {loading ? (
              <div className="flex min-h-44 items-center justify-center gap-2 text-sm text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin" />
                {t('hooks.bindings.loading')}
              </div>
            ) : scope === 'all_users' ? (
              <div className="flex min-h-44 flex-col items-center justify-center px-6 text-center">
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Globe2 className="h-7 w-7" />
                </span>
                <h4 className="mt-3 text-sm font-semibold text-foreground">{t('hooks.bindings.allUsersTitle')}</h4>
                <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                  {t('hooks.bindings.allUsersDescription', { count: activeUserCount })}
                </p>
              </div>
            ) : scope === 'users' && filteredUsers.length === 0 ? (
              <div className="flex min-h-44 items-center justify-center text-sm text-muted-foreground">
                {query ? t('hooks.bindings.noMatches') : t('hooks.bindings.noUsers')}
              </div>
            ) : scope === 'tenants' && filteredTenants.length === 0 ? (
              <div className="flex min-h-44 items-center justify-center text-sm text-muted-foreground">
                {query ? t('hooks.bindings.noMatches') : t('hooks.bindings.noTenants')}
              </div>
            ) : scope === 'users' ? filteredUsers.map((user) => {
              const checked = selectedUsers.has(user.id);
              const cannotAdd = !user.isActive && !checked;
              return (
                <label
                  key={user.id}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors',
                    checked ? 'bg-primary/8' : 'hover:bg-muted/50',
                    cannotAdd && 'cursor-not-allowed opacity-55',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={cannotAdd}
                    onChange={() => onToggle(user.id)}
                    className="h-4 w-4 rounded border-input accent-primary"
                  />
                  <span className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold uppercase',
                    checked ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                  )}>
                    {user.username.slice(0, 1) || '?'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{user.username}</span>
                    <span className="block text-[10px] text-muted-foreground">ID {user.id}</span>
                  </span>
                  {user.isSystemAdmin ? <Badge variant="outline">{t('hooks.bindings.admin')}</Badge> : null}
                  {!user.isActive ? <Badge variant="secondary">{t('hooks.bindings.inactive')}</Badge> : null}
                </label>
              );
            }) : filteredTenants.map((tenant) => {
              const checked = selectedTenants.has(tenant.id);
              const cannotAdd = !tenant.active && !checked;
              return (
                <label
                  key={tenant.id}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors',
                    checked ? 'bg-primary/10' : 'hover:bg-muted/50',
                    cannotAdd && 'cursor-not-allowed opacity-55',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={cannotAdd}
                    onChange={() => onToggleTenant(tenant.id)}
                    className="h-4 w-4 rounded border-input accent-primary"
                  />
                  <span className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                    checked ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                  )}>
                    <Building2 className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{tenant.name}</span>
                    <span className="block text-[10px] text-muted-foreground">{tenant.code}</span>
                  </span>
                  <Badge variant="outline">{t('hooks.bindings.tenantUsers', { count: tenant.activeUserCount })}</Badge>
                  {!tenant.active ? <Badge variant="secondary">{t('hooks.bindings.inactive')}</Badge> : null}
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/10 px-5 py-3">
          <span className="mr-auto text-xs text-muted-foreground">
            {t(`hooks.bindings.selectionSummary.${scope}`, { count: selectionCount })}
          </span>
          {scope !== 'all_users' && selectionCount > 0 ? (
            <Button type="button" variant="ghost" size="sm" onClick={onClear} disabled={saving}>
              {t('hooks.bindings.clear')}
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>
            {t('hooks.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onSave}
            disabled={loading || saving || (scope === 'tenants' && selectedTenantIds.length === 0)}
          >
            {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            {t('hooks.bindings.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HookDataRecordsDialog({
  hook,
  records,
  loading,
  error,
  onClose,
  onRefresh,
}: {
  hook: HookConfig | null;
  records: HookDataRecord[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const { t, i18n } = useTranslation('admin');
  return (
    <Dialog open={Boolean(hook)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[86vh] max-w-4xl overflow-hidden">
        <DialogTitle>{t('hooks.businessData.title')}</DialogTitle>
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-foreground">{hook?.name || t('hooks.businessData.title')}</h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {t('hooks.businessData.description')} <code>hook_data_records</code>
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={loading} onClick={onRefresh}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            {t('common.refresh')}
          </Button>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label={t('hooks.businessData.close')}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="max-h-[calc(86vh-90px)] overflow-y-auto p-4 sm:p-5">
          {error ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">{error}</div>
          ) : loading && !records.length ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              {t('hooks.businessData.loading')}
            </div>
          ) : !records.length ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
              {t('hooks.businessData.empty')}
            </div>
          ) : (
            <div className="space-y-3">
              {records.map((record) => (
                <article key={record.id} className="overflow-hidden rounded-xl border border-border bg-background">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
                    <Badge variant="outline">{record.type}</Badge>
                    <span>{formatDate(record.createdAt, i18n.language)}</span>
                    {record.sessionId ? <code className="truncate">session: {record.sessionId}</code> : null}
                    <code className="ml-auto truncate">{record.id}</code>
                  </div>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 text-xs leading-5 text-foreground">
                    {JSON.stringify(record.data, null, 2)}
                  </pre>
                </article>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function HookConfigsTab() {
  const { t, i18n } = useTranslation('admin');
  const [hooks, setHooks] = useState<HookConfig[]>([]);
  const [resources, setResources] = useState<HookResources>(EMPTY_RESOURCES);
  const [visibleEvents, setVisibleEvents] = useState<HookEventName[]>([]);
  const [visibleEventDraft, setVisibleEventDraft] = useState<HookEventName[]>([]);
  const [editor, setEditor] = useState<HookConfigDraft | HookConfig | null>(null);
  const [search, setSearch] = useState('');
  const [skillSearch, setSkillSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [skillUploadBusy, setSkillUploadBusy] = useState(false);
  const [skillDeleteBusyId, setSkillDeleteBusyId] = useState<string | null>(null);
  const [expandedSkillIds, setExpandedSkillIds] = useState<string[]>([]);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [exampleCatalog, setExampleCatalog] = useState<HookExampleCatalogItem[]>([]);
  const [selectedExampleIds, setSelectedExampleIds] = useState<string[]>([]);
  const [examplesLoading, setExamplesLoading] = useState(false);
  const [examplesError, setExamplesError] = useState<string | null>(null);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [recordsHook, setRecordsHook] = useState<HookConfig | null>(null);
  const [dataRecords, setDataRecords] = useState<HookDataRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [diagnosticsHook, setDiagnosticsHook] = useState<HookConfig | null>(null);
  const [activeView, setActiveView] = useState<'configs' | 'diagnostics'>('configs');
  const [bindingsHook, setBindingsHook] = useState<HookConfig | null>(null);
  const [bindingScope, setBindingScope] = useState<HookBindingScope>('users');
  const [bindingUsers, setBindingUsers] = useState<HookBindingUser[]>([]);
  const [bindingTenants, setBindingTenants] = useState<HookBindingTenant[]>([]);
  const [selectedBindingUserIds, setSelectedBindingUserIds] = useState<number[]>([]);
  const [selectedBindingTenantIds, setSelectedBindingTenantIds] = useState<number[]>([]);
  const [bindingsLoading, setBindingsLoading] = useState(false);
  const [bindingsSaving, setBindingsSaving] = useState(false);
  const [bindingsError, setBindingsError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [error, setError] = useState<string | null>(null);

  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [hooksResponse, settingsResponse, resourcesResponse] = await Promise.all([
        api.admin.hooks(),
        api.admin.hookSettings(),
        api.admin.hookResources(),
      ]);
      if (!hooksResponse.ok) throw new Error(await readError(hooksResponse, t('hooks.errors.load')));
      if (!settingsResponse.ok) throw new Error(await readError(settingsResponse, t('hooks.errors.loadSettings')));
      if (!resourcesResponse.ok) throw new Error(await readError(resourcesResponse, t('hooks.errors.loadResources')));

      const hooksPayload = await hooksResponse.json() as { hooks?: HookConfig[] };
      const settingsPayload = await settingsResponse.json() as { visibleEvents?: HookEventName[] };
      const resourcesPayload = await resourcesResponse.json() as HookResources;
      const nextVisibleEvents: HookEventName[] = settingsPayload.visibleEvents?.length
        ? settingsPayload.visibleEvents
        : ['Stop', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'];
      setHooks((hooksPayload.hooks || []).map(normalizeHookConfig));
      setVisibleEvents(nextVisibleEvents);
      setVisibleEventDraft(nextVisibleEvents);
      setResources(resourcesPayload);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : t('hooks.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredHooks = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return hooks;
    return hooks.filter((hook) => (
      hook.name.toLowerCase().includes(query)
      || hook.description.toLowerCase().includes(query)
      || t(`hooks.events.${hook.eventName}.label`).toLowerCase().includes(query)
    ));
  }, [hooks, search, t]);

  const filteredSkills = useMemo(() => {
    const query = skillSearch.trim().toLowerCase();
    if (!query) return resources.skills;
    return resources.skills.filter((skill) => (
      skill.name.toLowerCase().includes(query)
      || skill.displayName.toLowerCase().includes(query)
      || skill.skillId.toLowerCase().includes(query)
      || skill.description.toLowerCase().includes(query)
    ));
  }, [resources.skills, skillSearch]);

  const replaceHook = (hook: HookConfig) => {
    const normalizedHook = normalizeHookConfig(hook);
    setHooks((current) => {
      const exists = current.some((item) => item.id === normalizedHook.id);
      return exists
        ? current.map((item) => item.id === normalizedHook.id ? normalizedHook : item)
        : [normalizedHook, ...current];
    });
  };

  const openExamples = async () => {
    setExamplesOpen(true);
    setExamplesLoading(true);
    setExamplesError(null);
    setSelectedExampleIds([]);
    try {
      const response = await api.admin.hookExamples();
      if (!response.ok) throw new Error(await readError(response, t('hooks.examples.loadError')));
      const payload = await response.json() as { examples?: HookExampleCatalogItem[] };
      setExampleCatalog(payload.examples || []);
    } catch (caughtError) {
      setExamplesError(caughtError instanceof Error ? caughtError.message : t('hooks.examples.loadError'));
    } finally {
      setExamplesLoading(false);
    }
  };

  const createExamples = async () => {
    if (selectedExampleIds.length === 0) return;
    setBusy(true);
    try {
      const response = await api.admin.createHookExamples(selectedExampleIds);
      if (!response.ok) throw new Error(await readError(response, t('hooks.examples.error')));
      const payload = await response.json() as {
        hooks?: HookConfig[];
        createdCount?: number;
        skippedCount?: number;
        visibleEvents?: HookEventName[];
      };
      const examples = (payload.hooks || []).map(normalizeHookConfig);
      setHooks((current) => {
        const byId = new Map(current.map((hook) => [hook.id, hook]));
        for (const example of examples) byId.set(example.id, example);
        return [...byId.values()];
      });
      if (payload.visibleEvents?.length) {
        setVisibleEvents(payload.visibleEvents);
        setVisibleEventDraft(payload.visibleEvents);
      }
      setExamplesOpen(false);
      setSelectedExampleIds([]);
      showToast(
        payload.createdCount
          ? t('hooks.examples.created', { count: payload.createdCount })
          : t('hooks.examples.alreadyExists'),
        'success',
      );
    } catch (caughtError) {
      showToast(caughtError instanceof Error ? caughtError.message : t('hooks.examples.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const openHookBindings = async (hook: HookConfig) => {
    setBindingsHook(hook);
    setBindingScope('users');
    setBindingUsers([]);
    setBindingTenants([]);
    setSelectedBindingUserIds([]);
    setSelectedBindingTenantIds([]);
    setBindingsError(null);
    setBindingsLoading(true);
    try {
      const response = await api.admin.hookBindings(hook.id);
      if (!response.ok) throw new Error(await readError(response, t('hooks.bindings.loadError')));
      const payload = await response.json() as {
        scope?: HookBindingScope;
        users?: HookBindingUser[];
        tenants?: HookBindingTenant[];
      };
      const users = payload.users || [];
      const tenants = payload.tenants || [];
      setBindingScope(payload.scope || 'users');
      setBindingUsers(users);
      setBindingTenants(tenants);
      setSelectedBindingUserIds(users.filter((user) => user.bound).map((user) => user.id));
      setSelectedBindingTenantIds(tenants.filter((tenant) => tenant.bound).map((tenant) => tenant.id));
    } catch (caughtError) {
      setBindingsError(caughtError instanceof Error ? caughtError.message : t('hooks.bindings.loadError'));
    } finally {
      setBindingsLoading(false);
    }
  };

  const saveHookBindings = async () => {
    if (!bindingsHook) return;
    setBindingsSaving(true);
    setBindingsError(null);
    try {
      const response = await api.admin.updateHookBindings(bindingsHook.id, {
        scope: bindingScope,
        userIds: bindingScope === 'users' ? selectedBindingUserIds : [],
        tenantIds: bindingScope === 'tenants' ? selectedBindingTenantIds : [],
      });
      if (!response.ok) throw new Error(await readError(response, t('hooks.bindings.saveError')));
      const payload = await response.json() as { hook: HookConfig };
      const normalizedHook = normalizeHookConfig(payload.hook);
      replaceHook(normalizedHook);
      if (editor && 'id' in editor && editor.id === normalizedHook.id) setEditor(normalizedHook);
      setBindingsHook(null);
      showToast(t(`hooks.bindings.savedScopes.${bindingScope}`), 'success');
    } catch (caughtError) {
      setBindingsError(caughtError instanceof Error ? caughtError.message : t('hooks.bindings.saveError'));
    } finally {
      setBindingsSaving(false);
    }
  };

  const persistEditor = async () => {
    if (!editor) return null;
    const response = 'id' in editor
      ? await api.admin.updateHook(editor.id, editor)
      : await api.admin.createHook(editor);
    if (!response.ok) throw new Error(await readError(response, t('hooks.errors.save')));
    const payload = await response.json() as { hook: HookConfig };
    const normalizedHook = normalizeHookConfig(payload.hook);
    replaceHook(normalizedHook);
    setEditor(normalizedHook);
    return normalizedHook;
  };

  const save = async () => {
    if (!editor) return;
    setBusy(true);
    try {
      await persistEditor();
      showToast(t('hooks.toast.saved'), 'success');
    } catch (caughtError) {
      showToast(caughtError instanceof Error ? caughtError.message : t('hooks.errors.save'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!editor) return;
    setBusy(true);
    try {
      const saved = await persistEditor();
      if (!saved) return;
      const response = await api.admin.publishHook(saved.id);
      if (!response.ok) throw new Error(await readError(response, t('hooks.errors.publish')));
      const payload = await response.json() as { hook: HookConfig };
      const normalizedHook = normalizeHookConfig(payload.hook);
      replaceHook(normalizedHook);
      setEditor(normalizedHook);
      showToast(t('hooks.toast.published'), 'success');
      if (normalizedHook.bindingController !== 'sql_check') await openHookBindings(normalizedHook);
    } catch (caughtError) {
      showToast(caughtError instanceof Error ? caughtError.message : t('hooks.errors.publish'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const publishFromList = async (hook: HookConfig) => {
    setBusy(true);
    try {
      const response = await api.admin.publishHook(hook.id);
      if (!response.ok) throw new Error(await readError(response, t('hooks.errors.publish')));
      const payload = await response.json() as { hook: HookConfig };
      const normalizedHook = normalizeHookConfig(payload.hook);
      replaceHook(normalizedHook);
      showToast(t('hooks.toast.published'), 'success');
      if (normalizedHook.bindingController !== 'sql_check') await openHookBindings(normalizedHook);
    } catch (caughtError) {
      showToast(caughtError instanceof Error ? caughtError.message : t('hooks.errors.publish'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeHook = async (hook: HookConfig) => {
    if (!window.confirm(t('hooks.confirmDelete', { name: hook.name }))) return;
    setBusy(true);
    try {
      const response = await api.admin.deleteHook(hook.id);
      if (!response.ok) throw new Error(await readError(response, t('hooks.errors.delete')));
      setHooks((current) => current.filter((item) => item.id !== hook.id));
      if (editor && 'id' in editor && editor.id === hook.id) setEditor(null);
      showToast(t('hooks.toast.deleted'), 'success');
    } catch (caughtError) {
      showToast(caughtError instanceof Error ? caughtError.message : t('hooks.errors.delete'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveVisibleEvents = async () => {
    if (!visibleEventDraft.length) return;
    setBusy(true);
    try {
      const response = await api.admin.updateHookSettings({ visibleEvents: visibleEventDraft });
      if (!response.ok) throw new Error(await readError(response, t('hooks.errors.saveSettings')));
      const payload = await response.json() as { visibleEvents: HookEventName[] };
      setVisibleEvents(payload.visibleEvents);
      setVisibleEventDraft(payload.visibleEvents);
      setEventsOpen(false);
      showToast(t('hooks.toast.eventsSaved'), 'success');
    } catch (caughtError) {
      showToast(caughtError instanceof Error ? caughtError.message : t('hooks.errors.saveSettings'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const openVisibleEvents = () => {
    setVisibleEventDraft([...visibleEvents]);
    setEventsOpen(true);
  };

  const loadDataRecords = async (hook: HookConfig) => {
    setRecordsHook(hook);
    setRecordsLoading(true);
    setRecordsError(null);
    try {
      const response = await api.admin.hookDataRecords(hook.id, 50);
      if (!response.ok) throw new Error(await readError(response, t('hooks.businessData.loadError')));
      const payload = await response.json() as { records?: HookDataRecord[] };
      setDataRecords(payload.records || []);
    } catch (caughtError) {
      setRecordsError(caughtError instanceof Error ? caughtError.message : t('hooks.businessData.loadError'));
    } finally {
      setRecordsLoading(false);
    }
  };

  const uploadBuiltinSkill = async (files: File[]) => {
    if (files.length === 0) return;
    setSkillUploadBusy(true);
    try {
      const formData = new FormData();
      const relativePaths = files.map((file) => file.webkitRelativePath || file.name);
      files.forEach((file) => formData.append('files', file, file.name));
      formData.set('paths', JSON.stringify(relativePaths));
      const response = await api.admin.uploadHookSkill(formData);
      if (!response.ok) throw new Error(await readError(response, t('hooks.errors.uploadSkill')));
      const payload = await response.json() as {
        skill?: HookResources['skills'][number];
        skills?: HookResources['skills'];
        skillSource?: HookResources['skillSource'];
      };
      setResources((current) => ({
        ...current,
        skills: payload.skills || current.skills,
        skillSource: payload.skillSource || current.skillSource,
      }));
      showToast(t('hooks.toast.skillUploaded', {
        name: payload.skill?.displayName || payload.skill?.name || relativePaths[0]?.split('/')[0],
      }), 'success');
    } catch (caughtError) {
      showToast(caughtError instanceof Error ? caughtError.message : t('hooks.errors.uploadSkill'), 'error');
    } finally {
      setSkillUploadBusy(false);
    }
  };

  const deleteBuiltinSkill = async (skill: HookResources['skills'][number]) => {
    if (!window.confirm(t('hooks.builtinSkills.confirmDelete', { name: skill.displayName || skill.name }))) return;
    setSkillDeleteBusyId(skill.skillId);
    try {
      const response = await api.admin.deleteHookSkill(skill.skillId);
      if (!response.ok) throw new Error(await readError(response, t('hooks.errors.deleteSkill')));
      const payload = await response.json() as {
        skills?: HookResources['skills'];
        skillSource?: HookResources['skillSource'];
      };
      setResources((current) => ({
        ...current,
        skills: payload.skills || current.skills.filter((item) => item.skillId !== skill.skillId),
        skillSource: payload.skillSource || current.skillSource,
      }));
      showToast(t('hooks.toast.skillDeleted', { name: skill.displayName || skill.name }), 'success');
    } catch (caughtError) {
      showToast(caughtError instanceof Error ? caughtError.message : t('hooks.errors.deleteSkill'), 'error');
    } finally {
      setSkillDeleteBusyId(null);
    }
  };

  const moreEventsDialog = (
    <MoreEventsDialog
      open={eventsOpen}
      selectedEvents={visibleEventDraft}
      busy={busy}
      onOpenChange={setEventsOpen}
      onToggle={(eventName) => setVisibleEventDraft((current) => (
        current.includes(eventName)
          ? current.filter((name) => name !== eventName)
          : [...current, eventName]
      ))}
      onSave={() => void saveVisibleEvents()}
    />
  );

  const userBindingsDialog = (
    <HookUserBindingsDialog
      hook={bindingsHook}
      scope={bindingScope}
      users={bindingUsers}
      tenants={bindingTenants}
      selectedUserIds={selectedBindingUserIds}
      selectedTenantIds={selectedBindingTenantIds}
      loading={bindingsLoading}
      saving={bindingsSaving}
      error={bindingsError}
      onClose={() => {
        setBindingsHook(null);
        setBindingScope('users');
        setBindingUsers([]);
        setBindingTenants([]);
        setSelectedBindingUserIds([]);
        setSelectedBindingTenantIds([]);
        setBindingsError(null);
      }}
      onScopeChange={setBindingScope}
      onToggle={(userId) => setSelectedBindingUserIds((current) => (
        current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]
      ))}
      onToggleTenant={(tenantId) => setSelectedBindingTenantIds((current) => (
        current.includes(tenantId) ? current.filter((id) => id !== tenantId) : [...current, tenantId]
      ))}
      onClear={() => {
        if (bindingScope === 'users') setSelectedBindingUserIds([]);
        if (bindingScope === 'tenants') setSelectedBindingTenantIds([]);
      }}
      onSave={() => void saveHookBindings()}
    />
  );

  const examplesDialog = (
    <HookExamplesDialog
      open={examplesOpen}
      examples={exampleCatalog}
      selectedIds={selectedExampleIds}
      loading={examplesLoading}
      saving={busy}
      error={examplesError}
      onClose={() => {
        setExamplesOpen(false);
        setSelectedExampleIds([]);
        setExamplesError(null);
      }}
      onToggle={(exampleId) => setSelectedExampleIds((current) => (
        current.includes(exampleId) ? current.filter((id) => id !== exampleId) : [...current, exampleId]
      ))}
      onCreate={() => void createExamples()}
    />
  );

  if (editor) {
    return (
      <div className="relative h-full min-h-0">
        {toast ? (
          <div className={cn(
            'pointer-events-none absolute bottom-4 right-4 z-50 flex max-w-sm items-center gap-2 rounded-xl px-4 py-2.5 text-sm text-white shadow-xl',
            toast.type === 'success' ? 'bg-emerald-600' : 'bg-destructive',
          )} role="status">
            {toast.type === 'success' ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
            {toast.message}
          </div>
        ) : null}
        <HookConfigEditor
          hook={editor}
          visibleEvents={visibleEvents}
          resources={resources}
          busy={busy}
          onChange={setEditor}
          onBack={() => setEditor(null)}
          onSave={() => void save()}
          onPublish={() => void publish()}
          onManageBindings={() => { if ('id' in editor) void openHookBindings(editor); }}
          onManageEvents={openVisibleEvents}
        />
        {moreEventsDialog}
        {userBindingsDialog}
      </div>
    );
  }

  if (activeView === 'diagnostics') {
    return (
      <div className="relative h-full min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-5 px-3 py-4 sm:px-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                <Activity className="h-5 w-5 text-primary" />
                {t('hooks.diagnostics.title')}
              </h2>
            </div>
            <div className="flex rounded-lg border border-border bg-muted/20 p-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setActiveView('configs')}>
                <Webhook className="h-4 w-4" />
                {t('hooks.diagnostics.configTab')}
              </Button>
              <Button type="button" variant="secondary" size="sm">
                <Activity className="h-4 w-4" />
                {t('hooks.diagnostics.diagnosticsTab')}
              </Button>
            </div>
          </div>
          <HookDiagnosticsPanel hooks={hooks} />
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0 overflow-y-auto">
      {toast ? (
        <div className={cn(
          'pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-sm items-center gap-2 rounded-xl px-4 py-2.5 text-sm text-white shadow-xl',
          toast.type === 'success' ? 'bg-emerald-600' : 'bg-destructive',
        )} role="status">
          {toast.type === 'success' ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
          {toast.message}
        </div>
      ) : null}

      <div className="mx-auto max-w-6xl space-y-5 px-3 py-4 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <Webhook className="h-5 w-5 text-primary" />
              {t('hooks.title')}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setActiveView('diagnostics')}
            >
              <Activity className="h-4 w-4" />
              {t('hooks.diagnostics.diagnosticsTab')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void openExamples()}
            >
              <BookOpen className="h-4 w-4" />
              {t('hooks.examples.create')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => setEditor(createEmptyHook(visibleEvents[0] || 'Stop'))}
            >
              <Plus className="h-4 w-4" />
              {t('hooks.create')}
            </Button>
          </div>
        </div>

        <Card className="p-4 shadow-none">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-foreground">{t('hooks.builtinSkills.title')}</h3>
            </div>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
              {resources.skills.length > 5 || skillSearch ? (
                <div className="relative min-w-0 sm:w-56">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={skillSearch}
                    onChange={(event) => setSkillSearch(event.target.value)}
                    placeholder={t('hooks.builtinSkills.search')}
                    className="h-9 pl-8"
                  />
                </div>
              ) : null}
              <label className="shrink-0">
                <input
                  type="file"
                  multiple
                  {...DIRECTORY_INPUT_ATTRIBUTES}
                  className="sr-only"
                  disabled={skillUploadBusy}
                  onChange={(event) => {
                    const files = Array.from(event.target.files || []);
                    event.target.value = '';
                    void uploadBuiltinSkill(files);
                  }}
                />
                <span className={cn(
                  'inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm',
                  skillUploadBusy ? 'pointer-events-none opacity-50' : 'hover:bg-accent',
                )}>
                  {skillUploadBusy
                    ? <RefreshCw className="h-4 w-4 animate-spin" />
                    : <Upload className="h-4 w-4" />}
                  {t(skillUploadBusy ? 'hooks.builtinSkills.uploading' : 'hooks.builtinSkills.upload')}
                </span>
              </label>
            </div>
          </div>
          <div className="mt-3 overflow-hidden rounded-lg border border-border">
            {filteredSkills.length ? (
              <div className="max-h-[200px] divide-y divide-border overflow-y-auto">
                {filteredSkills.map((skill) => {
                  const expanded = expandedSkillIds.includes(skill.skillId);
                  return (
                    <div key={skill.skillId}>
                      <div className="flex h-10 min-w-0 items-center gap-2 px-3">
                        <FileText className="h-4 w-4 shrink-0 text-primary" />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                          {skill.displayName || skill.name}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 shrink-0 gap-1 px-2 text-xs"
                          aria-expanded={expanded}
                          onClick={() => setExpandedSkillIds((current) => (
                            expanded
                              ? current.filter((skillId) => skillId !== skill.skillId)
                              : [...current, skill.skillId]
                          ))}
                        >
                          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} />
                          {t(expanded ? 'hooks.builtinSkills.collapse' : 'hooks.builtinSkills.details')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 shrink-0 px-2 text-xs text-destructive hover:text-destructive"
                          disabled={skillDeleteBusyId === skill.skillId}
                          onClick={() => void deleteBuiltinSkill(skill)}
                        >
                          {skillDeleteBusyId === skill.skillId
                            ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            : <Trash2 className="h-3.5 w-3.5" />}
                          {t('hooks.builtinSkills.delete')}
                        </Button>
                      </div>
                      {expanded ? (
                        <dl className="grid gap-1 border-t border-border bg-muted/15 px-3 py-2 pl-9 text-[11px] sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-3">
                          <dt className="text-muted-foreground">{t('hooks.builtinSkills.versionLabel')}</dt>
                          <dd className="text-foreground">v{skill.version}</dd>
                          <dt className="text-muted-foreground">{t('hooks.builtinSkills.idLabel')}</dt>
                          <dd className="min-w-0"><code className="break-all text-foreground">{skill.skillId}</code></dd>
                          {skill.description ? (
                            <>
                              <dt className="text-muted-foreground">{t('hooks.builtinSkills.descriptionLabel')}</dt>
                              <dd className="min-w-0 break-words text-foreground">{skill.description}</dd>
                            </>
                          ) : null}
                        </dl>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                {t(resources.skills.length ? 'hooks.builtinSkills.noMatches' : 'hooks.builtinSkills.empty')}
              </p>
            )}
          </div>
          {resources.skillSource?.error ? (
            <p className="mt-2 text-xs text-destructive">{resources.skillSource.error}</p>
          ) : null}
        </Card>

        <div className="flex items-center gap-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('hooks.search')}
            className="h-10 max-w-md rounded-xl"
          />
          <Button type="button" variant="ghost" size="icon" onClick={() => void load()} aria-label={t('common.refresh')}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </div>

        {error ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="flex min-h-56 items-center justify-center text-sm text-muted-foreground">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            {t('hooks.loading')}
          </div>
        ) : filteredHooks.length === 0 ? (
          <Card className="flex min-h-64 flex-col items-center justify-center border-dashed p-8 text-center shadow-none">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Webhook className="h-6 w-6" />
            </span>
            <h3 className="mt-4 text-sm font-semibold text-foreground">{search ? t('hooks.noMatches') : t('hooks.empty')}</h3>
            {!search ? (
              <Button type="button" size="sm" className="mt-4" onClick={() => setEditor(createEmptyHook(visibleEvents[0] || 'Stop'))}>
                <Plus className="h-4 w-4" />
                {t('hooks.create')}
              </Button>
            ) : null}
          </Card>
        ) : (
          <div className="grid auto-rows-fr gap-3 lg:grid-cols-2">
            {filteredHooks.map((hook) => {
              const mcpActions = hook.postActions.filter((action) => action.type === 'call_mcp_tool');
              const unavailableSkills = resources.skillSource?.available === false
                ? []
                : findUnavailableHookSkills(hook, resources.skills);
              const isSqlCheckManaged = hook.bindingController === 'sql_check';
              const bindingActive = hook.activationScope === 'all_users'
                || hook.boundTenantCount > 0
                || hook.boundUserCount > 0;
              const bindingLabel = isSqlCheckManaged
                ? t('hooks.bindings.sqlCheckManagedCount', { count: hook.boundUserCount })
                : hook.activationScope === 'all_users'
                ? t('hooks.bindings.allUsersShort')
                : hook.boundTenantCount > 0
                  ? t('hooks.bindings.boundTenantCountShort', { count: hook.boundTenantCount })
                  : hook.boundUserCount > 0
                    ? t('hooks.bindings.boundCountShort', { count: hook.boundUserCount })
                    : t('hooks.bindings.unbound');
              return (
              <Card key={hook.id} className="flex h-full flex-col overflow-hidden shadow-none transition-colors hover:border-primary/30">
                <div className="p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Webhook className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-semibold text-foreground">{hook.name}</h3>
                        {isSqlCheckManaged ? <Badge variant="outline">{t('hooks.builtin')}</Badge> : null}
                        <Badge variant={statusVariant(hook.status)}>{t(`statuses.${hook.status}`)}</Badge>
                        {hook.status === 'published' ? (
                          <Badge variant={bindingActive && !isSqlCheckManaged ? 'default' : 'outline'}>
                            {bindingLabel}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">
                        {hook.description || t('hooks.noDescription')}
                      </p>
                    </div>
                  </div>

                  {mcpActions.length > 0 ? (
                    <div className="mt-3 space-y-1.5">
                      {mcpActions.map((action) => {
                        const toolName = typeof action.config?.toolName === 'string'
                          ? action.config.toolName
                          : 'MCP Tool';
                        return (
                          <div
                            key={action.id}
                            className="flex items-center gap-2 rounded-lg border border-primary/15 bg-primary/5 px-2.5 py-2 text-[11px]"
                          >
                            <Wrench className="h-3.5 w-3.5 shrink-0 text-primary" />
                            <span className="shrink-0 font-medium text-foreground">MCP</span>
                            <code className="min-w-0 truncate text-muted-foreground" title={toolName}>{toolName}</code>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}

                  {unavailableSkills.length > 0 ? (
                    <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive">
                      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <div className="min-w-0">
                        <p className="font-medium">{t('hooks.builtinSkills.unavailableTitle')}</p>
                        <p className="mt-0.5 break-words leading-4">
                          {t('hooks.builtinSkills.unavailableDescription', {
                            skills: unavailableSkills.map((issue) => issue.label).join('、'),
                          })}
                        </p>
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <Badge variant="outline">{t(`hooks.events.${hook.eventName}.label`)}</Badge>
                    <span>
                      {hook.extensionLogic
                        ? hook.extensionLogic.language === 'python' ? 'Python' : 'JavaScript'
                        : t('hooks.noScript', { count: hook.postActions.length })}
                    </span>
                    {bindingActive ? <span>{bindingLabel}</span> : null}
                    {hook.version > 0 ? <span>v{hook.version}</span> : null}
                    <span className="ml-auto flex items-center gap-1"><Clock3 className="h-3 w-3" />{formatDate(hook.updatedAt, i18n.language)}</span>
                  </div>
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-1 border-t border-border bg-muted/10 px-3 py-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditor(hook)}>
                    <Pencil className="h-3.5 w-3.5" />
                    {t('hooks.edit')}
                  </Button>
                  {shouldShowBusinessData(hook) ? (
                    <Button type="button" variant="ghost" size="sm" onClick={() => void loadDataRecords(hook)}>
                      <Database className="h-3.5 w-3.5" />
                      {t('hooks.businessData.label')}
                    </Button>
                  ) : null}
                  <Button type="button" variant="ghost" size="sm" onClick={() => setDiagnosticsHook(hook)}>
                    <Activity className="h-3.5 w-3.5" />
                    {t('hooks.diagnostics.executionRecords')}
                  </Button>
                  {hook.status === 'published' && isSqlCheckManaged ? (
                    <span className="inline-flex h-8 items-center gap-1.5 px-3 text-xs text-muted-foreground">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      {t('hooks.bindings.sqlCheckManaged')}
                    </span>
                  ) : hook.status === 'published' ? (
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void openHookBindings(hook)}>
                      <UsersRound className="h-3.5 w-3.5" />
                      {t('hooks.bindings.manage')}
                    </Button>
                  ) : (
                    <Button type="button" variant="ghost" size="sm" disabled={busy || unavailableSkills.length > 0} onClick={() => void publishFromList(hook)}>
                      {t('hooks.publish')}
                    </Button>
                  )}
                  {!isSqlCheckManaged ? (
                    <Button type="button" variant="ghost" size="sm" className="ml-auto text-destructive hover:text-destructive" disabled={busy} onClick={() => void removeHook(hook)}>
                      <Trash2 className="h-3.5 w-3.5" />
                      {t('hooks.delete')}
                    </Button>
                  ) : null}
                </div>
              </Card>
              );
            })}
          </div>
        )}
      </div>

      <HookDataRecordsDialog
        hook={recordsHook}
        records={dataRecords}
        loading={recordsLoading}
        error={recordsError}
        onClose={() => {
          setRecordsHook(null);
          setDataRecords([]);
          setRecordsError(null);
        }}
        onRefresh={() => { if (recordsHook) void loadDataRecords(recordsHook); }}
      />

      <Dialog open={Boolean(diagnosticsHook)} onOpenChange={(open) => { if (!open) setDiagnosticsHook(null); }}>
        <DialogContent className="max-h-[90vh] max-w-6xl overflow-y-auto p-4 sm:p-5">
          <DialogTitle className="sr-only">{t('hooks.diagnostics.executionRecords')}</DialogTitle>
          {diagnosticsHook ? <HookDiagnosticsPanel hook={diagnosticsHook} hooks={hooks} /> : null}
        </DialogContent>
      </Dialog>

      {userBindingsDialog}
      {examplesDialog}

    </div>
  );
}
