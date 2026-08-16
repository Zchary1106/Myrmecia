/**
 * Team Composer contracts.
 *
 * These types describe responsibilities and data flow. They intentionally sit
 * beside the existing runtime models so legacy agents and workflows can be
 * normalized without a destructive database migration.
 */

export type ContractSchemaVersion = '1.0';

export type ArtifactKind =
  | 'text'
  | 'markdown'
  | 'json'
  | 'code'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'report'
  | 'archive'
  | 'other';

export interface ArtifactRequirement {
  /** Stable name used by workflow edge mappings. */
  name: string;
  kind: ArtifactKind;
  description?: string;
  schemaRef?: string;
  mimeTypes?: string[];
  required?: boolean;
  multiple?: boolean;
}

export interface ArtifactDeclaration extends ArtifactRequirement {
  required: boolean;
}

export interface ArtifactContract {
  schemaVersion: ContractSchemaVersion;
  id: string;
  name: string;
  kind: ArtifactKind;
  description?: string;
  schemaRef?: string;
  mimeType?: string;
  uri?: string;
  inlineContent?: string;
  producer: {
    agentId?: string;
    workflowId?: string;
    nodeId?: string;
    runId?: string;
  };
  lineage?: {
    sourceArtifactIds: string[];
  };
  integrity?: {
    algorithm: 'sha256';
    checksum: string;
    sizeBytes?: number;
  };
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AgentQualityRubricItem {
  id: string;
  description: string;
  weight?: number;
  blocking?: boolean;
}

export interface AgentContract {
  schemaVersion: ContractSchemaVersion;
  agentId: string;
  role: string;
  responsibility: {
    summary: string;
    owns: string[];
    doesNotOwn: string[];
    escalatesTo?: string[];
  };
  inputs: ArtifactRequirement[];
  outputs: ArtifactDeclaration[];
  skills: string[];
  tools: string[];
  quality: {
    definitionOfDone: string[];
    rubric?: AgentQualityRubricItem[];
  };
  execution?: {
    maxRetries?: number;
    requiresHumanApproval?: boolean;
  };
}

export type WorkflowNodeKind = 'agent' | 'gate' | 'human-approval' | 'publisher';
export type WorkflowEdgeKind = 'data' | 'control' | 'approval';

export interface WorkflowNodeContract {
  id: string;
  label?: string;
  kind?: WorkflowNodeKind;
  agentId?: string;
  agentRole?: string;
  prompt?: string;
  inputArtifacts?: ArtifactRequirement[];
  outputArtifacts?: ArtifactDeclaration[];
  requiredSkills?: string[];
  qualityGate?: {
    outputSchema?: string;
    approvalRequired?: boolean;
  };
  retryPolicy?: {
    maxAttempts: number;
    backoffMs?: number;
    onExhausted?: 'fail' | 'human';
  };
  position?: { x: number; y: number };
}

export interface WorkflowArtifactMapping {
  from: string;
  to: string;
}

export interface WorkflowEdgeContract {
  id: string;
  source: string;
  target: string;
  kind?: WorkflowEdgeKind;
  artifactMappings?: WorkflowArtifactMapping[];
}

export interface WorkflowGraphContract {
  schemaVersion?: ContractSchemaVersion;
  nodes: WorkflowNodeContract[];
  edges: WorkflowEdgeContract[];
}

export interface ContractValidationIssue {
  path: string;
  message: string;
  code?: string;
}

export interface ContractValidationResult<T> {
  valid: boolean;
  value?: T;
  errors: ContractValidationIssue[];
  warnings: ContractValidationIssue[];
}

export type WorkflowRunStatus =
  | 'draft'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'cancelled';

export type WorkflowNodeRunStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'retrying'
  | 'waiting_approval'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface WorkflowIntervention {
  kind: 'approval' | 'retry' | 'override';
  requestedAt: string;
  reason: string;
  actorId?: string;
  decidedAt?: string;
  decision?: 'approved' | 'rejected' | 'retried';
  note?: string;
}

export type TeamTemplateVersionStatus = 'draft' | 'published' | 'archived';

export interface TeamTemplateVersion {
  id: string;
  teamId: string;
  workspaceId: string;
  version: number;
  status: TeamTemplateVersionStatus;
  graph: WorkflowGraphContract;
  changeNote?: string;
  createdBy: string;
  createdAt: string;
  publishedAt?: string;
  archivedAt?: string;
}

// ---------- Contract v2 (Agent / Skill / Domain / Team refactor) ----------

/**
 * Contract v2 formalizes the target object model: Team declares role slots
 * and capability needs; Pipeline nodes declare role slots + required
 * capabilities; the runtime resolves them into an immutable
 * ExecutionPlanSnapshot. v1 contracts remain supported for legacy data.
 */

export type ContractSchemaVersionV2 = '2.0';

export interface TeamRoleSlotV2 {
  /** Stable slot id within the team, e.g. `creator`. */
  slot: string;
  /** Stable agent role id the slot binds to, e.g. `content-creator`. */
  agentId: string;
  /** Skill ids mounted on the slot (merged with the agent's defaults). */
  skills?: string[];
  /** Tool ids the slot may use. */
  tools?: string[];
  /** Domain pack ids scoped to the slot. */
  domainIds?: string[];
}

export interface TeamPolicyV2 {
  /** Actions that always require a human approval gate, e.g. `publish`. */
  requireHumanApprovalBefore?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  maxCostUsd?: number;
}

export interface TeamContractV2 {
  schemaVersion: ContractSchemaVersionV2;
  id: string;
  name: string;
  version: 2;
  lead: string;
  domainIds?: string[];
  roles: TeamRoleSlotV2[];
  policy?: TeamPolicyV2;
  pipelineTemplate?: string;
  /** Legacy v1 member roles kept for compatibility. */
  members?: string[];
}

export type GateKindV2 = 'auto' | 'human-approval';

export interface GateContractV2 {
  kind: GateKindV2;
  reason?: string;
  /** When true, a failed gate blocks the pipeline instead of warning. */
  blocking?: boolean;
  /** Tool ids / actions that trigger this gate. */
  requiresApprovalFor?: string[];
}

export interface RetryPolicyV2 {
  maxAttempts: number;
  backoffMs?: number;
  onExhausted?: 'fail' | 'human';
}

export interface FallbackPolicyV2 {
  onFailure?: 'skip' | 'human' | 'fallback-agent';
  fallbackAgentId?: string;
}

/** Pipeline Node Contract v2 — declares needs, never concrete agent ids. */
export interface WorkflowNodeV2 {
  id: string;
  roleSlot: string;
  requiredCapabilities: string[];
  skillIds: string[];
  toolIds?: string[];
  domainIds?: string[];
  inputs: ArtifactRequirement[];
  outputs: ArtifactDeclaration[];
  gate?: GateContractV2;
  retry?: RetryPolicyV2;
  fallback?: FallbackPolicyV2;
}

/** Result of binding a role slot during capability resolution. */
export interface ResolvedRoleCapability {
  slot: string;
  agentId: string;
  /** Set when the slot resolved through a legacy agent alias. */
  legacyAgentId?: string;
  skills: string[];
  tools: string[];
  domainIds: string[];
  /** Resolved domain packs with their locked versions (from the snapshot). */
  domains?: Array<{ id: string; version: number }>;
  capabilities: string[];
}

/** Immutable plan snapshot captured before each run, for audit and replay. */
export interface ExecutionPlanSnapshot {
  schemaVersion: ContractSchemaVersionV2;
  snapshotId: string;
  teamId: string;
  teamVersion: number;
  pipelineTemplate?: string;
  pipelineVersion?: string;
  roles: ResolvedRoleCapability[];
  policy: TeamPolicyV2;
  gates: Array<{
    nodeId: string;
    gate: GateContractV2;
  }>;
  modelPolicy?: Record<string, unknown>;
  contextBudget?: Record<string, unknown>;
  createdAt: string;
  /** sha256 over the canonical JSON of the snapshot (excluding checksum). */
  checksum: string;
}
