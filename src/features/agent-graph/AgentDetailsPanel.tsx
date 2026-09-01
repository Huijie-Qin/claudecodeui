import { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, Edit3, RefreshCw, Trash2, WandSparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';

import TopSkillOptimizeDialog from './TopSkillOptimizeDialog';
import type {
  AgentNode,
  AgentRelation,
  TopSkillJob,
  TopSkillJobInput,
  TopSkillOperation,
} from './types';
import { useTopSkillJob } from './useTopSkillJob';

type AgentDetailsPanelProps = {
  agent: AgentNode;
  relations: AgentRelation[];
  agentNames: Map<string, string>;
  readOnly: boolean;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDeleteRelation: (relationId: string) => void;
  onSaveTopSkill: (topSkill: string) => void;
  onTopSkillGenerated: (topSkill: string) => void;
  onStartTopSkillJob: (operation: TopSkillOperation, input: TopSkillJobInput) => Promise<TopSkillJob>;
  onGetTopSkillJob: (jobId: string) => Promise<TopSkillJob>;
};

export default function AgentDetailsPanel({
  agent,
  relations,
  agentNames,
  readOnly,
  onClose,
  onEdit,
  onDelete,
  onDeleteRelation,
  onSaveTopSkill,
  onTopSkillGenerated,
  onStartTopSkillJob,
  onGetTopSkillJob,
}: AgentDetailsPanelProps) {
  const { t } = useTranslation('agentGraph');
  const [topSkill, setTopSkill] = useState(agent.topSkill);
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const topSkillJob = useTopSkillJob({
    startJob: onStartTopSkillJob,
    getJob: onGetTopSkillJob,
    onCompleted: (result) => {
      setTopSkill(result.topSkill);
      onTopSkillGenerated(result.topSkill);
    },
  });
  const resetTopSkillJob = topSkillJob.reset;

  useEffect(() => {
    setTopSkill(agent.topSkill);
  }, [agent.topSkill]);

  useEffect(() => {
    setOptimizeOpen(false);
    resetTopSkillJob();
  }, [agent.id, resetTopSkillJob]);

  const handleRegenerate = async () => {
    try {
      await topSkillJob.start('generate', agent);
    } catch {
      // The shared job hook exposes the request error below the editor.
    }
  };

  const handleOptimize = async (optimizationPrompt: string) => {
    await topSkillJob.start('optimize', {
      ...agent,
      currentTopSkill: topSkill,
      optimizationPrompt,
    });
  };

  return (
    <aside className="flex h-full w-full max-w-[420px] shrink-0 flex-col border-l border-border bg-card shadow-xl">
      <div className="flex items-start justify-between border-b border-border px-4 py-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-primary">Agent</p>
          <h2 className="truncate text-base font-semibold text-foreground">{agent.name}</h2>
        </div>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">{t('details.basicInfo')}</h3>
            {!readOnly ? (
              <Button variant="ghost" size="sm" onClick={onEdit}>
                <Edit3 className="mr-2 h-3.5 w-3.5" />
                {t('actions.edit')}
              </Button>
            ) : null}
          </div>
          <p className="whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            {agent.workingDescription}
          </p>
        </section>

        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-foreground">{t('details.topSkill')}</h3>
              <p className="text-xs text-muted-foreground">{t('details.generated')}</p>
            </div>
            {!readOnly ? (
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setOptimizeOpen(true)} disabled={topSkillJob.active}>
                  <WandSparkles className="mr-2 h-3.5 w-3.5" />
                  {t('actions.optimize')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => void handleRegenerate()} disabled={topSkillJob.active}>
                  {topSkillJob.active ? <Clock3 className="mr-2 h-3.5 w-3.5" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                  {t('actions.regenerate')}
                </Button>
              </div>
            ) : null}
          </div>
          {topSkillJob.active ? (
            <p className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-primary">
              <Clock3 className="h-3.5 w-3.5 shrink-0" />
              {topSkillJob.job?.operation === 'optimize' ? t('job.optimizing') : t('job.generating')}
            </p>
          ) : null}
          {topSkillJob.job?.status === 'succeeded' ? (
            <p className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {topSkillJob.job.operation === 'optimize' ? t('job.optimizeComplete') : t('job.generateComplete')}
            </p>
          ) : null}
          <textarea
            value={topSkill}
            readOnly={readOnly}
            onChange={(event) => setTopSkill(event.target.value)}
            className="min-h-[330px] w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-xs leading-5 text-foreground outline-none read-only:cursor-default read-only:bg-muted/30 focus:border-primary focus:ring-1 focus:ring-primary"
          />
          {!readOnly && topSkill !== agent.topSkill ? (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setTopSkill(agent.topSkill)}>{t('actions.cancel')}</Button>
              <Button size="sm" onClick={() => onSaveTopSkill(topSkill)}>{t('actions.saveTopSkill')}</Button>
            </div>
          ) : null}
          {topSkillJob.error ? <p className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">{topSkillJob.error}</p> : null}
        </section>

        <CapabilityList title={t('details.skills')} items={agent.skills} empty={t('details.noSkills')} />
        <CapabilityList title={t('details.tools')} items={agent.tools} empty={t('details.noTools')} />

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{t('details.relations')}</h3>
          {relations.length ? (
            <div className="space-y-2">
              {relations.map((relation) => {
                const otherId = relation.sourceAgent === agent.id ? relation.targetAgent : relation.sourceAgent;
                return (
                  <div key={relation.id} className="rounded-lg border border-border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{agentNames.get(otherId) || otherId}</p>
                        <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{relation.description}</p>
                      </div>
                      {!readOnly ? (
                        <Button variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0 text-destructive" onClick={() => onDeleteRelation(relation.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">{t('details.noRelations')}</p>
          )}
        </section>
      </div>

      {!readOnly ? (
        <div className="border-t border-border p-4">
          <Button variant="outline" className="w-full text-destructive hover:bg-destructive/10" onClick={onDelete}>
            <Trash2 className="mr-2 h-4 w-4" />
            {t('actions.deleteAgent')}
          </Button>
        </div>
      ) : null}
      <TopSkillOptimizeDialog
        open={optimizeOpen}
        onClose={() => setOptimizeOpen(false)}
        onSubmit={handleOptimize}
      />
    </aside>
  );
}

function CapabilityList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {items.length ? (
        <div className="flex flex-wrap gap-2">
          {items.map((item) => <span key={item} className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-foreground">{item}</span>)}
        </div>
      ) : <p className="text-xs text-muted-foreground">{empty}</p>}
    </section>
  );
}
