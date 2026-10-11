import type { CompletionCriterion, CompletionVerification } from './completion-protocol.js';

export interface AgentEvaluationCase {
  id: string;
  name: string;
  prompt: string;
  checks: CompletionCriterion[];
}
export interface AgentEvaluationSuiteInput {
  name: string;
  cases: AgentEvaluationCase[];
}
export interface AgentEvaluationSuite extends AgentEvaluationSuiteInput {
  schemaVersion: 1;
  id: string;
  agentId: string;
  workspaceId: string;
  actorId: string;
  revision: number;
  hash: string;
  createdAt: string;
  updatedAt: string;
}
export type AgentEvaluationStatus = 'pending' | 'running' | 'passed' | 'failed' | 'unavailable';
export interface AgentEvaluationCaseResult {
  caseId: string;
  taskId?: string;
  executionId?: string;
  status: AgentEvaluationStatus;
  humanReviewRequired: boolean;
  verification?: CompletionVerification;
  output?: string;
  outputSha256?: string;
  resultSha256?: string;
  message?: string;
  requestedModel?: string;
  actualModel?: string;
  provider?: string;
  transport: 'fixture' | 'real_model' | 'unknown';
  checkedAt?: string;
}
export interface AgentEvaluationRun {
  schemaVersion: 1;
  id: string;
  agentId: string;
  workspaceId: string;
  actorId: string;
  suiteId: string;
  suiteRevision: number;
  suiteHash: string;
  suiteSnapshot: AgentEvaluationSuiteInput;
  configVersionId: string;
  configSequence: number;
  configHash: string;
  selectedCaseIds: string[];
  results: AgentEvaluationCaseResult[];
  counts: Record<AgentEvaluationStatus, number>;
  createdAt: string;
}
