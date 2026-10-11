import type { AgentConfig, AgentContract } from './index.js';
import type { AgentConfigSnapshot } from './agent-config-version.js';

export interface AgentSetupForm {
  name: string;
  role: string;
  emoji: string;
  description: string;
  whenToUse: string;
  systemInstructions: string;
  capabilities: string;
  triggers: string;
  allowedTools: string[];
  model: string;
  skillVersionId: string;
  testPrompt: string;
  maxTurns: number;
  timeout: number;
  maxConcurrent: number;
  contractEnabled: boolean;
  owns: string[];
  doesNotOwn: string[];
  escalatesTo: string[];
  definitionOfDone: string[];
  inputs: AgentContract['inputs'];
  outputs: AgentContract['outputs'];
}

export interface AgentSetupDraft {
  schemaVersion: 1;
  id: string;
  workspaceId: string;
  actorId: string;
  revision: number;
  form: AgentSetupForm;
  step: number;
  locked: boolean;
  testSubmitted: boolean;
  creationKey: string;
  testKey: string;
  agentId?: string;
  bound: boolean;
  taskId?: string;
  stage: 'draft' | 'creating' | 'binding' | 'saved' | 'testing' | 'dispatched';
  createdAt: string;
  updatedAt: string;
}

/** Phase-one task snapshot; complete revision history is a separate feature. */
export interface AgentSetupSnapshot {
  schemaVersion: 1;
  agentId: string;
  name: string;
  role: string;
  description?: string;
  whenToUse: string;
  systemInstructions?: string;
  contract?: AgentContract;
  config: Pick<AgentConfig, 'model' | 'maxTurns' | 'timeout' | 'maxConcurrent' | 'allowNetwork'>;
  allowedTools: string[];
  disallowedTools: string[];
  versionId?: string;
  configHash?: string;
  versionSequence?: number;
  completeConfig?: AgentConfigSnapshot;
  pinnedBeforeDispatch?: boolean;
  /** Task-selected domain is separate from the reusable Agent version. */
  domainOverride?: AgentConfigSnapshot['domain'];
}

export interface AgentSetupPreflight {
  checkedAt: string;
  canTest: boolean;
  status: 'ready_for_test' | 'needs_attention';
  model: { requestedId: string; provider?: string; health: string };
  checks: Array<{
    id: string;
    label: string;
    status: 'available' | 'requires_approval' | 'unavailable' | 'unknown';
    blocking: boolean;
    message: string;
  }>;
}
