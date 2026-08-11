import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Bot,
  LayoutGrid,
  Link2,
  Loader2,
  Plus,
  Play,
  Save,
  Settings2,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Project } from '../../types/app';
import { Button, Input } from '../../shared/view/ui';
import { useWorkspaceSkills } from '../../components/skills-market/hooks/useWorkspaceSkills';
import { useWorkspaceTools } from '../../components/tools-market/hooks/useWorkspaceTools';

import AgentBuilderDialog from './AgentBuilderDialog';
import AgentDetailsPanel from './AgentDetailsPanel';
import AgentGraphCanvas from './AgentGraphCanvas';
import GraphConfigurationPanel from './GraphConfigurationPanel';
import GraphRunDialog from './GraphRunDialog';
import GraphRuntimePanel from './GraphRuntimePanel';
import RelationDialog from './RelationDialog';
import { createAgentGraphId } from './types';
import type { AgentGraph, AgentNode, AgentRelation } from './types';
import { useAgentGraphs } from './useAgentGraphs';
import { useGraphExecution } from './useGraphExecution';

type AgentGraphStudioProps = {
  selectedProject: Project;
  readOnly: boolean;
};

function autoLayout(graph: AgentGraph): AgentGraph {
  if (graph.agents.length === 0) return graph;
  const columns = Math.ceil(Math.sqrt(graph.agents.length));
  return {
    ...graph,
    agents: graph.agents.map((agent, index) => ({
      ...agent,
      position: {
        x: 120 + (index % columns) * 330,
        y: 100 + Math.floor(index / columns) * 220,
      },
    })),
  };
}

function NewGraphDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string, goal: string) => void;
}) {
  const { t } = useTranslation('agentGraph');
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');

  useEffect(() => {
    if (open) {
      setName('');
      setGoal('');
    }
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-semibold text-foreground">{t('graph.createTitle')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('graph.createDescription')}</p>
        </div>
        <div className="space-y-4 p-5">
          <label className="block space-y-2">
            <span className="text-sm font-medium text-foreground">{t('graph.name')}</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('graph.namePlaceholder')} autoFocus />
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-medium text-foreground">{t('graph.goal')}</span>
            <textarea value={goal} onChange={(event) => setGoal(event.target.value)} rows={5} placeholder={t('graph.goalPlaceholder')} className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <Button variant="outline" onClick={onClose}>{t('actions.cancel')}</Button>
          <Button disabled={!name.trim() || !goal.trim()} onClick={() => onSubmit(name.trim(), goal.trim())}>{t('actions.createGraph')}</Button>
        </div>
      </div>
    </div>
  );
}

export default function AgentGraphStudio({ selectedProject, readOnly }: AgentGraphStudioProps) {
  const { t } = useTranslation('agentGraph');
  const workspaceId = selectedProject.workspaceId;
  const {
    graphs,
    executorConfig,
    canManage,
    isLoading,
    isSaving,
    error,
    createGraph,
    saveGraph,
    deleteGraph,
    startTopSkillJob,
    getTopSkillJob,
  } = useAgentGraphs(workspaceId);
  const skillsInventory = useWorkspaceSkills(workspaceId);
  const toolsInventory = useWorkspaceTools(workspaceId);
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null);
  const [draftGraph, setDraftGraph] = useState<AgentGraph | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [editingAgent, setEditingAgent] = useState<AgentNode | null | undefined>(undefined);
  const [showNewGraph, setShowNewGraph] = useState(false);
  const [showRelation, setShowRelation] = useState(false);
  const [showRunDialog, setShowRunDialog] = useState(false);
  const [showRuntime, setShowRuntime] = useState(false);
  const [showConfiguration, setShowConfiguration] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const execution = useGraphExecution(workspaceId, selectedGraphId);

  const effectiveReadOnly = readOnly || !canManage;

  useEffect(() => {
    if (!selectedGraphId && graphs.length > 0) {
      setSelectedGraphId(graphs[0].id);
    }
    if (selectedGraphId && !graphs.some((graph) => graph.id === selectedGraphId)) {
      setSelectedGraphId(graphs[0]?.id ?? null);
    }
  }, [graphs, selectedGraphId]);

  useEffect(() => {
    const graph = graphs.find((entry) => entry.id === selectedGraphId) ?? null;
    setDraftGraph(graph ? structuredClone(graph) : null);
    setSelectedAgentId(null);
    setShowRuntime(false);
    setShowConfiguration(false);
  }, [graphs, selectedGraphId]);

  const persistedGraph = graphs.find((graph) => graph.id === selectedGraphId) ?? null;
  const isDirty = Boolean(draftGraph && persistedGraph && JSON.stringify(draftGraph) !== JSON.stringify(persistedGraph));
  const selectedAgent = draftGraph?.agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const agentNames = useMemo(
    () => new Map(draftGraph?.agents.map((agent) => [agent.id, agent.name]) ?? []),
    [draftGraph?.agents],
  );
  const selectedRelations = useMemo(
    () => draftGraph?.relations.filter((relation) => relation.sourceAgent === selectedAgentId || relation.targetAgent === selectedAgentId) ?? [],
    [draftGraph?.relations, selectedAgentId],
  );
  const agentRunStates = useMemo(
    () => new Map(execution.run?.agentStates.map((state) => [state.agentId, state]) ?? []),
    [execution.run?.agentStates],
  );

  const updateAgent = (agent: AgentNode) => {
    setDraftGraph((current) => {
      if (!current) return current;
      const exists = current.agents.some((entry) => entry.id === agent.id);
      return {
        ...current,
        agents: exists
          ? current.agents.map((entry) => entry.id === agent.id ? agent : entry)
          : [...current.agents, { ...agent, position: { x: 120 + current.agents.length * 28, y: 120 + current.agents.length * 24 } }],
      };
    });
    setSelectedAgentId(agent.id);
    setEditingAgent(undefined);
  };

  const removeAgent = (agentId: string) => {
    if (!window.confirm(t('confirm.deleteAgent'))) return;
    setDraftGraph((current) => current ? {
      ...current,
      agents: current.agents.filter((agent) => agent.id !== agentId),
      relations: current.relations.filter((relation) => relation.sourceAgent !== agentId && relation.targetAgent !== agentId),
    } : current);
    setSelectedAgentId(null);
  };

  const addRelation = (relation: AgentRelation) => {
    setDraftGraph((current) => current ? { ...current, relations: [...current.relations, relation] } : current);
    setShowRelation(false);
  };

  const handleCreateGraph = async (name: string, goal: string) => {
    setActionError(null);
    try {
      const graph = await createGraph({
        id: createAgentGraphId(),
        name,
        goal,
        agents: [],
        relations: [],
      });
      setSelectedGraphId(graph.id);
      setShowNewGraph(false);
    } catch (createError) {
      setActionError(createError instanceof Error ? createError.message : t('errors.createGraph'));
    }
  };

  const handleSave = async () => {
    if (!draftGraph) return;
    setActionError(null);
    try {
      const saved = await saveGraph(draftGraph);
      setDraftGraph(structuredClone(saved));
    } catch (saveError) {
      setActionError(saveError instanceof Error ? saveError.message : t('errors.saveGraph'));
    }
  };

  const handleDeleteGraph = async () => {
    if (!draftGraph || !window.confirm(t('confirm.deleteGraph'))) return;
    try {
      await deleteGraph(draftGraph.id);
      setSelectedGraphId(null);
      setDraftGraph(null);
    } catch (deleteError) {
      setActionError(deleteError instanceof Error ? deleteError.message : t('errors.deleteGraph'));
    }
  };

  const handleStartRun = async (input: string, maxIterations: number) => {
    await execution.startRun(input, maxIterations);
    setShowRunDialog(false);
    setSelectedAgentId(null);
    setShowConfiguration(false);
    setShowRuntime(true);
  };

  if (isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" />{t('loading')}</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
        <select
          value={selectedGraphId ?? ''}
          onChange={(event) => setSelectedGraphId(event.target.value || null)}
          className="h-9 min-w-48 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          aria-label={t('graph.select')}
        >
          {graphs.length === 0 ? <option value="">{t('graph.none')}</option> : null}
          {graphs.map((graph) => <option key={graph.id} value={graph.id}>{graph.name}</option>)}
        </select>
        {!effectiveReadOnly ? (
          <Button variant="outline" size="sm" onClick={() => setShowNewGraph(true)}><Plus className="mr-2 h-4 w-4" />{t('actions.newGraph')}</Button>
        ) : null}
        <div className="flex-1" />
        {draftGraph ? (
          <Button
            variant={showConfiguration ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              setSelectedAgentId(null);
              setShowRuntime(false);
              setShowConfiguration(true);
            }}
          >
            <Settings2 className="mr-2 h-4 w-4" />
            {t('actions.viewConfiguration')}
          </Button>
        ) : null}
        {draftGraph && !effectiveReadOnly ? (
          <>
            <Button variant="outline" size="sm" onClick={() => setEditingAgent(null)}><Bot className="mr-2 h-4 w-4" />{t('actions.addAgent')}</Button>
            <Button variant="outline" size="sm" disabled={draftGraph.agents.length < 2} onClick={() => setShowRelation(true)}><Link2 className="mr-2 h-4 w-4" />{t('actions.addRelation')}</Button>
            <Button variant="outline" size="sm" disabled={draftGraph.agents.length === 0} onClick={() => setDraftGraph(autoLayout(draftGraph))}><LayoutGrid className="mr-2 h-4 w-4" />{t('actions.autoLayout')}</Button>
            <Button
              variant="outline"
              size="sm"
              disabled={draftGraph.agents.length === 0 || isDirty || execution.active}
              title={isDirty ? t('run.saveBeforeRun') : undefined}
              onClick={() => setShowRunDialog(true)}
            >
              <Play className="mr-2 h-4 w-4" />
              {t('actions.runGraph')}
            </Button>
            <Button size="sm" disabled={!isDirty || isSaving} onClick={() => void handleSave()}>
              {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              {t('actions.saveGraph')}
            </Button>
            <Button variant="ghost" size="sm" className="text-destructive" onClick={() => void handleDeleteGraph()}><Trash2 className="h-4 w-4" /></Button>
          </>
        ) : null}
        {draftGraph && execution.run ? (
          <Button variant={showRuntime ? 'default' : 'outline'} size="sm" onClick={() => { setSelectedAgentId(null); setShowConfiguration(false); setShowRuntime(true); }}>
            <Activity className="mr-2 h-4 w-4" />
            {execution.active ? t('actions.running') : t('actions.runDetails')}
          </Button>
        ) : null}
      </div>

      {(error || actionError || execution.error) ? (
        <div className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />{actionError || execution.error || error}
        </div>
      ) : null}

      {draftGraph ? (
        <>
          <div className="grid gap-2 border-b border-border bg-muted/20 px-4 py-3 md:grid-cols-[minmax(180px,0.35fr)_minmax(280px,1fr)]">
            <label className="space-y-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('graph.name')}</span>
              <Input value={draftGraph.name} readOnly={effectiveReadOnly} onChange={(event) => setDraftGraph({ ...draftGraph, name: event.target.value })} className="h-8" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('graph.goal')}</span>
              <Input value={draftGraph.goal} readOnly={effectiveReadOnly} onChange={(event) => setDraftGraph({ ...draftGraph, goal: event.target.value })} className="h-8" />
            </label>
          </div>
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="min-w-0 flex-1">
              <AgentGraphCanvas
                graph={draftGraph}
                selectedAgentId={selectedAgentId}
                readOnly={effectiveReadOnly}
                agentRunStates={agentRunStates}
                onSelectAgent={(agentId) => {
                  setSelectedAgentId(agentId);
                  if (agentId) setShowRuntime(false);
                  if (agentId) setShowConfiguration(false);
                }}
                onMoveAgent={(agentId, position) => setDraftGraph((current) => current ? {
                  ...current,
                  agents: current.agents.map((agent) => agent.id === agentId ? { ...agent, position } : agent),
                } : current)}
              />
            </div>
            {showConfiguration ? (
              <GraphConfigurationPanel
                graph={draftGraph}
                executorConfig={executorConfig}
                skills={skillsInventory.data?.skills ?? []}
                tools={toolsInventory.data?.tools ?? []}
                onClose={() => setShowConfiguration(false)}
              />
            ) : showRuntime && execution.run ? (
              <GraphRuntimePanel
                run={execution.run}
                recentRuns={execution.recentRuns}
                canManage={!effectiveReadOnly}
                onSelectRun={execution.selectRun}
                onCancel={() => void execution.cancelRun()}
                onClose={() => setShowRuntime(false)}
              />
            ) : selectedAgent ? (
              <AgentDetailsPanel
                agent={selectedAgent}
                relations={selectedRelations}
                agentNames={agentNames}
                readOnly={effectiveReadOnly}
                onClose={() => setSelectedAgentId(null)}
                onEdit={() => setEditingAgent(selectedAgent)}
                onDelete={() => removeAgent(selectedAgent.id)}
                onDeleteRelation={(relationId) => setDraftGraph((current) => current ? { ...current, relations: current.relations.filter((relation) => relation.id !== relationId) } : current)}
                onSaveTopSkill={(topSkill) => updateAgent({ ...selectedAgent, topSkill })}
                onTopSkillGenerated={(topSkill) => updateAgent({ ...selectedAgent, topSkill })}
                onStartTopSkillJob={startTopSkillJob}
                onGetTopSkillJob={getTopSkillJob}
              />
            ) : null}
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Bot className="h-7 w-7" /></div>
            <h2 className="mt-4 text-lg font-semibold text-foreground">{t('empty.title')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{effectiveReadOnly ? t('empty.readOnly') : t('empty.description')}</p>
            {!effectiveReadOnly ? <Button className="mt-5" onClick={() => setShowNewGraph(true)}><Plus className="mr-2 h-4 w-4" />{t('actions.createGraph')}</Button> : null}
          </div>
        </div>
      )}

      <NewGraphDialog open={showNewGraph} onClose={() => setShowNewGraph(false)} onSubmit={(name, goal) => void handleCreateGraph(name, goal)} />
      <GraphRunDialog
        open={showRunDialog}
        graphName={draftGraph?.name ?? ''}
        graphGoal={draftGraph?.goal ?? ''}
        starting={execution.isStarting}
        onClose={() => setShowRunDialog(false)}
        onSubmit={handleStartRun}
      />
      <AgentBuilderDialog
        open={editingAgent !== undefined}
        agent={editingAgent ?? null}
        skills={skillsInventory.data?.skills ?? []}
        tools={toolsInventory.data?.tools ?? []}
        inventoryLoading={skillsInventory.isLoading || toolsInventory.isLoading}
        onClose={() => setEditingAgent(undefined)}
        onStartTopSkillJob={startTopSkillJob}
        onGetTopSkillJob={getTopSkillJob}
        onSubmit={updateAgent}
      />
      <RelationDialog
        open={showRelation}
        agents={draftGraph?.agents ?? []}
        initialSourceId={selectedAgentId}
        onClose={() => setShowRelation(false)}
        onSubmit={addRelation}
      />
    </div>
  );
}
