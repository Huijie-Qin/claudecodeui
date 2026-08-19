import { Bot, Link2, Settings2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { WorkspaceSkill } from '../../components/skills-market/utils/skillFormatting';
import type { WorkspaceTool } from '../../components/tools-market/utils/toolFormatting';
import { Button } from '../../shared/view/ui';

import type { AgentGraph, AgentGraphExecutorConfig } from './types';

type GraphConfigurationPanelProps = {
  graph: AgentGraph;
  executorConfig: AgentGraphExecutorConfig | null;
  skills: WorkspaceSkill[];
  tools: WorkspaceTool[];
  onClose: () => void;
};

function ConfigRow({ label, value }: { label: string; value: string | number | boolean }) {
  return (
    <div className="grid grid-cols-[minmax(130px,0.42fr)_minmax(0,1fr)] gap-3 border-b border-border/60 py-2 last:border-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-xs font-medium text-foreground">{String(value)}</dd>
    </div>
  );
}

function StatusBadge({ children, healthy = false }: { children: ReactNode; healthy?: boolean }) {
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${healthy
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : 'border-border bg-muted/40 text-muted-foreground'}`}
    >
      {children}
    </span>
  );
}

export default function GraphConfigurationPanel({
  graph,
  executorConfig,
  skills,
  tools,
  onClose,
}: GraphConfigurationPanelProps) {
  const { t } = useTranslation('agentGraph');
  const agentNames = new Map(graph.agents.map((agent) => [agent.id, agent.name]));
  const skillByName = new Map(skills.map((skill) => [skill.name, skill]));
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
  const aliases = executorConfig?.toolBindingAliases || {};

  return (
    <aside className="flex h-full w-full max-w-[620px] shrink-0 flex-col border-l border-border bg-card shadow-xl">
      <div className="flex items-start justify-between border-b border-border px-4 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-primary">
            <Settings2 className="h-4 w-4" />
            <p className="text-xs font-medium uppercase tracking-wider">{t('configuration.title')}</p>
          </div>
          <h2 className="mt-1 truncate text-base font-semibold text-foreground">{graph.name}</h2>
          <p className="mt-1 break-all text-[11px] text-muted-foreground">Graph ID: {graph.id}</p>
        </div>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">{t('configuration.agents')}</h3>
          </div>
          {graph.agents.map((agent, index) => (
            <details key={agent.id} open={index === 0} className="rounded-lg border border-border bg-background">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3">
                <span className="text-sm font-medium text-foreground">{agent.name}</span>
                <span className="text-[10px] text-muted-foreground">{agent.skills.length} Skills · {agent.tools.length} Tools</span>
              </summary>
              <div className="space-y-4 border-t border-border p-3">
                <dl>
                  <ConfigRow label="Agent ID" value={agent.id} />
                  <ConfigRow label={t('builder.workingDescription')} value={agent.workingDescription || '—'} />
                  <ConfigRow label={t('builder.businessContext')} value={agent.businessContext || '—'} />
                  <ConfigRow label="Position" value={`x=${agent.position.x}, y=${agent.position.y}`} />
                </dl>
                <div>
                  <p className="mb-2 text-xs font-semibold text-foreground">Skills</p>
                  <div className="flex flex-wrap gap-1.5">
                    {agent.skills.length ? agent.skills.map((name) => {
                      const skill = skillByName.get(name);
                      return <StatusBadge key={name} healthy={Boolean(skill?.enabled && skill.status !== 'invalid')}>{name} · {skill?.status || 'unresolved'}</StatusBadge>;
                    }) : <span className="text-xs text-muted-foreground">—</span>}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-xs font-semibold text-foreground">Tools / MCP</p>
                  <div className="space-y-1.5">
                    {agent.tools.length ? agent.tools.map((binding) => {
                      const resolvedName = toolByName.has(binding) ? binding : aliases[binding];
                      const tool = resolvedName ? toolByName.get(resolvedName) : undefined;
                      return (
                        <div key={binding} className="flex flex-wrap items-center gap-2 rounded-md bg-muted/30 px-2.5 py-2 text-xs">
                          <span className="font-medium text-foreground">{binding}</span>
                          {resolvedName && resolvedName !== binding ? <span className="text-muted-foreground">→ {resolvedName}</span> : null}
                          <StatusBadge healthy={tool?.status === 'healthy'}>{tool?.status || 'unresolved'}</StatusBadge>
                        </div>
                      );
                    }) : <span className="text-xs text-muted-foreground">—</span>}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-xs font-semibold text-foreground">Top Skill</p>
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/20 p-3 text-[11px] leading-5 text-foreground">{agent.topSkill}</pre>
                </div>
              </div>
            </details>
          ))}
        </section>

        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">{t('configuration.relations')}</h3>
          </div>
          {graph.relations.length ? graph.relations.map((relation) => (
            <div key={relation.id} className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs font-medium text-foreground">
                {agentNames.get(relation.sourceAgent) || relation.sourceAgent} → {agentNames.get(relation.targetAgent) || relation.targetAgent}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{relation.description}</p>
              <p className="mt-2 break-all text-[10px] text-muted-foreground">{relation.id}</p>
            </div>
          )) : <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">—</p>}
        </section>

        <details className="rounded-lg border border-border bg-background">
          <summary className="cursor-pointer px-3 py-3 text-xs font-semibold text-foreground">{t('configuration.raw')}</summary>
          <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap border-t border-border p-3 text-[10px] leading-5 text-foreground">{JSON.stringify({ graph, executorConfig }, null, 2)}</pre>
        </details>
      </div>
    </aside>
  );
}
