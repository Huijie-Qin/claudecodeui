import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Clock3,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Webhook,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import { Badge, Button, Card, Dialog, DialogContent, DialogTitle, Input } from '../../shared/view/ui';
import { api } from '../../utils/api';

import HookConfigEditor from './hook-config/HookConfigEditor';
import { EVENT_DEFINITIONS, EVENT_GROUPS, createEmptyHook } from './hook-config/catalog';
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

type Toast = { type: 'success' | 'error'; message: string } | null;

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

export default function HookConfigsTab() {
  const { t, i18n } = useTranslation('admin');
  const [hooks, setHooks] = useState<HookConfig[]>([]);
  const [resources, setResources] = useState<HookResources>(EMPTY_RESOURCES);
  const [visibleEvents, setVisibleEvents] = useState<HookEventName[]>([]);
  const [visibleEventDraft, setVisibleEventDraft] = useState<HookEventName[]>([]);
  const [editor, setEditor] = useState<HookConfigDraft | HookConfig | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
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
      setHooks(hooksPayload.hooks || []);
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

  const replaceHook = (hook: HookConfig) => {
    setHooks((current) => {
      const exists = current.some((item) => item.id === hook.id);
      return exists
        ? current.map((item) => item.id === hook.id ? hook : item)
        : [hook, ...current];
    });
  };

  const persistEditor = async () => {
    if (!editor) return null;
    const response = 'id' in editor
      ? await api.admin.updateHook(editor.id, editor)
      : await api.admin.createHook(editor);
    if (!response.ok) throw new Error(await readError(response, t('hooks.errors.save')));
    const payload = await response.json() as { hook: HookConfig };
    replaceHook(payload.hook);
    setEditor(payload.hook);
    return payload.hook;
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
      replaceHook(payload.hook);
      setEditor(payload.hook);
      showToast(t('hooks.toast.published'), 'success');
    } catch (caughtError) {
      showToast(caughtError instanceof Error ? caughtError.message : t('hooks.errors.publish'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const disable = async (hookId?: string) => {
    const targetId = hookId || (editor && 'id' in editor ? editor.id : null);
    if (!targetId) return;
    setBusy(true);
    try {
      const response = await api.admin.disableHook(targetId);
      if (!response.ok) throw new Error(await readError(response, t('hooks.errors.disable')));
      const payload = await response.json() as { hook: HookConfig };
      replaceHook(payload.hook);
      if (editor && 'id' in editor && editor.id === payload.hook.id) setEditor(payload.hook);
      showToast(t('hooks.toast.disabled'), 'success');
    } catch (caughtError) {
      showToast(caughtError instanceof Error ? caughtError.message : t('hooks.errors.disable'), 'error');
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
      replaceHook(payload.hook);
      showToast(t('hooks.toast.published'), 'success');
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
          onDisable={() => void disable()}
          onManageEvents={openVisibleEvents}
        />
        {moreEventsDialog}
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
            <p className="mt-1 text-xs text-muted-foreground">{t('hooks.description')}</p>
          </div>
          <div className="flex items-center gap-2">
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
          <div className="grid gap-3 lg:grid-cols-2">
            {filteredHooks.map((hook) => (
              <Card key={hook.id} className="overflow-hidden shadow-none transition-colors hover:border-primary/30">
                <div className="p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Webhook className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-semibold text-foreground">{hook.name}</h3>
                        <Badge variant={statusVariant(hook.status)}>{t(`statuses.${hook.status}`)}</Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">
                        {hook.description || t('hooks.noDescription')}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <Badge variant="outline">{t(`hooks.events.${hook.eventName}.label`)}</Badge>
                    <span>{t('hooks.actionCount', { count: hook.actionCount ?? hook.actions.length })}</span>
                    {hook.version > 0 ? <span>v{hook.version}</span> : null}
                    <span className="ml-auto flex items-center gap-1"><Clock3 className="h-3 w-3" />{formatDate(hook.updatedAt, i18n.language)}</span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1 border-t border-border bg-muted/10 px-3 py-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditor(hook)}>
                    <Pencil className="h-3.5 w-3.5" />
                    {t('hooks.edit')}
                  </Button>
                  {hook.status === 'published' ? (
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void disable(hook.id)}>
                      {t('hooks.disable')}
                    </Button>
                  ) : (
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void publishFromList(hook)}>
                      {t('hooks.publish')}
                    </Button>
                  )}
                  <Button type="button" variant="ghost" size="sm" className="ml-auto text-destructive hover:text-destructive" disabled={busy} onClick={() => void removeHook(hook)}>
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('hooks.delete')}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
