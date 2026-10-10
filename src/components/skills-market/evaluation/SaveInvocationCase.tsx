import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, Save } from 'lucide-react';

import { api } from '../../../utils/api';

export default function SaveInvocationCase({ workspaceId, messageId }: { workspaceId: number; messageId: string }) {
  const { t } = useTranslation('common');
  const [invocation, setInvocation] = useState<{ id: string; name: string } | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle'), [error, setError] = useState('');
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    async function check() {
      try {
        const response = await api.skillEvaluations.invocation(workspaceId, messageId);
        if (!response.ok) return;
        const value = await response.json();
        if (live) setInvocation(value.invocation);
        if (live && !value.invocation && ++attempts < 3) timer = setTimeout(check, 2500);
      } catch { /* This optional action must never disrupt the chat transcript. */ }
    }
    timer = setTimeout(check, 1200);
    return () => { live = false; clearTimeout(timer); };
  }, [workspaceId, messageId]);
  if (!invocation) return null;
  return <div className="inline-flex shrink-0 flex-col items-start">
    <button type="button" className="inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-1 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50" disabled={state !== 'idle'} onClick={() => void (async () => {
      setState('saving'); setError('');
      try {
        const current = await api.skillEvaluations.cases(workspaceId, invocation.name);
        const data = await current.json();
        if (!current.ok) throw new Error(data.error);
        const response = await api.skillEvaluations.saveInvocation(workspaceId, invocation.name, invocation.id, data.revision);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        setState('saved');
      } catch (e) { setState('idle'); setError((e as Error).message); }
    })()}>
      {state === 'saving' ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" /> : state === 'saved' ? <Check className="h-3 w-3 shrink-0" aria-hidden="true" /> : <Save className="h-3 w-3 shrink-0" aria-hidden="true" />}
      {t(`skillEvaluation.${state === 'saved' ? 'invocationSaved' : state === 'saving' ? 'working' : 'saveInvocation'}`)}</button>
    {error && <p role="alert" className="mt-1 text-red-600">{error}</p>}
  </div>;
}
