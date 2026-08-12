export type AgentPosition = {
  x: number;
  y: number;
};

export type AgentNode = {
  id: string;
  name: string;
  topSkill: string;
  skills: string[];
  tools: string[];
  position: AgentPosition;
  workingDescription: string;
  businessContext: string;
};

export type AgentRelation = {
  id: string;
  sourceAgent: string;
  targetAgent: string;
  description: string;
};

export type AgentGraph = {
  id: string;
  name: string;
  goal: string;
  agents: AgentNode[];
  relations: AgentRelation[];
};

export type AgentGraphsResponse = {
  workspaceId: number;
  accessRole: 'owner' | 'edit' | 'view';
  canManage: boolean;
  executorConfig: AgentGraphExecutorConfig;
  graphs: AgentGraph[];
};

export type AgentGraphExecutorConfig = {
  version: number;
  executionModel: string;
  relationSemantics: string;
  communicationModel: string;
  activationPolicy: {
    mode: string;
    evaluatedEveryIteration: boolean;
    considers: string[];
    relationIsExecutionEdge: boolean;
  };
  completionPolicy: {
    evaluatedAfterEveryAgentResult: boolean;
    controllerMayCallTools: boolean;
    controllerMaySynthesizeBusinessAnswer: boolean;
    finalResultSource: string;
    requiresUserReadyDeliverable: boolean;
    skipsIrrelevantAgents: boolean;
  };
  sessionPolicy: {
    activationController: string;
    completionController: string;
    agentSessionScope: string;
    reuseAgentSessionWithinExecution: boolean;
    reuseAgentSessionAcrossExecutions: boolean;
  };
  contextPolicy: {
    executionContextStoresFullAgentOutput: boolean;
    agentResultsStoredSeparately: boolean;
    findingsStoredSeparately: boolean;
    artifactsStoredInExecutionWorkspace: boolean;
    agentInputBuiltPerActivation: boolean;
  };
  safetyLimits: {
    maxIterations: number;
    defaultMaxIterations: number;
    maximumConfigurableIterations: number;
    maxConsecutiveSameAgentActivations: number;
    maxStaleIterations: number;
    maxTraceEvents: number;
    maxInputBytes: number;
  };
  runtime: {
    provider: string;
    activationDecisionMaxTurns: number;
    completionDecisionMaxTurns: number;
    agentMaxTurns: number;
    agentMaxToolCalls: number;
    structuredAgentResult: boolean;
    controllerSessionsPersisted: boolean;
    agentSessionsPersisted: boolean;
    agentSessionsReusedWithinExecution: boolean;
    agentSessionsReusedAcrossExecutions: boolean;
  };
  toolBindingAliases: Record<string, string>;
  tracePolicy: {
    recordsStepInputAndOutput: boolean;
    redactsSensitiveValues: boolean;
    capturesAgentInternalReasoning: boolean;
    capturesGraphControlPlane: boolean;
  };
};

export type TopSkillInput = Pick<
  AgentNode,
  'name' | 'skills' | 'tools' | 'workingDescription' | 'businessContext'
>;

export type TopSkillResponse = {
  topSkill: string;
  generator: 'skill-creator';
  source: string;
};

export type TopSkillOperation = 'generate' | 'optimize';

export type TopSkillOptimizationInput = TopSkillInput & {
  currentTopSkill: string;
  optimizationPrompt: string;
};

export type TopSkillJob = {
  id: string;
  operation: TopSkillOperation;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result?: TopSkillResponse;
  error?: string;
};

export type TopSkillJobInput = TopSkillInput | TopSkillOptimizationInput;

export type AgentGraphRunStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type AgentGraphRunAgentStatus = 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled';

export type AgentGraphRunResult = {
  resultId: string;
  executionId: string;
  agentId: string;
  agentName: string;
  activation: number;
  status: 'running' | 'completed' | 'failed' | 'partial';
  message: string;
  artifacts: AgentGraphArtifactReference[];
  findings: AgentGraphResultFinding[];
  questions: string[];
  createdAt: string;
};

export type AgentGraphArtifactReference = {
  artifactId: string;
  type: 'dataset' | 'file' | 'report' | 'other';
  description: string;
};

export type AgentGraphResultFinding = {
  id: string;
  content: string;
  sourceArtifacts: string[];
  confidence: number;
};

export type AgentGraphFinding = AgentGraphResultFinding & {
  executionId: string;
  sourceAgentId: string;
  sourceAgent: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AgentGraphArtifact = {
  artifactId: string;
  executionId: string;
  type: AgentGraphArtifactReference['type'];
  name: string;
  location: string;
  producerAgentId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AgentGraphArtifactRead = {
  artifact: AgentGraphArtifact;
  offset: number;
  nextOffset: number;
  complete: boolean;
  encoding: 'utf8' | 'base64';
  content: string;
};

export type AgentGraphAgentSessionStatus = 'starting' | 'active' | 'ended' | 'failed';

export type AgentGraphAgentSession = {
  agentId: string;
  agentName: string;
  providerSessionId: string | null;
  status: AgentGraphAgentSessionStatus;
  activationCount: number;
  createdAt: string;
  lastUsedAt: string | null;
  endedAt: string | null;
  injectedArtifactIds: string[];
  injectedFindingIds: string[];
  injectedResultIds: string[];
};

export type AgentGraphExecutionContext = {
  executionId: string;
  goal: string;
  status: AgentGraphRunStatus;
  iteration: number;
  currentNeed: string;
  artifactIds: string[];
  findingIds: string[];
  resultIds: string[];
  questions: string[];
};

export type AgentGraphRunAgentState = {
  agentId: string;
  agentName: string;
  status: AgentGraphRunAgentStatus;
  activationCount: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastResultId: string | null;
  error: string | null;
};

export type AgentGraphTraceEvent = {
  id: string;
  type: string;
  timestamp: string;
  iteration?: number;
  agentId?: string | null;
  agentName?: string;
  message?: string;
  task?: string;
  input?: unknown;
  output?: unknown;
  status?: string;
  complete?: boolean;
  limitReached?: boolean;
};

export type AgentGraphRun = {
  version: number;
  id: string;
  graphId: string;
  graphName: string;
  graphSnapshot: AgentGraph;
  status: AgentGraphRunStatus;
  input: unknown;
  maxIterations: number;
  maxActivations?: number;
  executorConfig: AgentGraphExecutorConfig;
  context: AgentGraphExecutionContext;
  resultStore: AgentGraphRunResult[];
  artifactRegistry: AgentGraphArtifact[];
  findingStore: AgentGraphFinding[];
  agentSessions: AgentGraphAgentSession[];
  agentStates: AgentGraphRunAgentState[];
  trace: AgentGraphTraceEvent[];
  finalResultId: string | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export function createAgentGraphId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `agent-graph-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
