import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import { createClientMessageId as createRequestId } from '../../../utils/clientMessageId';
import { useTenant } from '../../../contexts/TenantContext';
import { useAuth } from '../../auth/context/AuthContext';
import { dispatchProjectFilesChanged } from '../../file-tree/utils/fileTreeEvents';
import { dispatchSlashCommandsChangedForPath } from '../utils/slashCommandEvents';
import type { Project, LLMProvider } from '../../../types/app';
import type { ChatMessage } from '../types/types';

import { scheduleProjectsRefresh } from './chatRealtimeRefresh';
import { isSkillCreationActive as active, startSkillCreationPolling } from './skillCreationPolling';

type Job = { sessionId?: string; conversationKey?: string; id: string; requestId: string; description: string; status: string; createdAt: string; completedAt?: string; error?: string;
  result?: { name: string; path: string; snippets: Array<{ title: string; reason: string }>; note: string } };
type Draft = { mode: boolean; description: string; requestId?: string; sent?: string };
const empty: Draft = { mode: false, description: '' };
const emptyJobs: Job[] = [];
// Persist only opaque conversation identifiers, never descriptions or generated content.
const identifiers = new Map<string, string>();
function stored(key: string, value?: string | null): string | null {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else if (value !== undefined) sessionStorage.setItem(key, value);
    else return sessionStorage.getItem(key);
  } catch { /* Private browsing may disable session storage. */ }
  if (value === null) identifiers.delete(key);
  else if (value !== undefined) identifiers.set(key, value);
  return identifiers.get(key) || null;
}
async function payload(response: Response) { const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error || 'Request failed'), { status: response.status }); return value; }

export function useSkillCreation({ project, sessionId, provider, input, setInput, onConversationReady }: {
  project: Project | null; sessionId: string | null; provider: LLMProvider; input: string; setInput: (value: string) => void; onConversationReady?: (sessionId: string) => void;
}) {
  const { t } = useTranslation('common');
  const { user } = useAuth(); const { currentTenant } = useTenant();
  const concreteSession = sessionId && !sessionId.startsWith('new-session-') ? sessionId : null;
  const storageKey = `skill-creation:${user?.id}:${currentTenant?.id}:${project?.workspaceId}:${provider}`;
  const [, refreshIdentity] = useState(0);
  let draftId = stored(`${storageKey}:draft`);
  if (!draftId) { draftId = `draft-${createRequestId()}`; stored(`${storageKey}:draft`, draftId); }
  const adoptedDraft = concreteSession ? stored(`${storageKey}:adopt:${concreteSession}`) : null;
  const conversationKey = `${provider}:${adoptedDraft || concreteSession || draftId}`;
  const key = `${user?.id}:${currentTenant?.id}:${project?.workspaceId}:${conversationKey}`;
  const currentKey = useRef(key); currentKey.current = key;
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draft = drafts[key] || empty;
  const [view, setView] = useState<{ key: string; jobs: Job[] }>({ key, jobs: [] });
  const [sendingKey, setSendingKey] = useState<string | null>(null);
  const [pollRequest, setPollRequest] = useState<{ key: string } | null>(null);
  const stopPolling = useRef<() => void>(() => {});
  const [errorView, setErrorView] = useState({ key, text: '' });
  const handled = useRef(new Set<string>()), pending = useRef(new Set<string>());
  const jobs = view.key === key ? view.jobs : emptyJobs;
  const running = jobs.find(active);
  const busy = sendingKey === key || Boolean(running);
  const patch = (value: Partial<Draft>, target = key) => setDrafts((current) => ({ ...current, [target]: { ...(current[target] || empty), ...value } }));
  const receive = useRef<(incoming: Job[]) => void>(() => {});
  receive.current = (incoming) => {
    setView((current) => current.key === key && JSON.stringify(current.jobs) === JSON.stringify(incoming) ? current : { key, jobs: incoming });
    for (const job of incoming) {
      if (active(job)) { pending.current.add(job.id); patch({ mode: true, description: job.description, requestId: job.requestId, sent: job.description }); }
      else if (!handled.current.has(job.id) && (pending.current.has(job.id) || draft.requestId === job.requestId)) {
        handled.current.add(job.id);
        if (job.status === 'completed') {
          patch({ mode: false, description: '', requestId: undefined, sent: undefined });
          setInput('');
          if (job.result) {
            const event = { projectName: project?.name, workspaceId: project?.workspaceId, reason: 'skill-created' };
            dispatchProjectFilesChanged({ ...event, changedPath: job.result.path });
            dispatchSlashCommandsChangedForPath(job.result.path, event);
          }
        } else patch({ mode: true, description: job.description, requestId: undefined, sent: undefined });
      }
    }
  };
  useEffect(() => {
    if (!project?.workspaceId || (!concreteSession && pollRequest?.key !== key)) return;
    let disposed = false;
    const stop = startSkillCreationPolling<Job>({
      load: async () => {
        if (adoptedDraft && concreteSession) {
          const value = await payload(await api.skillCreation.bind(project.workspaceId, { conversationKey, sessionId: concreteSession, provider }));
          if (disposed || currentKey.current !== key) return [];
          stored(`${storageKey}:adopt:${concreteSession}`, null);
          scheduleProjectsRefresh(0);
          refreshIdentity((value) => value + 1);
          return value.jobs;
        }
        const value = await payload(await api.skillCreation.list(project.workspaceId, conversationKey));
        return value.jobs;
      },
      receive: (incoming) => {
        if (currentKey.current !== key) return;
        setErrorView({ key, text: '' });
        receive.current(incoming);
      },
      onError: (error) => { if (currentKey.current === key) setErrorView({ key, text: (error as Error).message }); },
      delay: () => document.hidden ? 10000 : 2000,
    });
    stopPolling.current = () => { disposed = true; stop(); };
    return stopPolling.current;
  }, [key, project?.workspaceId, conversationKey, adoptedDraft, concreteSession, storageKey, provider, pollRequest]);
  async function submit() {
    if (busy || !draft.description.trim() || !project?.workspaceId || project.accessRole === 'view' || pending.current.has(`send:${key}`)) return;
    const description = draft.description, requestId = draft.sent === description && draft.requestId ? draft.requestId : createRequestId();
    patch({ requestId, sent: description }); pending.current.add(`send:${key}`); setSendingKey(key); setErrorView({ key, text: '' });
    try {
      const { job } = await payload(await api.skillCreation.start(project.workspaceId, { intent: 'create-skill', description, requestId, conversationKey, sessionId: concreteSession, provider }));
      pending.current.add(job.id);
      if (currentKey.current === key) {
        stopPolling.current();
        receive.current([...jobs.filter((item) => item.id !== job.id), job]);
        setPollRequest({ key });
        if (!concreteSession && job.sessionId) {
          stored(`${storageKey}:draft`, null);
          scheduleProjectsRefresh(0);
          onConversationReady?.(job.sessionId);
        }
      }
    } catch (error) { setErrorView({ key, text: (error as Error).message }); }
    finally { pending.current.delete(`send:${key}`); setSendingKey((current) => current === key ? null : current); }
  }
  async function cancel() {
    if (!running || !project?.workspaceId) return;
    try {
      const { job } = await payload(await api.skillCreation.cancel(project.workspaceId, running.id));
      if (currentKey.current === key) {
        stopPolling.current();
        receive.current(jobs.map(item => item.id === job.id ? job : item));
        setPollRequest({ key });
      }
    }
    catch (error) { setErrorView({ key, text: (error as Error).message }); }
  }
  const messages = useMemo<ChatMessage[]>(() => jobs.flatMap((job) => {
    let content = t(`skillCreation.status.${job.status}`);
    if (job.status === 'completed' && job.result) content = t('skillCreation.completed', { name: job.result.name, path: job.result.path })
      + '\n\n' + (job.result.snippets.length ? t('skillCreation.references') + '\n' + job.result.snippets.map((s) => `- ${s.title}：${s.reason}`).join('\n') : t('skillCreation.noReferences'))
      + (job.result.note ? '\n\n' + job.result.note : '');
    if (job.error) content += '\n\n' + job.error;
    return [{ id: `creation-user-${job.id}`, type: 'user', content: job.description, timestamp: new Date(job.createdAt) },
      { id: `creation-result-${job.id}`, type: job.status === 'failed' ? 'error' : 'assistant', content, timestamp: new Date(job.createdAt), isStreaming: active(job) }];
  }), [jobs, t]);
  return { mode: draft.mode, description: draft.description, busy, messages, error: errorView.key === key ? errorView.text : '',
    toggle() { if (busy) return; if (draft.mode) { setInput(draft.description); patch({ mode: false }); } else patch({ mode: true, description: input }); },
    adoptSession(id: string) {
      if (concreteSession && !concreteSession.startsWith('skill-creation:') && !concreteSession.startsWith('pending:')) return;
      stored(`${storageKey}:adopt:${id}`, concreteSession || draftId);
      stored(`${storageKey}:draft`, null);
    },
    change(value: string) { patch({ description: value }); }, submit, cancel,
  };
}
