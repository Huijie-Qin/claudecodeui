import { useRef, useState } from 'react';
import { Activity, Bot, CheckCircle2, Clock3, Minus, Move, OctagonX, Plus, XCircle } from 'lucide-react';

import { Button } from '../../shared/view/ui';

import type { AgentGraph, AgentGraphRunAgentState, AgentNode } from './types';

type AgentGraphCanvasProps = {
  graph: AgentGraph;
  selectedAgentId: string | null;
  readOnly: boolean;
  agentRunStates?: Map<string, AgentGraphRunAgentState>;
  onSelectAgent: (agentId: string | null) => void;
  onMoveAgent: (agentId: string, position: AgentNode['position']) => void;
};

type Viewport = { x: number; y: number; scale: number };
type DragState = {
  agentId: string;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
};

const NODE_WIDTH = 220;
const NODE_HEIGHT = 112;
const WORLD_WIDTH = 4000;
const WORLD_HEIGHT = 2600;

function clampScale(value: number) {
  return Math.min(1.8, Math.max(0.35, value));
}

export default function AgentGraphCanvas({
  graph,
  selectedAgentId,
  readOnly,
  agentRunStates,
  onSelectAgent,
  onMoveAgent,
}: AgentGraphCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const panRef = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 60, y: 60, scale: 1 });

  const updateScale = (nextScale: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const scale = clampScale(nextScale);
    setViewport((current) => ({
      x: centerX - ((centerX - current.x) / current.scale) * scale,
      y: centerY - ((centerY - current.y) / current.scale) * scale,
      scale,
    }));
  };

  return (
    <div
      ref={canvasRef}
      className="relative h-full min-h-[420px] overflow-hidden bg-muted/20"
      style={{
        backgroundImage: 'radial-gradient(hsl(var(--border)) 1px, transparent 1px)',
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
        backgroundSize: `${24 * viewport.scale}px ${24 * viewport.scale}px`,
      }}
      onWheel={(event) => {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        setViewport((current) => {
          const scale = clampScale(current.scale * (event.deltaY > 0 ? 0.9 : 1.1));
          const worldX = (mouseX - current.x) / current.scale;
          const worldY = (mouseY - current.y) / current.scale;
          return {
            x: mouseX - worldX * scale,
            y: mouseY - worldY * scale,
            scale,
          };
        });
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.target !== event.currentTarget) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        panRef.current = { x: viewport.x, y: viewport.y, clientX: event.clientX, clientY: event.clientY };
        onSelectAgent(null);
      }}
      onPointerMove={(event) => {
        const pan = panRef.current;
        if (!pan) return;
        setViewport((current) => ({
          ...current,
          x: pan.x + event.clientX - pan.clientX,
          y: pan.y + event.clientY - pan.clientY,
        }));
      }}
      onPointerUp={() => {
        panRef.current = null;
      }}
      onPointerCancel={() => {
        panRef.current = null;
      }}
    >
      <div
        className="pointer-events-none absolute left-0 top-0"
        style={{
          width: WORLD_WIDTH,
          height: WORLD_HEIGHT,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          transformOrigin: '0 0',
        }}
      >
        <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
          {graph.relations.map((relation) => {
            const source = graph.agents.find((agent) => agent.id === relation.sourceAgent);
            const target = graph.agents.find((agent) => agent.id === relation.targetAgent);
            if (!source || !target) return null;
            const x1 = source.position.x + NODE_WIDTH / 2;
            const y1 = source.position.y + NODE_HEIGHT / 2;
            const x2 = target.position.x + NODE_WIDTH / 2;
            const y2 = target.position.y + NODE_HEIGHT / 2;
            const bend = Math.max(36, Math.abs(x2 - x1) * 0.18);
            const path = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
            return (
              <g key={relation.id}>
                <path d={path} fill="none" stroke="hsl(var(--muted-foreground))" strokeOpacity="0.55" strokeWidth="2" strokeDasharray="7 6" />
                <circle cx={x1} cy={y1} r="4" fill="hsl(var(--primary))" />
                <circle cx={x2} cy={y2} r="4" fill="hsl(var(--primary))" />
                <foreignObject x={(x1 + x2) / 2 - 85} y={(y1 + y2) / 2 - 18} width="170" height="36">
                  <div className="truncate rounded-full border border-border bg-background/95 px-3 py-1 text-center text-[11px] text-muted-foreground shadow-sm">
                    {relation.description}
                  </div>
                </foreignObject>
              </g>
            );
          })}
        </svg>

        {graph.agents.map((agent) => {
          const selected = agent.id === selectedAgentId;
          const runState = agentRunStates?.get(agent.id);
          const runtimeBorder = runState?.status === 'running'
            ? 'border-primary ring-2 ring-primary/25'
            : runState?.status === 'completed'
              ? 'border-emerald-500/70'
              : runState?.status === 'failed'
                ? 'border-destructive/70'
                : '';
          return (
            <button
              key={agent.id}
              type="button"
              className={`pointer-events-auto absolute overflow-hidden rounded-xl border bg-card text-left shadow-md transition-shadow ${
                runtimeBorder || (selected ? 'border-primary ring-2 ring-primary/20' : 'border-border hover:border-primary/50 hover:shadow-lg')
              } ${readOnly ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'}`}
              style={{
                left: agent.position.x,
                top: agent.position.y,
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
              }}
              onClick={() => onSelectAgent(agent.id)}
              onPointerDown={(event) => {
                event.stopPropagation();
                onSelectAgent(agent.id);
                if (readOnly || event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                dragRef.current = {
                  agentId: agent.id,
                  startClientX: event.clientX,
                  startClientY: event.clientY,
                  startX: agent.position.x,
                  startY: agent.position.y,
                };
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (!drag || drag.agentId !== agent.id) return;
                onMoveAgent(agent.id, {
                  x: Math.max(0, Math.min(WORLD_WIDTH - NODE_WIDTH, drag.startX + (event.clientX - drag.startClientX) / viewport.scale)),
                  y: Math.max(0, Math.min(WORLD_HEIGHT - NODE_HEIGHT, drag.startY + (event.clientY - drag.startClientY) / viewport.scale)),
                });
              }}
              onPointerUp={() => {
                dragRef.current = null;
              }}
              onPointerCancel={() => {
                dragRef.current = null;
              }}
            >
              <div className="flex items-center gap-2 border-b border-border bg-primary/5 px-3 py-2">
                <Bot className="h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{agent.name}</span>
                {runState?.status === 'running' ? <Activity className="h-4 w-4 shrink-0 text-primary" /> : null}
                {runState?.status === 'completed' ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" /> : null}
                {runState?.status === 'failed' ? <XCircle className="h-4 w-4 shrink-0 text-destructive" /> : null}
                {runState?.status === 'cancelled' ? <OctagonX className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
                {runState?.status === 'waiting' ? <Clock3 className="h-4 w-4 shrink-0 text-amber-500" /> : null}
              </div>
              <div className="grid grid-cols-2 gap-2 px-3 py-3 text-xs text-muted-foreground">
                <span className="rounded-md bg-muted px-2 py-1">{agent.skills.length} Skills</span>
                <span className="rounded-md bg-muted px-2 py-1">{agent.tools.length} Tools</span>
                <span className="col-span-2 truncate text-[11px]">{runState ? `${runState.status} · ${runState.activationCount}` : 'Top Skill · generated'}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="absolute bottom-4 left-4 flex items-center gap-1 rounded-lg border border-border bg-background/95 p-1 shadow-md">
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => updateScale(viewport.scale - 0.15)}>
          <Minus className="h-4 w-4" />
        </Button>
        <span className="w-12 text-center text-xs text-muted-foreground">{Math.round(viewport.scale * 100)}%</span>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => updateScale(viewport.scale + 0.15)}>
          <Plus className="h-4 w-4" />
        </Button>
        <span className="mx-1 h-5 w-px bg-border" />
        <Move className="mx-1 h-4 w-4 text-muted-foreground" />
      </div>
    </div>
  );
}
