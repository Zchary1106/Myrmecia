import type { AgentConfig, AgentContract } from './index.js';

export interface AgentConfigSnapshot {
  schemaVersion: 1;
  agentId: string;
  name: string;
  role: string;
  emoji: string;
  description: string;
  whenToUse: string;
  capabilities: string[];
  triggers: string[];
  systemInstructions: string;
  contract?: AgentContract;
  config: Pick<AgentConfig, 'model' | 'modelPolicy' | 'maxTurns' | 'timeout' | 'maxConcurrent' | 'allowNetwork' | 'workdir' | 'governanceBudget'>;
  allowedTools: string[];
  disallowedTools: string[];
  skill: null | {
    source: 'assignment' | 'skillPath' | 'file';
    skillId?: string;
    versionId?: string;
    checksum: string;
    sourcePath?: string;
    /** Only unregistered file-based instructions; excludes credentials. */
    content?: string;
  };
  domain: null | { id: string; version: number; configHash: string; knowledgeIds: string[] };
  /** Optional for pre-governance revisions. Source bytes are never configuration. */
  knowledge?: import('./agent-knowledge.js').AgentKnowledgeReference[];
}

export interface AgentConfigVersion {
  id: string;
  agentId: string;
  workspaceId: string;
  sequence: number;
  configHash: string;
  snapshot: AgentConfigSnapshot;
  createdBy: string;
  origin: 'publish' | 'task_snapshot';
  createdAt: string;
}

export interface AgentConfigHistory {
  activeVersionId: string | null;
  workingConfigHash: string;
  workingChanges: string[];
  workingError?: string;
  versions: AgentConfigVersion[];
}

export interface AgentConfigRunAttribution {
  source: 'revision' | 'phase1_snapshot' | 'legacy';
  versionId?: string;
  sequence?: number;
  configHash?: string;
  pinnedBeforeDispatch: boolean;
  requestedModelId?: string;
  actualModelId?: string;
  skillVersionId?: string;
  declaredTools?: string[];
  effectiveTools?: string[];
}
