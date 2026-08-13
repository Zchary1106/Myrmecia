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
