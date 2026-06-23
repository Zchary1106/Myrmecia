export type AgentRole = string;

export interface AgentStats {
  tasksCompleted: number;
  tasksFailed: number;
  avgDurationMs: number;
  lastActiveAt?: string;
}

export interface AgentConfig {
  model?: string;
  modelPolicy?: AgentModelPolicy;
  maxConcurrent?: number;
  timeout?: number;
  workdir?: string;
  maxTurns?: number;
  allowNetwork?: boolean;
  allowedTools?: string[];
}

export interface AgentDefinition {
  id: string;
  name: string;
  role: AgentRole;
  emoji: string;
  description?: string;
  whenToUse: string;
  skillPath?: string;
  config: AgentConfig;
  capabilities: string[];
  triggers: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
  stats: AgentStats;
  createdAt: string;
  updatedAt: string;
}

export type Agent = AgentDefinition;

export interface AgentSummary extends AgentDefinition {
  activeExecutions: number;
}

export interface DomainRetrievalConfig {
  enabled: boolean;
  topK: number;
  minScore: number;
}

/**
 * A Domain Pack turns the platform into a domain-specialized assistant:
 * a persona + guidelines + disclaimer overlay injected into the system prompt,
 * plus an optional knowledge base retrieved and injected at execution time.
 * Built-ins come from agents/domains.yaml; custom packs live in the DB and
 * override built-ins with the same id.
 */
export interface DomainPack {
  id: string;
  name: string;
  emoji: string;
  persona: string;
  guidelines: string[];
  terminology: Record<string, string>;
  disclaimer?: string;
  tone?: string;
  retrieval: DomainRetrievalConfig;
  /** Knowledge document ids bound to this domain (retrieval scope). */
  knowledgeIds: string[];
  /** Agent ids for which this domain is enabled. */
  agentIds: string[];
  workspaceId?: string;
  /** true for domains.yaml defaults (not deletable, only override-able). */
  builtin?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface DomainPackInput {
  id?: string;
  name: string;
  emoji?: string;
  persona: string;
  guidelines?: string[];
  terminology?: Record<string, string>;
  disclaimer?: string;
  tone?: string;
  retrieval?: Partial<DomainRetrievalConfig>;
  knowledgeIds?: string[];
  agentIds?: string[];
}

export type SkillVersionStatus = 'draft' | 'published' | 'archived';

export interface SkillDefinition {
  id: string;
  name: string;
  description?: string;
  sourcePath?: string;
  latestVersionId?: string;
  publishedVersionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillVersion {
  id: string;
  skillId: string;
  version: number;
  status: SkillVersionStatus;
  content: string;
  checksum: string;
  changelog?: string;
  createdBy: string;
  publishedBy?: string;
  createdAt: string;
  publishedAt?: string;
  archivedAt?: string;
}

export interface SkillAssignment {
  agentId: string;
  skillId: string;
  skillVersionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillDetail extends SkillDefinition {
  versions: SkillVersion[];
  assignments: SkillAssignment[];
}

export interface SkillStepValidation {
  /** Shell command to run. Supports ${workdir}, ${output}, ${stepName} variables */
  command: string;
  /** Message shown on validation failure */
  failMessage?: string;
}

export interface SkillStep {
  name: string;
  instruction: string;
  tools?: string[];
  maxTurns?: number;
  maxRetries?: number;
  validation?: SkillStepValidation;
}

export interface SkillExecutorConfig {
  executor: 'step-driven';
  trigger?: {
    keywords?: string[];
    taskModes?: string[];
    agentRoles?: string[];
  };
  steps: SkillStep[];
  recovery?: {
    onStepFailure?: 'retry_then_skip' | 'retry_then_fail' | 'skip' | 'fail';
    maxTotalRetries?: number;
  };
}

export type TaskMode = 'master' | 'direct' | 'pipeline';
export type TaskStatus = 'pending' | 'queued' | 'assigned' | 'running' | 'review' | 'done' | 'failed' | 'cancelled';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export interface Task {
  id: string;
  title: string;
  description: string;
  mode: TaskMode;
  status: TaskStatus;
  priority: Priority;
  assigneeId?: string;
  createdBy: 'user' | 'master';
  parentTaskId?: string;
  pipelineId?: string;
  stageIndex?: number;
  input: string;
  output?: string;
  workdir?: string;
  workspacePath?: string;
  workspaceId?: string;
  /** Optional Domain Pack id — injects domain persona + knowledge at execution. */
  domainId?: string;
  error?: string;
  retryCount: number;
  maxRetries: number;
  dependsOn: string[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface LogEntry {
  id: number;
  taskId: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source: string;
  createdAt: string;
}

export type ExecutionStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface ToolActivity {
  toolName: string;
  input: Record<string, unknown>;
  activityDescription?: string;
  isSearch?: boolean;
  isRead?: boolean;
  timestamp: string;
}

export type ToolRiskLevel = 'low' | 'medium' | 'high';
export type ToolExecutionStatus = 'running' | 'done' | 'failed' | 'blocked';

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  riskLevel: ToolRiskLevel;
  enabled: boolean;
  approvalRequired: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ToolPermission {
  toolId: string;
  agentId: string;
  enabled: boolean;
  approvalRequired?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ToolExecution {
  id: string;
  toolId: string;
  toolVersionId?: string;
  taskId?: string;
  executionId?: string;
  agentId?: string;
  status: ToolExecutionStatus;
  inputSummary?: string;
  inputHash?: string;
  outputSummary?: string;
  error?: string;
  durationMs?: number;
  startedAt: string;
  completedAt?: string;
}

export type RunTraceStatus = 'running' | 'done' | 'failed' | 'cancelled';
export type TraceSpanStatus = 'running' | 'done' | 'failed' | 'blocked';

export interface TraceSpan {
  id: string;
  traceId: string;
  parentSpanId?: string;
  type: string;
  name: string;
  status: TraceSpanStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  metadata: Record<string, unknown>;
  error?: string;
}

export interface RunTrace {
  id: string;
  taskId: string;
  executionId: string;
  agentId: string;
  status: RunTraceStatus;
  startedAt: string;
  completedAt?: string;
  summary?: string;
  spans: TraceSpan[];
}

export type ModelHealthStatus = 'unknown' | 'healthy' | 'degraded' | 'disabled';
export type ModelTier = 'strong' | 'balanced' | 'cheap' | 'fallback';

export interface AgentModelPolicy {
  tier?: ModelTier;
  preferredModel?: string;
  fallbackModel?: string;
  maxTokens?: number;
  maxResponseTokens?: number;
  maxToolCalls?: number;
  maxWallClockMs?: number;
  escalateOn?: string[];
}

export interface ModelDefinition {
  id: string;
  provider: string;
  displayName: string;
  description: string;
  capabilityTags: string[];
  costProfile: Record<string, unknown>;
  maxTokens?: number;
  enabled: boolean;
  priority: number;
  fallbackGroup: string;
  tier: ModelTier;
  healthStatus: ModelHealthStatus;
  lastCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelRoute {
  routeKey: string;
  defaultModelId?: string;
  fallbackGroup: string;
  modelTier?: ModelTier;
  createdAt: string;
  updatedAt: string;
}

export interface ModelSelection {
  modelId: string;
  reason: string;
  source: 'task.route' | 'agent.model' | 'agent.config.model' | 'agent.config.modelPolicy' | 'role.route' | 'global.route' | 'env.default' | 'runtime.default' | 'fallback';
  requestedModelId?: string;
  fallbackGroup?: string;
  fallbackModelId?: string;
  modelTier?: ModelTier;
  routeKey?: string;
  budget?: AgentModelPolicy;
  taskProfile?: string;
}

export interface AgentProgress {
  toolUseCount: number;
  tokenCount: number;
  lastActivity?: ToolActivity;
  recentActivities: ToolActivity[];
  summary?: string;
}

export interface ProgressTracker {
  toolUseCount: number;
  latestInputTokens: number;
  cumulativeOutputTokens: number;
  recentActivities: ToolActivity[];
}

export interface TaskExecution {
  id: string;
  taskId: string;
  agentDefId: string;
  skillVersionId?: string;
  status: ExecutionStatus;
  progress: AgentProgress;
  costUSD: number;
  tokenCount: number;
  parentExecutionId?: string;
  workspaceId?: string;
  modelId?: string;
  modelTier?: ModelTier;
  modelRouteSource?: ModelSelection['source'];
  modelRouteReason?: string;
  startedAt: string;
  completedAt?: string;
}

export type ExecutionMessageType = 'user_input' | 'agent_text' | 'tool_use' | 'tool_result' | 'progress' | 'error';

export interface ExecutionMessage {
  id: number;
  executionId: string;
  type: ExecutionMessageType;
  content: string;
  toolName?: string;
  createdAt: string;
}

export type AgentMessageType = 'task_handoff' | 'progress_update' | 'approval_request' | 'approval_response' | 'context_update' | 'text';

export interface AgentMessage {
  id: number;
  fromExecution?: string;
  toExecution?: string;
  messageType: AgentMessageType;
  content: string;
  consumed: boolean;
  createdAt: string;
}

export type PipelineStatus = 'running' | 'paused' | 'blocked' | 'done' | 'failed' | 'awaiting_retry';

export interface PipelineStage {
  index: number;
  name: string;
  agentRole: AgentRole;
  taskId?: string;
  status: 'pending' | 'running' | 'review' | 'done' | 'failed' | 'skipped' | 'rolled_back';
  promptTemplate?: string;
  input?: string;
  output?: string;
  gateApproved?: boolean;
  dependsOn?: number[];  // stage indices this depends on (enables parallel execution)
}

export interface Pipeline {
  id: string;
  name: string;
  templateId?: string;
  status: PipelineStatus;
  stages: PipelineStage[];
  currentStageIndex: number;
  gateMode: 'auto' | 'manual';
  input: string;
  workspaceId?: string;
  /** Optional Domain Pack id — inherited by every stage task for persona + knowledge injection. */
  domainId?: string;
  createdAt: string;
  completedAt?: string;
}

export interface PipelineTemplate {
  id: string;
  name: string;
  description?: string;
  stages: { name: string; role: AgentRole; promptTemplate: string }[];
}

export type TestReportStatus = 'passed' | 'failed' | 'skipped' | 'unknown';

export interface TestReport {
  schemaVersion: 1;
  status: TestReportStatus;
  commands: string[];
  failures: string[];
  changedFiles: string[];
  coverageNotes?: string;
  summary: string;
  nextFix?: string;
  createdAt: string;
}

export interface PipelineTemplateValidationResult {
  valid: boolean;
  errors: { stageIndex?: number; field?: string; message: string }[];
  warnings: { stageIndex?: number; field?: string; message: string }[];
}

export interface Notification {
  id: string;
  type: 'task_complete' | 'task_failed' | 'pipeline_stage' | 'needs_input' | 'agent_error';
  title: string;
  message: string;
  taskId?: string;
  pipelineId?: string;
  read: boolean;
  createdAt: string;
}

export type InboxEntryType = 'approval' | 'question' | 'input' | 'review';
export type InboxEntryStatus = 'pending' | 'approved' | 'rejected' | 'answered' | 'cancelled';

export interface InboxEntry {
  id: string;
  type: InboxEntryType;
  status: InboxEntryStatus;
  title: string;
  message: string;
  options: string[];
  response?: string;
  taskId?: string;
  pipelineId?: string;
  executionId?: string;
  createdBy: 'system' | 'agent' | 'user';
  createdAt: string;
  respondedAt?: string;
}

export type QualityLoopAttemptStatus = 'reviewing' | 'approved' | 'needs_fix' | 'fixing' | 'fixed' | 'skipped' | 'failed';

export interface QualityLoopAttempt {
  id: string;
  taskId: string;
  iteration: number;
  status: QualityLoopAttemptStatus;
  reviewTaskId?: string;
  fixTaskId?: string;
  reviewerAgentId?: string;
  developerAgentId?: string;
  reviewOutput?: string;
  fixOutput?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type PlatformEventSeverity = 'info' | 'warn' | 'error';

export interface PlatformEvent {
  id: number;
  eventType: WSEventType;
  severity: PlatformEventSeverity;
  taskId?: string;
  pipelineId?: string;
  agentId?: string;
  executionId?: string;
  inboxEntryId?: string;
  qualityAttemptId?: string;
  payload: unknown;
  createdAt: string;
}

export interface ObservabilitySummary {
  totals: {
    events: number;
    tasks: number;
    failedTasks: number;
    cancelledTasks: number;
    retriedTasks: number;
    pipelines: number;
    failedPipelines: number;
  };
  failureHotspots: { taskId: string; title: string; count: number; lastFailureAt?: string }[];
  retryHotspots: { taskId: string; title: string; retryCount: number; status: TaskStatus }[];
  pipelineHealth: { status: PipelineStatus; count: number }[];
  recentErrors: PlatformEvent[];
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface RuntimeDiagnostics {
  auth: {
    enabled: boolean;
    mode: 'local' | 'token';
  };
  operator: {
    actor: OperatorActor;
    permissions: {
      canControlRuntime: boolean;
      canDeleteTasks: boolean;
    };
  };
  queue: {
    backend: 'memory' | 'redis';
    redisConfigured: boolean;
  };
  database: {
    pathSource: 'default' | 'env';
    pathHint: string;
    migrations: { id: string; appliedAt: string }[];
  };
  runtime: {
    nodeVersion: string;
    platform: string;
    pid: number;
    uptime: number;
    environment: string;
  };
}

export type OperatorRole = 'admin' | 'operator' | 'viewer';

export interface OperatorActor {
  id: string;
  role: OperatorRole;
  source: 'local' | 'token' | 'proxy';
}

export interface OperatorAction {
  id: number;
  action: string;
  actor: OperatorActor;
  targetType: 'task' | 'pipeline' | 'inbox' | 'system' | 'agent' | 'tool' | 'skill' | 'model' | 'template';
  targetId?: string;
  taskId?: string;
  pipelineId?: string;
  inboxEntryId?: string;
  status: 'success' | 'failed';
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface OperatorPreference<TValue = unknown> {
  actor: OperatorActor;
  namespace: string;
  key: string;
  value: TValue;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSnapshot {
  version: 1;
  generatedAt: string;
  generatedBy: OperatorActor;
  redaction: {
    secrets: 'excluded';
    diagnostics: 'sanitized';
  };
  data: {
    tasks: Task[];
    pipelines: Pipeline[];
    inboxEntries: InboxEntry[];
    notifications: Notification[];
    platformEvents: PlatformEvent[];
    observability: ObservabilitySummary;
    preferences: OperatorPreference[];
  };
}

export interface WorkspaceSnapshotPreview {
  valid: boolean;
  version?: number;
  generatedAt?: string;
  generatedBy?: OperatorActor;
  counts: {
    tasks: number;
    pipelines: number;
    inboxEntries: number;
    notifications: number;
    platformEvents: number;
    preferences: number;
  };
  warnings: string[];
}

export type WorkspaceRestoreActionType = 'create' | 'skip' | 'conflict';
export type WorkspaceRestoreResourceType = 'task' | 'pipeline' | 'inboxEntry' | 'notification' | 'platformEvent' | 'preference';

export interface WorkspaceRestoreAction {
  type: WorkspaceRestoreActionType;
  resourceType: WorkspaceRestoreResourceType;
  resourceId: string;
  reason: string;
  dependencies?: string[];
}

export interface WorkspaceRestorePlan {
  valid: boolean;
  preview: WorkspaceSnapshotPreview;
  summary: {
    create: number;
    skip: number;
    conflict: number;
    warnings: number;
  };
  actions: WorkspaceRestoreAction[];
  warnings: string[];
}

export type WorkspacePreferenceRestoreStatus = 'restored' | 'skipped' | 'failed';

export interface WorkspacePreferenceRestoreItem {
  namespace: string;
  key: string;
  status: WorkspacePreferenceRestoreStatus;
  reason: string;
}

export interface WorkspacePreferenceRestoreResult {
  actor: OperatorActor;
  restored: number;
  skipped: number;
  failed: number;
  items: WorkspacePreferenceRestoreItem[];
  auditActionId?: number;
}

export type DynamicWorkflowStatus = 'planning' | 'dispatching' | 'running' | 'validating' | 'done' | 'failed' | 'cancelled';

export interface DynamicWorkflowStep {
  id: string;
  title: string;
  description: string;
  agentRole: AgentRole;
  input: string;
  dependsOn?: string[];
  priority?: Priority;
  taskId?: string;
}

export interface DynamicWorkflowPlan {
  goal: string;
  strategy: string;
  maxParallel?: number;
  steps: DynamicWorkflowStep[];
  validation?: {
    requiredStepIds?: string[];
    summaryPrompt?: string;
  };
}

export interface DynamicWorkflowRun {
  id: string;
  goal: string;
  status: DynamicWorkflowStatus;
  plan: DynamicWorkflowPlan;
  taskIds: string[];
  workspaceId?: string;
  result?: string;
  validationSummary?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type WSEventType =
  | 'task:created' | 'task:updated' | 'task:assigned' | 'task:started' | 'task:log'
  | 'task:done' | 'task:failed' | 'task:cancelled'
  | 'agent:status' | 'agent:log'
  | 'pipeline:stage:started' | 'pipeline:stage:done' | 'pipeline:done' | 'pipeline:failed'
  | 'pipeline:stage:rolled_back' | 'pipeline:awaiting_retry'
  | 'coverage:report'
  | 'score:recorded'
  | 'notification'
  | 'inbox:created' | 'inbox:updated'
  | 'quality:updated'
  | 'execution:started' | 'execution:activity' | 'execution:progress'
  | 'execution:message' | 'execution:done' | 'execution:failed'
  | 'tool:started' | 'tool:done' | 'tool:failed' | 'tool:blocked' | 'tool:updated'
  | 'skill:updated' | 'skill:published' | 'skill:assigned'
  | 'agent:message'
  | 'orchestration:created' | 'orchestration:task_dispatched' | 'orchestration:task_completed'
  | 'orchestration:task_failed' | 'orchestration:agent_message' | 'orchestration:done'
  | 'orchestration:failed'
  | 'workflow:created' | 'workflow:planned' | 'workflow:task_dispatched'
  | 'workflow:task_completed' | 'workflow:task_failed' | 'workflow:done' | 'workflow:failed'
  | 'agent:comm:request' | 'agent:comm:response' | 'agent:comm:message'
  | 'artifact:published' | 'artifact:read'
  | 'graph:run_started' | 'graph:run_done' | 'graph:run_failed' | 'graph:run_cancelled'
  | 'graph:node_started' | 'graph:node_done' | 'graph:node_failed' | 'graph:node_skipped'
  | 'team:run_created' | 'team:run_planned' | 'team:run_done' | 'team:run_failed'
  | 'token:delta';

export interface WSEvent<TPayload = unknown> {
  type: WSEventType;
  payload: TPayload;
  timestamp: string;
}

// ---------- Coverage Check ----------

export interface CoverageReport {
  id: string;
  taskId: string;
  executionId: string;
  lineCoverage: number;
  branchCoverage: number;
  threshold: number;
  passed: boolean;
  summary: string;
  createdAt: string;
}

export interface CoverageCheckConfig {
  enabled: boolean;
  threshold: number;
  testCommand: string;
  filePatterns: string[];
}

// ---------- Execution Scoring ----------

export interface ExecutionScore {
  id: string;
  executionId: string;
  agentId: string;
  taskId: string;
  baseScore: number;
  llmScore: number | null;
  finalScore: number;
  dimensions: {
    completeness?: number;
    correctness?: number;
    codeQuality?: number;
  };
  createdAt: string;
}

// ---------- Pipeline Rollback ----------

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'rolled_back' | 'skipped';

export interface WSCommand {
  type: 'subscribe' | 'unsubscribe';
  channel: string;
}

export interface HealthSummary {
  status: 'ok' | string;
  uptime: number;
  agents: {
    total: number;
    active: number;
    idle: number;
  };
  tasks: {
    running: number;
    queued: number;
  };
  pipelines: {
    active: number;
  };
}

export interface TaskEventPayload {
  taskId: string;
  task?: Task;
  agentId?: string;
  workspaceId?: string;
  output?: string;
  error?: string;
  message?: string;
}

export interface PipelineEventPayload {
  pipelineId: string;
  stageIndex?: number;
  taskId?: string;
  workspaceId?: string;
  output?: string;
}

export interface ExecutionEventPayload {
  executionId: string;
  taskId?: string;
  agentDefId?: string;
  workspaceId?: string;
  progress?: AgentProgress;
  type?: ExecutionMessageType;
  content?: string;
  error?: string;
}

export interface InboxEventPayload {
  inboxEntryId: string;
  entry?: InboxEntry;
}

export interface QualityLoopEventPayload {
  taskId: string;
  attempt?: QualityLoopAttempt;
}

// ---------- Agent Federation ----------

export interface CommRequest {
  from: string;
  capability: string;
  payload: any;
  timeout?: number;
}

export interface CommMessage {
  from: string;
  capability: string;
  payload: any;
  replyTo?: string;
}

export interface CommResponse {
  success: boolean;
  providerId: string;
  output: any;
  durationMs: number;
}

export interface CommMessageRecord {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  capability: string;
  mode: 'sync' | 'async';
  status: 'pending' | 'running' | 'done' | 'failed' | 'timeout';
  payloadSummary: string | null;
  taskId: string | null;
  outputSummary: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

export interface Artifact {
  id: string;
  ownerId: string;
  name: string;
  content: string;
  readableBy: string[];
  expiresAt: string;
  createdAt: string;
}
