import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Webhook } from 'lucide-react';

import { api } from '../../../../utils/api';
import type { SettingsProject } from '../../types/types';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

type AvailableHook = {
  id: string;
  name: string;
  description: string;
  eventName: string;
  version: number;
  enabled: boolean;
  bindingController?: 'admin' | 'sql_check';
  postActions?: Array<{ type?: string }>;
};

async function readError(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { error?: string };
    return payload.error || fallback;
  } catch {
    return fallback;
  }
}

export default function HookSettingsTab({
  projects,
  workspaceTerminology = 'workspace',
}: {
  projects: SettingsProject[];
  workspaceTerminology?: 'workspace' | 'expert';
}) {
  const availableProjects = useMemo(
    () => projects.filter((project) => Number.isInteger(project.workspaceId) && Number(project.workspaceId) > 0),
    [projects],
  );
  const [workspaceId, setWorkspaceId] = useState<number | null>(() => availableProjects[0]?.workspaceId || null);
  const [hooks, setHooks] = useState<AvailableHook[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyHookId, setBusyHookId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (workspaceId && availableProjects.some((project) => project.workspaceId === workspaceId)) return;
    setWorkspaceId(availableProjects[0]?.workspaceId || null);
  }, [availableProjects, workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setHooks([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.workspaceHooks(workspaceId)
      .then(async (response) => {
        if (!response.ok) throw new Error(await readError(response, '加载 Hook 失败'));
        const payload = await response.json() as { hooks?: AvailableHook[] };
        if (!cancelled) setHooks(Array.isArray(payload.hooks) ? payload.hooks : []);
      })
      .catch((caughtError) => {
        if (!cancelled) setError(caughtError instanceof Error ? caughtError.message : '加载 Hook 失败');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const toggleHook = async (hook: AvailableHook, enabled: boolean) => {
    if (!workspaceId) return;
    setBusyHookId(hook.id);
    setError(null);
    try {
      const response = await api.updateWorkspaceHook(workspaceId, hook.id, enabled);
      if (!response.ok) throw new Error(await readError(response, enabled ? '开启 Hook 失败' : '关闭 Hook 失败'));
      setHooks((current) => current.map((candidate) => (
        candidate.id === hook.id ? { ...candidate, enabled } : candidate
      )));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : '更新 Hook 失败');
    } finally {
      setBusyHookId(null);
    }
  };

  return (
    <SettingsSection title="辅助功能">
      {availableProjects.length > 1 ? (
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">{workspaceTerminology === 'expert' ? '专家' : '工作区'}</span>
          <select
            value={workspaceId || ''}
            onChange={(event) => setWorkspaceId(Number(event.target.value) || null)}
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
          >
            {availableProjects.map((project) => (
              <option key={project.workspaceId} value={project.workspaceId}>
                {project.displayName || project.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <SettingsCard divided>
        {!workspaceId ? (
          <div className="p-5 text-sm text-muted-foreground">
            {workspaceTerminology === 'expert' ? '当前没有可配置的专家。' : '当前没有可配置的工作区。'}
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" /> 正在加载 Hook
          </div>
        ) : hooks.length === 0 ? (
          <div className="p-5 text-sm text-muted-foreground">管理员暂未向你开放 Hook。</div>
        ) : hooks.map((hook) => {
          const isSqlCheckManaged = hook.bindingController === 'sql_check';
          const hasSkill = hook.postActions?.some((action) => action.type === 'invoke_skill');
          const hasMcp = hook.postActions?.some((action) => action.type === 'call_mcp_tool');
          const hasAgentMessage = hook.postActions?.some((action) => action.type === 'send_agent_message');
          return (
            <div key={hook.id} className="flex items-start gap-3 p-4">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Webhook className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{hook.name}</span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">{hook.eventName}</span>
                  {hasSkill ? <span className="text-[10px] text-muted-foreground">Skill</span> : null}
                  {hasMcp ? <span className="text-[10px] text-muted-foreground">MCP</span> : null}
                  {hasAgentMessage ? <span className="text-[10px] text-muted-foreground">Agent</span> : null}
                  {isSqlCheckManaged ? (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                      SQL Check 强制校验管理
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{hook.description || '无说明'}</p>
              </div>
              <SettingsToggle
                checked={hook.enabled}
                disabled={Boolean(busyHookId) || isSqlCheckManaged}
                ariaLabel={`${hook.enabled ? '关闭' : '开启'} ${hook.name}`}
                onChange={(enabled) => void toggleHook(hook, enabled)}
              />
            </div>
          );
        })}
      </SettingsCard>
    </SettingsSection>
  );
}
