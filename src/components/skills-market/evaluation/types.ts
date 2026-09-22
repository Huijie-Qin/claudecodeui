export type EvalCase = { id: number; prompt: string; expected_output: string; files?: string[]; expectations?: string[] };
export type CaseRun = { caseId: number; status: string; reason?: string };
export type EvaluationJob = {
  id: string; generation: number; version?: number; name: string; mode: 'run-all' | 'optimize'; status: string; phase: string;
  outcome: string; iteration: number; maxIterations: number; stopReason?: string; error?: string;
  current?: boolean; writebackStatus: string; createdAt: string;
  budget: { costUsd: number; remainingUsd: number; calls: number };
  rounds: Array<{ round: number; cases: CaseRun[]; outcome?: string }>;
};
export type CaseData = { generationJob?: EvaluationJob | null; document: { skill_name: string; evals: EvalCase[] }; revision: string; contentHash: string; protectedIds: number[]; canManage?: boolean };
export type CaseReport = { testCase: EvalCase; status: string; reason?: string; phase?: string; startedAt?: string; completedAt?: string; updatedAt?: string;
  checks: Array<{ id: string; status: string; reason: string; evidenceRefs: string[] }>;
  evidence: { events: Array<{ id: string; seq: number; role: string; kind: string; text?: string; input?: string; tool?: string; parent?: string; at?: string; isError?: boolean }>; artifacts: Array<{ name: string; supported: boolean }> };
};
export function acceptLatest(previous: EvaluationJob | null, next: EvaluationJob | null) {
  if (previous && (!next || next.generation < previous.generation)) return previous;
  if (previous && next?.id === previous.id && (next.version || 0) < (previous.version || 0)) return previous;
  return next;
}
export const isActive = (job: EvaluationJob | null) => !!job && ['queued', 'running', 'cancelling'].includes(job.status);
