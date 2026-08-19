import { useEffect, useState } from 'react';
import { Link2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';

import { createAgentGraphId } from './types';
import type { AgentNode, AgentRelation } from './types';

type RelationDialogProps = {
  open: boolean;
  agents: AgentNode[];
  initialSourceId?: string | null;
  onClose: () => void;
  onSubmit: (relation: AgentRelation) => void;
};

export default function RelationDialog({ open, agents, initialSourceId, onClose, onSubmit }: RelationDialogProps) {
  const { t } = useTranslation('agentGraph');
  const [sourceAgent, setSourceAgent] = useState('');
  const [targetAgent, setTargetAgent] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const source = initialSourceId && agents.some((agent) => agent.id === initialSourceId)
      ? initialSourceId
      : agents[0]?.id || '';
    setSourceAgent(source);
    setTargetAgent(agents.find((agent) => agent.id !== source)?.id || '');
    setDescription('');
    setError(null);
  }, [agents, initialSourceId, open]);

  if (!open) return null;

  const submit = () => {
    if (!sourceAgent || !targetAgent || sourceAgent === targetAgent || !description.trim()) {
      setError(t('relation.validation'));
      return;
    }
    onSubmit({
      id: createAgentGraphId(),
      sourceAgent,
      targetAgent,
      description: description.trim(),
    });
  };

  return (
    <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <Link2 className="h-4 w-4 text-primary" />
            {t('relation.title')}
          </div>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        <div className="space-y-4 p-5">
          <p className="text-sm text-muted-foreground">{t('relation.description')}</p>
          <label className="block space-y-2">
            <span className="text-sm font-medium text-foreground">{t('relation.source')}</span>
            <select value={sourceAgent} onChange={(event) => setSourceAgent(event.target.value)} className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground">
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-medium text-foreground">{t('relation.target')}</span>
            <select value={targetAgent} onChange={(event) => setTargetAgent(event.target.value)} className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground">
              {agents.filter((agent) => agent.id !== sourceAgent).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-medium text-foreground">{t('relation.relationship')}</span>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} placeholder={t('relation.placeholder')} className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
          </label>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <Button variant="outline" onClick={onClose}>{t('actions.cancel')}</Button>
          <Button onClick={submit}>{t('actions.createRelation')}</Button>
        </div>
      </div>
    </div>
  );
}
