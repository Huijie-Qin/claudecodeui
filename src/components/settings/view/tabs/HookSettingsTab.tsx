import { useCallback, useEffect, useMemo, useState } from 'react';
import { History, RefreshCw, Webhook } from 'lucide-react';

import { api } from '../../../../utils/api';
import type { SettingsProject } from '../../types/types';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

import HookExecutionRecordsDrawer, {
  type UserHookExecution,
  type UserHookStandaloneRecord,
} from './HookExecutionRecordsDrawer';

const EXECUTION_PAGE_SIZE = 20;

type AvailableHook = {
  id: string;
  name: string;
  description: string;
  eventName: string;
  version: number;
  enabled: boolean;
  showInChat: boolean;
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
  const [visibilityBusyHookId, setVisibilityBusyHookId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recordsHook, setRecordsHook] = useState<AvailableHook | null>(null);
  const [executions, setExecutions] = useState<UserHookExecution[]>([]);
  const [standaloneRecords, setStandaloneRecords] = useState<UserHookStandaloneRecord[]>([]);
  const [executionTotal, setExecutionTotal] = useState(0);
  const [executionOffset, setExecutionOffset] = useState(0);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsLoadingMore, setRecordsLoadingMore] = useState(false);
  const [recordsError, setRecordsError] = useState<string | null>(null);

  useEffect(() => {
    if (workspaceId && availableProjects.some((project) => project.workspaceId === workspaceId)) return;
    setWorkspaceId(availableProjects[0]?.workspaceId || null);
  }, [availableProjects, workspaceId]);

  useEffect(() => {
    setRecordsHook(null);
    setExecutions([]);
    setStandaloneRecords([]);
    setExecutionTotal(0);
    setExecutionOffset(0);
    setRecordsError(null);
  }, [workspaceId]);

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
        if (!cancelled) {
          setHooks(Array.isArray(payload.hooks)
            ? payload.hooks.map((hook) => ({ ...hook, showInChat: hook.showInChat !== false }))
            : []);
        }
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

  const toggleHookVisibility = async (hook: AvailableHook, showInChat: boolean) => {
    if (!workspaceId) return;
    setVisibilityBusyHookId(hook.id);
    setError(null);
    try {
      const response = await api.updateWorkspaceHookChatVisibility(workspaceId, hook.id, showInChat);
      if (!response.ok) {
        throw new Error(await readError(response, showInChat ? '开启对话展示失败' : '关闭对话展示失败'));
      }
      setHooks((current) => current.map((candidate) => (
        candidate.id === hook.id ? { ...candidate, showInChat } : candidate
      )));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : '更新对话展示失败');
    } finally {
      setVisibilityBusyHookId(null);
    }
  };

  const loadExecutionRecords = useCallback(async (
    hook: AvailableHook,
    offset: number,
    append: boolean,
  ) => {
    if (!workspaceId) return;
    if (append) setRecordsLoadingMore(true);
    else setRecordsLoading(true);
    setRecordsError(null);
    try {
      const response = await api.workspaceHookExecutions(workspaceId, hook.id, {
        limit: EXECUTION_PAGE_SIZE,
        offset,
      });
      if (!response.ok) throw new Error(await readError(response, '加载执行记录失败'));
      const payload = await response.json() as {
        executions?: UserHookExecution[];
        standaloneRecords?: UserHookStandaloneRecord[];
        total?: number;
        offset?: number;
      };
      const nextExecutions = Array.isArray(payload.executions) ? payload.executions : [];
      if (!append) {
        setStandaloneRecords(Array.isArray(payload.standaloneRecords) ? payload.standaloneRecords : []);
      }
      setExecutions((current) => {
        if (!append) return nextExecutions;
        const merged = new Map(current.map((execution) => [execution.id, execution]));
        nextExecutions.forEach((execution) => merged.set(execution.id, execution));
        return [...merged.values()];
      });
      setExecutionTotal(Number(payload.total || 0));
      setExecutionOffset(Number(payload.offset ?? offset));
    } catch (caughtError) {
      setRecordsError(caughtError instanceof Error ? caughtError.message : '加载执行记录失败');
    } finally {
      setRecordsLoading(false);
      setRecordsLoadingMore(false);
    }
  }, [workspaceId]);

  const openExecutionRecords = (hook: AvailableHook) => {
    setRecordsHook(hook);
    setExecutions([]);
    setStandaloneRecords([]);
    setExecutionTotal(0);
    setExecutionOffset(0);
    void loadExecutionRecords(hook, 0, false);
  };

  const closeExecutionRecords = useCallback(() => {
    setRecordsHook(null);
    setRecordsError(null);
  }, []);

  return (
    <>
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

      <p className="text-xs leading-5 text-muted-foreground">
        对话展示只影响你自己的紫色 Hook 卡片；关闭后 Hook 仍会执行，并可在执行记录中查看结果。
      </p>

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
          const hasMcp = hook.postActions?.some((action) => action.type === 'call_mcp_tool' || action.type === 'mcp_loop_run');
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
              <div className="flex flex-shrink-0 flex-col items-end gap-2">
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`查看 ${hook.name} 的执行记录`}
                  onClick={() => openExecutionRecords(hook)}
                >
                  <History className="h-3.5 w-3.5" aria-hidden="true" />
                  执行记录
                </button>
                <div className="flex min-h-7 items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">启用</span>
                  <SettingsToggle
                    checked={hook.enabled}
                    disabled={Boolean(busyHookId) || isSqlCheckManaged}
                    ariaLabel={`${hook.enabled ? '关闭' : '开启'} ${hook.name}`}
                    onChange={(enabled) => void toggleHook(hook, enabled)}
                  />
                </div>
                <div
                  className="flex min-h-7 items-center gap-2"
                  title="只控制你自己的对话展示，不影响 Hook 执行和执行记录"
                >
                  <span className="text-[11px] font-medium text-foreground">对话展示</span>
                  <SettingsToggle
                    checked={hook.showInChat}
                    disabled={visibilityBusyHookId === hook.id}
                    ariaLabel={`${hook.showInChat ? '关闭' : '开启'} ${hook.name} 的对话展示`}
                    onChange={(showInChat) => void toggleHookVisibility(hook, showInChat)}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </SettingsCard>
      </SettingsSection>

      {recordsHook ? (
        <HookExecutionRecordsDrawer
          hook={recordsHook}
          executions={executions}
          standaloneRecords={standaloneRecords}
          total={executionTotal}
          loading={recordsLoading}
          loadingMore={recordsLoadingMore}
          error={recordsError}
          hasMore={executionOffset + EXECUTION_PAGE_SIZE < executionTotal}
          onClose={closeExecutionRecords}
          onRefresh={() => void loadExecutionRecords(recordsHook, 0, false)}
          onLoadMore={() => void loadExecutionRecords(
            recordsHook,
            executionOffset + EXECUTION_PAGE_SIZE,
            true,
          )}
        />
      ) : null}
    </>
  );
}
