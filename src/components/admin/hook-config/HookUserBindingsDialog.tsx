import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Building2, Check, ChevronDown, CircleAlert, Globe2, Info, RefreshCw, Search, Settings2, UsersRound, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';
import { Badge, Button, Dialog, DialogContent, DialogTitle, Input, Tooltip } from '../../../shared/view/ui';

import { bindingOptions, canSaveHookBindings, filterBindingOptions, matchBindingUsernames } from './bindings';
import type { HookBindingScope, HookBindingTenant, HookBindingUser } from './bindings';
import type { HookConfig } from './types';

type Props = {
  hook: HookConfig | null;
  scope: HookBindingScope;
  defaultEnabled: boolean;
  defaultShowInChat: boolean;
  users: HookBindingUser[];
  tenants: HookBindingTenant[];
  selectedUserIds: number[];
  selectedTenantIds: number[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onScopeChange: (scope: HookBindingScope) => void;
  onDefaultEnabledChange: (enabled: boolean) => void;
  onDefaultShowInChatChange: (show: boolean) => void;
  onOverwrite: () => void;
  onToggle: (id: number) => void;
  onToggleTenant: (id: number) => void;
  onBatchChange: (ids: number[], selected: boolean) => void;
  onClear: () => void;
  onSave: () => void;
};

const scopes = [
  { value: 'users', icon: UsersRound },
  { value: 'tenants', icon: Building2 },
  { value: 'all_users', icon: Globe2 },
] as const;

function DefaultSwitch({ label, hint, checked, disabled, onChange }: {
  label: string; hint: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void;
}) {
  const id = useId();
  return <div className="flex items-center gap-2">
    <label htmlFor={id} className="flex-1 cursor-pointer text-sm font-medium">{label}</label>
    <Tooltip content={hint} position="left">
      <button type="button" aria-label={`${label} · ${hint}`} className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Info className="h-3.5 w-3.5" /></button>
    </Tooltip>
    <label className="relative inline-flex shrink-0 cursor-pointer items-center">
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} className="peer sr-only" />
      <span aria-hidden className="h-5 w-9 rounded-full bg-muted-foreground/30 transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-disabled:opacity-50" />
      <span aria-hidden className="absolute left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
    </label>
  </div>;
}

export default function HookUserBindingsDialog(props: Props) {
  const { hook, scope, defaultEnabled, defaultShowInChat, users, tenants, selectedUserIds, selectedTenantIds,
    loading, saving, error, onClose, onScopeChange, onDefaultEnabledChange, onDefaultShowInChatChange,
    onOverwrite, onToggle, onToggleTenant, onBatchChange, onClear, onSave } = props;
  const { t } = useTranslation('admin');
  const titleId = useId();
  const scopeId = useId();
  const batchId = useId();
  const [query, setQuery] = useState('');
  const [onlySelected, setOnlySelected] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchUsernames, setBatchUsernames] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirmationBack = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setQuery(''); setOnlySelected(false); setBatchOpen(false); setBatchUsernames('');
    setAdvancedOpen(false); setOverwrite(false); setConfirming(false);
  }, [hook?.id]);

  useEffect(() => {
    if (confirming) confirmationBack.current?.focus();
  }, [confirming]);

  const selectedIds = scope === 'users' ? selectedUserIds : selectedTenantIds;
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const options = useMemo(() => bindingOptions(scope, users, tenants), [scope, users, tenants]);
  const visible = useMemo(() => filterBindingOptions(options, query, selected, onlySelected), [options, query, selected, onlySelected]);
  const batch = useMemo(() => matchBindingUsernames(batchUsernames, users), [batchUsernames, users]);
  const activeUserCount = users.filter(user => user.isActive).length;
  const count = scope === 'all_users' ? activeUserCount : selected.size;
  const summary = t(`hooks.bindings.selectionSummary.${scope}`, { count });
  const visibleActiveIds = visible.filter(option => option.active).map(option => option.id);
  const selectedNames = options.filter(option => selected.has(option.id)).map(option => option.name);
  const canSave = canSaveHookBindings(scope, count, overwrite, loading, saving);
  const clear = () => { setOverwrite(false); onClear(); };
  const back = () => { setConfirming(false); requestAnimationFrame(() => saveButton.current?.focus()); };
  const close = () => { if (!saving) { if (confirming) back(); else onClose(); } };
  const settingSummary = <dl className="space-y-3 text-sm">
    <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t('hooks.bindings.scopeLabel')}</dt><dd>{t(`hooks.bindings.scopes.${scope}`)}</dd></div>
    <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t('hooks.bindings.defaultEnabled')}</dt><dd>{t(defaultEnabled ? 'hooks.bindings.on' : 'hooks.bindings.off')}</dd></div>
    <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t('hooks.bindings.defaultShowInChat')}</dt><dd>{t(defaultShowInChat ? 'hooks.bindings.on' : 'hooks.bindings.off')}</dd></div>
  </dl>;

  return <Dialog open={Boolean(hook)} onOpenChange={open => { if (!open) close(); }}>
    <DialogContent aria-labelledby={titleId} className="flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-5xl flex-col overflow-hidden p-0">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4 sm:px-6">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><UsersRound className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <DialogTitle id={titleId} className="not-sr-only text-base font-semibold">{t(confirming ? 'hooks.bindings.confirmTitle' : 'hooks.bindings.manage')}</DialogTitle>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={hook?.name}>{hook?.name} <span className="ml-1">· v{hook?.version}</span></p>
        </div>
        <Button type="button" variant="ghost" size="icon" disabled={saving} onClick={close} aria-label={t('hooks.close')}><X className="h-4 w-4" /></Button>
      </header>

      {error && <div role="alert" className="mx-5 mt-4 shrink-0 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}

      {confirming ? <div className="min-h-0 space-y-5 overflow-y-auto p-5 sm:p-6">
        <div className="flex gap-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
          <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div><h3 className="font-medium">{summary}</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">{t('hooks.bindings.confirmDescription')}</p></div>
        </div>
        <div className="rounded-xl border border-border p-4">{settingSummary}
          {selectedNames.length > 0 && <p className="mt-4 break-words border-t border-border pt-3 text-sm leading-6">{selectedNames.join('、')}</p>}
        </div>
      </div> : <div className="min-h-0 overflow-y-auto overscroll-contain">
        <div className="grid md:grid-cols-[minmax(0,1fr)_280px]">
          <section aria-label={t('hooks.bindings.scopeLabel')} className="min-w-0 space-y-4 p-5 sm:p-6">
            <fieldset disabled={loading || saving}>
              <legend className="mb-3 text-sm font-semibold">{t('hooks.bindings.scopeLabel')}</legend>
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted/60 p-1">
                {scopes.map(({ value, icon: Icon }) => <label key={value} className="relative cursor-pointer">
                  <input type="radio" name={scopeId} value={value} checked={scope === value} className="peer sr-only" onChange={() => {
                    setQuery(''); setOnlySelected(false); setOverwrite(false); setBatchOpen(false); onScopeChange(value);
                  }} />
                  <span className="flex min-h-10 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium text-muted-foreground transition-colors peer-checked:bg-background peer-checked:text-primary peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-50 sm:text-sm">
                    <Icon className="hidden h-4 w-4 shrink-0 sm:block" />{t(`hooks.bindings.scopes.${value}`)}
                  </span>
                </label>)}
              </div>
            </fieldset>
            <p className="text-xs leading-5 text-muted-foreground">{t(`hooks.bindings.scopeHints.${scope}`)}</p>

            {scope !== 'all_users' && <>
              <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} disabled={loading || saving} onChange={event => setQuery(event.target.value)} aria-label={t(scope === 'users' ? 'hooks.bindings.search' : 'hooks.bindings.searchTenant')} placeholder={t(scope === 'users' ? 'hooks.bindings.search' : 'hooks.bindings.searchTenant')} className="h-10 pl-9" />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={onlySelected} disabled={loading || saving} onChange={event => setOnlySelected(event.target.checked)} className="h-3.5 w-3.5 accent-primary" />{t('hooks.bindings.onlySelected')}</label>
                <div className="flex items-center gap-1">
                  <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={loading || saving || !visibleActiveIds.some(id => !selected.has(id))} onClick={() => onBatchChange(visibleActiveIds, true)}>{t('hooks.bindings.selectResults')}</Button>
                  <span className="text-border">|</span>
                  <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" disabled={loading || saving || count === 0} onClick={clear}>{t('hooks.bindings.clear')}</Button>
                </div>
              </div>
            </>}

            {scope === 'users' && <div className="rounded-lg border border-dashed border-border">
              <button type="button" aria-expanded={batchOpen} aria-controls={batchId} disabled={loading || saving} onClick={() => setBatchOpen(!batchOpen)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium text-muted-foreground hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !batchOpen && '-rotate-90')} />{t('hooks.bindings.batchUsernames')}
              </button>
              {batchOpen && <div id={batchId} className="space-y-3 border-t border-border p-3">
                <textarea value={batchUsernames} disabled={loading || saving} onChange={event => setBatchUsernames(event.target.value)} aria-label={t('hooks.bindings.batchUsernames')} placeholder={t('hooks.bindings.batchUsernamesHint')} rows={3} autoCapitalize="none" autoComplete="off" className="w-full resize-y rounded-lg border border-input bg-background p-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                {batch.missing.length > 0 && <p role="alert" className="break-words text-xs text-destructive">{t('hooks.bindings.batchMissingUsers', { usernames: batch.missing.join(', ') })}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={loading || saving || batch.ids.length === 0 || batch.missing.length > 0} onClick={() => onBatchChange(batch.ids, true)}>{t('hooks.bindings.selectNames')}</Button>
                  <Button type="button" variant="ghost" size="sm" disabled={loading || saving || batch.missing.length > 0 || !batch.ids.some(id => selected.has(id))} onClick={() => onBatchChange(batch.ids, false)}>{t('hooks.bindings.deselectNames')}</Button>
                  <span className="text-xs text-muted-foreground">{t('hooks.bindings.batchMatchedCount', { count: batch.ids.length })}</span>
                </div>
              </div>}
            </div>}

            <div aria-busy={loading} className="overflow-hidden rounded-xl border border-border">
              {loading ? <div className="flex min-h-52 items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><RefreshCw className="h-4 w-4 animate-spin" />{t('hooks.bindings.loading')}</div>
                : scope === 'all_users' ? <div className="flex min-h-52 flex-col items-center justify-center bg-muted/10 px-6 py-8 text-center">
                  <Globe2 className="h-8 w-8 text-primary/70" /><h3 className="mt-4 font-medium">{t('hooks.bindings.allUsersTitle')}</h3>
                  <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{t('hooks.bindings.allUsersDescription', { count: activeUserCount })}</p>
                  <Button type="button" variant="ghost" size="sm" className="mt-3 text-xs" disabled={saving} onClick={clear}>{t('hooks.bindings.cancelAllUsers')}</Button>
                </div> : visible.length === 0 ? <div role="status" className="flex min-h-52 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
                  <Search className="h-6 w-6 opacity-50" />{t(onlySelected ? 'hooks.bindings.noSelectedMatches' : query ? 'hooks.bindings.noResults' : scope === 'users' ? 'hooks.bindings.noUsers' : 'hooks.bindings.noTenants')}
                </div> : <div className="divide-y divide-border/60">{visible.map(option => {
                  const checked = selected.has(option.id);
                  const disabled = saving || (!option.active && !checked);
                  return <label key={option.id} className={cn('flex items-center gap-3 px-3 py-3 transition-colors sm:px-4', checked ? 'bg-primary/5' : 'hover:bg-muted/30', disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')}>
                    <input type="checkbox" checked={checked} disabled={disabled} onChange={() => scope === 'users' ? onToggle(option.id) : onToggleTenant(option.id)} className="h-4 w-4 shrink-0 accent-primary" aria-label={option.name} />
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-xs font-medium text-muted-foreground">{scope === 'users' ? option.name.slice(0, 1).toUpperCase() : <Building2 className="h-4 w-4" />}</span>
                    <span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium">{option.name}</span><span className="block break-all text-[11px] text-muted-foreground">{option.detail}</span></span>
                    {option.memberCount != null && <span className="shrink-0 text-xs text-muted-foreground">{t('hooks.bindings.tenantUsers', { count: option.memberCount })}</span>}
                    {option.admin && <Badge variant="outline">{t('hooks.bindings.admin')}</Badge>}
                    {!option.active && <Badge variant="secondary">{t('hooks.bindings.inactive')}</Badge>}
                  </label>;
                })}</div>}
            </div>
          </section>

          <aside aria-label={t('hooks.bindings.defaultsTitle')} className="border-t border-border bg-muted/20 p-5 sm:p-6 md:border-l md:border-t-0">
            <div className="space-y-6 md:sticky md:top-6">
              <section className="space-y-4"><h3 className="flex items-center gap-2 text-sm font-semibold"><Settings2 className="h-4 w-4 text-muted-foreground" />{t('hooks.bindings.defaultsTitle')}</h3>
                <DefaultSwitch label={t('hooks.bindings.defaultEnabled')} hint={t('hooks.bindings.defaultEnabledHint')} checked={defaultEnabled} disabled={loading || saving} onChange={onDefaultEnabledChange} />
                <DefaultSwitch label={t('hooks.bindings.defaultShowInChat')} hint={t('hooks.bindings.defaultShowInChatHint')} checked={defaultShowInChat} disabled={loading || saving} onChange={onDefaultShowInChatChange} />
                <p className="text-xs leading-5 text-muted-foreground">{t('hooks.bindings.preserveHint')}</p>
              </section>
              <section className="border-t border-border pt-5"><h3 className="text-xs font-medium text-muted-foreground">{t('hooks.bindings.selectionTitle')}</h3>
                <p className="mt-2 text-sm font-semibold" role="status">{loading ? '—' : summary}</p>
                {selectedNames.length > 0 && <p className="mt-2 break-words text-xs leading-5 text-muted-foreground">{selectedNames.slice(0, 4).join('、')}{selectedNames.length > 4 ? ` ${t('hooks.bindings.moreSelected', { count: selectedNames.length - 4 })}` : ''}</p>}
              </section>
              <section className="border-t border-border pt-4">
                <button type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(!advancedOpen)} className="flex w-full items-center justify-between rounded text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {t('hooks.bindings.advanced')}<ChevronDown className={cn('h-3.5 w-3.5 transition-transform', advancedOpen && 'rotate-180')} />
                </button>
                {advancedOpen && <div className="mt-4 space-y-2">
                  <label className="flex cursor-pointer items-start gap-2 text-xs font-medium"><input type="checkbox" checked={overwrite} disabled={loading || saving || (!overwrite && count === 0)} onChange={event => setOverwrite(event.target.checked)} className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" />{t('hooks.bindings.overwriteUserPreferences')}</label>
                  <p className="text-xs leading-5 text-muted-foreground">{t('hooks.bindings.overwriteUserPreferencesHint')}</p>
                </div>}
                {overwrite && <p className="mt-3 flex items-start gap-1.5 text-xs leading-5 text-amber-700 dark:text-amber-400"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t('hooks.bindings.overwritePending')}</p>}
              </section>
            </div>
          </aside>
        </div>
      </div>}

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-background px-5 py-4 sm:px-6">
        <p className="text-xs text-muted-foreground">{loading ? t('hooks.bindings.loading') : summary}<span className="ml-2">· {t(overwrite ? 'hooks.bindings.overwriteShort' : 'hooks.bindings.preserveShort')}</span></p>
        <div className="ml-auto flex gap-2">
          <Button ref={confirmationBack} type="button" variant="outline" disabled={saving} onClick={confirming ? back : onClose}>{t(confirming ? 'hooks.bindings.backToEdit' : 'hooks.cancel')}</Button>
          <Button ref={saveButton} type="button" variant={confirming ? 'destructive' : 'default'} disabled={!canSave} onClick={() => {
            if (!canSave) return;
            if (overwrite) { if (confirming) onOverwrite(); else setConfirming(true); }
            else onSave();
          }}>{saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{t(confirming ? 'hooks.bindings.confirmOverwrite' : 'hooks.bindings.save')}</Button>
        </div>
      </footer>
    </DialogContent>
  </Dialog>;
}
