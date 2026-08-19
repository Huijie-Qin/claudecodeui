import { useEffect, useMemo, useState } from 'react';
import { Bot, Check, CheckCircle2, Clock3, Sparkles, WandSparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../shared/view/ui';
import type { WorkspaceSkill } from '../../components/skills-market/utils/skillFormatting';
import type { WorkspaceTool } from '../../components/tools-market/utils/toolFormatting';

import { createAgentGraphId } from './types';
import type {
  AgentNode,
  TopSkillInput,
  TopSkillJob,
  TopSkillJobInput,
  TopSkillOperation,
} from './types';
import TopSkillOptimizeDialog from './TopSkillOptimizeDialog';
import { useTopSkillJob } from './useTopSkillJob';

type AgentBuilderDialogProps = {
  open: boolean;
  agent: AgentNode | null;
  skills: WorkspaceSkill[];
  tools: WorkspaceTool[];
  inventoryLoading: boolean;
  onClose: () => void;
  onStartTopSkillJob: (operation: TopSkillOperation, input: TopSkillJobInput) => Promise<TopSkillJob>;
  onGetTopSkillJob: (jobId: string) => Promise<TopSkillJob>;
  onSubmit: (agent: AgentNode) => void;
};

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

function CapabilityOption({
  name,
  displayName,
  description,
  selected,
  disabled,
  onToggle,
}: {
  name: string;
  displayName: string;
  description?: string;
  selected: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-background">
      <label className="flex cursor-pointer items-start gap-3 p-3">
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          disabled={disabled}
          onClick={onToggle}
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
            selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card'
          } disabled:cursor-not-allowed disabled:opacity-40`}
        >
          {selected ? <Check className="h-3.5 w-3.5" /> : null}
        </button>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{displayName}</span>
          <span className="block truncate text-xs text-muted-foreground">{name}</span>
        </span>
      </label>
      {description ? (
        <details className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Details</summary>
          <p className="mt-2 whitespace-pre-wrap">{description}</p>
        </details>
      ) : null}
    </div>
  );
}

export default function AgentBuilderDialog({
  open,
  agent,
  skills,
  tools,
  inventoryLoading,
  onClose,
  onStartTopSkillJob,
  onGetTopSkillJob,
  onSubmit,
}: AgentBuilderDialogProps) {
  const { t } = useTranslation('agentGraph');
  const [name, setName] = useState('');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [workingDescription, setWorkingDescription] = useState('');
  const [businessContext, setBusinessContext] = useState('');
  const [topSkill, setTopSkill] = useState('');
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const topSkillJob = useTopSkillJob({
    startJob: onStartTopSkillJob,
    getJob: onGetTopSkillJob,
    onCompleted: (result) => setTopSkill(result.topSkill),
  });
  const resetTopSkillJob = topSkillJob.reset;

  useEffect(() => {
    if (!open) return;
    setName(agent?.name ?? '');
    setSelectedSkills(agent?.skills ?? []);
    setSelectedTools(agent?.tools ?? []);
    setWorkingDescription(agent?.workingDescription ?? '');
    setBusinessContext(agent?.businessContext ?? '');
    setTopSkill(agent?.topSkill ?? '');
    setOptimizeOpen(false);
    setError(null);
    resetTopSkillJob();
  }, [agent, open, resetTopSkillJob]);

  const availableSkills = useMemo(
    () => skills.filter((skill) => skill.enabled && skill.status !== 'invalid'),
    [skills],
  );
  const availableTools = useMemo(
    () => tools.filter((tool) => !['needs_value', 'unsupported', 'probe_failed'].includes(tool.status)),
    [tools],
  );

  if (!open) return null;

  const input: TopSkillInput = {
    name,
    skills: selectedSkills,
    tools: selectedTools,
    workingDescription,
    businessContext,
  };

  const handleGenerate = async () => {
    if (!name.trim() || !workingDescription.trim()) {
      setError(t('builder.validation.nameAndDescription'));
      return;
    }
    setError(null);
    try {
      await topSkillJob.start('generate', input);
    } catch {
      // The shared job hook exposes the request error in the non-blocking status area.
    }
  };

  const handleOptimize = async (optimizationPrompt: string) => {
    await topSkillJob.start('optimize', { ...input, currentTopSkill: topSkill, optimizationPrompt });
  };

  const handleSubmit = () => {
    if (!name.trim() || !workingDescription.trim() || !topSkill.trim()) {
      setError(t('builder.validation.required'));
      return;
    }
    onSubmit({
      id: agent?.id ?? createAgentGraphId(),
      name: name.trim(),
      topSkill: topSkill.trim(),
      skills: selectedSkills,
      tools: selectedTools,
      position: agent?.position ?? { x: 120, y: 120 },
      workingDescription: workingDescription.trim(),
      businessContext: businessContext.trim(),
    });
  };

  return (
    <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-background/80 p-3 backdrop-blur-sm">
      <div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground">{agent ? t('builder.editTitle') : t('builder.createTitle')}</h2>
              <p className="text-xs text-muted-foreground">{t('builder.subtitle')}</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-9 w-9 p-0">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-2 lg:overflow-hidden">
          <div className="space-y-5 overflow-y-auto border-b border-border p-5 lg:border-b-0 lg:border-r">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-foreground">{t('builder.name')}</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('builder.namePlaceholder')} />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-foreground">{t('builder.workingDescription')}</span>
              <textarea
                value={workingDescription}
                onChange={(event) => setWorkingDescription(event.target.value)}
                placeholder={t('builder.workingDescriptionPlaceholder')}
                rows={5}
                className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-foreground">{t('builder.businessContext')}</span>
              <textarea
                value={businessContext}
                onChange={(event) => setBusinessContext(event.target.value)}
                placeholder={t('builder.businessContextPlaceholder')}
                rows={3}
                className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              />
            </label>

            <section className="space-y-2">
              <div>
                <h3 className="text-sm font-medium text-foreground">{t('builder.skills')}</h3>
                <p className="text-xs text-muted-foreground">{t('builder.skillsDescription')}</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {availableSkills.map((skill) => (
                  <CapabilityOption
                    key={skill.name}
                    name={skill.name}
                    displayName={skill.displayName || skill.name}
                    description={skill.description}
                    selected={selectedSkills.includes(skill.name)}
                    onToggle={() => setSelectedSkills((current) => toggleValue(current, skill.name))}
                  />
                ))}
              </div>
              {!inventoryLoading && availableSkills.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">{t('builder.noSkills')}</p>
              ) : null}
            </section>

            <section className="space-y-2">
              <div>
                <h3 className="text-sm font-medium text-foreground">{t('builder.tools')}</h3>
                <p className="text-xs text-muted-foreground">{t('builder.toolsDescription')}</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {availableTools.map((tool) => (
                  <CapabilityOption
                    key={tool.id}
                    name={tool.name}
                    displayName={tool.displayName || tool.name}
                    description={tool.description}
                    selected={selectedTools.includes(tool.name)}
                    onToggle={() => setSelectedTools((current) => toggleValue(current, tool.name))}
                  />
                ))}
              </div>
              {!inventoryLoading && availableTools.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">{t('builder.noTools')}</p>
              ) : null}
            </section>
          </div>

          <div className="flex min-h-[520px] flex-col gap-3 p-5 lg:min-h-0">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-foreground">{t('builder.topSkill')}</h3>
                <p className="text-xs text-muted-foreground">{t('builder.topSkillDescription')}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {topSkill ? (
                  <Button variant="outline" size="sm" onClick={() => setOptimizeOpen(true)} disabled={topSkillJob.active}>
                    <WandSparkles className="mr-2 h-4 w-4" />
                    {t('actions.optimize')}
                  </Button>
                ) : null}
                <Button variant="outline" size="sm" onClick={() => void handleGenerate()} disabled={topSkillJob.active}>
                  {topSkillJob.active ? <Clock3 className="mr-2 h-4 w-4" /> : <Sparkles className="mr-2 h-4 w-4" />}
                  {topSkill ? t('builder.regenerate') : t('builder.generate')}
                </Button>
              </div>
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
              onChange={(event) => setTopSkill(event.target.value)}
              placeholder={t('builder.topSkillPlaceholder')}
              className="min-h-[380px] flex-1 resize-none rounded-lg border border-input bg-background p-3 font-mono text-xs leading-5 text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
            {(error || topSkillJob.error) ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error || topSkillJob.error}</p> : null}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <Button variant="outline" onClick={onClose}>{t('actions.cancel')}</Button>
          <Button onClick={handleSubmit}>{agent ? t('actions.updateAgent') : t('actions.addAgent')}</Button>
        </div>
      </div>
      <TopSkillOptimizeDialog
        open={optimizeOpen}
        onClose={() => setOptimizeOpen(false)}
        onSubmit={handleOptimize}
      />
    </div>
  );
}
