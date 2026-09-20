import { useCallback, useEffect, useState } from 'react';
import { Plus, Webhook } from 'lucide-react';

import { Button } from '../../shared/view/ui';
import HookConfigEditor from '../admin/hook-config/HookConfigEditor';
import { createHookDraftSignature } from '../admin/hook-config/editorUtils';
import type { HookConfig, HookConfigDraft, HookResources } from '../admin/hook-config/types';

import { readManagementJson, type TenantManagementApi } from './tenantManagementApi';

const EMPTY_RESOURCES: HookResources = { events: [], builtinTools: [], mcpTools: [], hookMcpServers: [], skills: [], environmentVariables: [] };
export default function TenantHooksTab({ managementApi }: { managementApi: TenantManagementApi }) {
  const [hooks, setHooks] = useState<HookConfig[]>([]);
  const [resources, setResources] = useState(EMPTY_RESOURCES);
  const [editing, setEditing] = useState<HookConfig | HookConfigDraft | null>(null);
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [defaultEnabled, setDefaultEnabled] = useState(false);
  const load = useCallback(async () => {
    const payload = await readManagementJson<{ hooks: HookConfig[] }>(await managementApi.hooks());
    setHooks(payload.hooks);
  }, [managementApi]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([managementApi.hooks().then(readManagementJson<{ hooks: HookConfig[] }>), managementApi.hookResources().then(readManagementJson<HookResources>)])
      .then(([list, catalog]) => { if (active) { setHooks(list.hooks); setResources({ ...EMPTY_RESOURCES, ...catalog }); } })
      .catch((reason) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [managementApi]);
  const open = (hook: HookConfig | HookConfigDraft) => {
    setEditing(hook); setSignature(createHookDraftSignature(hook)); setError(''); setMessage('');
    setDefaultEnabled('id' in hook ? Boolean(hook.defaultEnabled) : false);
  };
  const dirty = Boolean(editing && createHookDraftSignature(editing) !== signature);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const save = async (publish: boolean) => {
    if (!editing || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = 'id' in editing ? await managementApi.updateHook(editing.id, editing) : await managementApi.createHook(editing);
      let saved = (await readManagementJson<{ hook: HookConfig }>(response)).hook;
      setEditing(saved); setSignature(createHookDraftSignature(saved));
      if (publish) saved = (await readManagementJson<{ hook: HookConfig }>(await managementApi.publishHook(saved.id, defaultEnabled))).hook;
      setEditing(saved); setSignature(createHookDraftSignature(saved));
      setMessage(publish ? '已发布到当前租户' : '草稿已保存');
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败'); }
    finally { setBusy(false); }
  };
  const remove = async (hook: HookConfig) => {
    if (!window.confirm(`删除本租户 Hook“${hook.name}”？此操作无法撤销。`)) return;
    setBusy(true); setError('');
    try { await readManagementJson(await managementApi.deleteHook(hook.id)); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '删除失败'); }
    finally { setBusy(false); }
  };
  return <div className="space-y-4">
    {error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
    {message && <p role="status" className="text-sm text-primary">{message}</p>}
    {editing ? <>
      <label className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 p-3 text-sm"><input type="checkbox" checked={defaultEnabled} disabled={busy} onChange={(event) => setDefaultEnabled(event.target.checked)} />发布后对本租户用户默认启用（不覆盖用户已有选择）</label>
      <HookConfigEditor hook={editing} visibleEvents={resources.events} resources={resources} busy={busy} dirty={dirty} onChange={setEditing}
        onBack={() => { setEditing(null); void load().catch((reason) => setError(reason.message)); }}
        onSave={() => void save(false)} onPublish={() => void save(true)} onManageBindings={() => {}} onManageEvents={() => {}} tenantManaged />
    </> : <>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">Hook 配置</h2><p className="mt-1 text-sm text-muted-foreground">管理本租户创建的 Hook。发布后仅本租户可用，平台统一配置仍由系统管理员维护。</p></div>
        <Button disabled={loading || busy} onClick={() => open({ name: '', description: '', eventName: 'Stop', includeSubagents: false, matcher: {}, extensionLogic: null, postActions: [], claudeResponse: { bindings: {} }, userVariables: [] })}><Plus className="h-4 w-4" />新建 Hook</Button></div>
      <div className="overflow-hidden rounded-xl border border-border">
        {loading ? <p className="p-10 text-center text-muted-foreground">正在加载…</p> : hooks.length === 0 ? <p className="p-10 text-center text-muted-foreground">本租户还没有创建 Hook</p> : hooks.map((hook) => <div key={hook.id} className="flex flex-wrap items-center gap-3 border-b border-border p-4 last:border-0">
          <Webhook className="h-5 w-5 text-primary" /><div className="min-w-0 flex-1"><h3 className="font-medium">{hook.name}</h3><p className="break-words text-sm text-muted-foreground">{hook.description || hook.eventName}</p><p className="mt-1 text-xs text-muted-foreground">{hook.status === 'published' ? '已发布' : '草稿'} · {hook.eventName} · v{hook.version}</p></div>
          <Button variant="outline" disabled={busy} onClick={() => open(hook)}>配置</Button><Button variant="ghost" disabled={busy} onClick={() => void remove(hook)}>删除</Button>
        </div>)}
      </div>
    </>}
  </div>;
}
