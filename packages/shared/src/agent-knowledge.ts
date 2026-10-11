export type AgentKnowledgeScope = 'agent_private' | 'team_shared' | 'session' | 'workspace';
export interface AgentKnowledgeReference {
  sourceId: string;
  bindingId: string;
  version: number;
  sourceHash: string;
  passageHash: string;
}
export interface AgentKnowledgeSource extends AgentKnowledgeReference {
  title: string;
  scope: 'agent_private' | 'team_shared';
  ownerId: string;
  sizeBytes: number;
  passageCount: number;
  createdAt: string;
}
export interface AgentKnowledgeCatalog {
  agentPrivate: AgentKnowledgeSource[];
  teams: Array<{ id: string; name: string; sources: AgentKnowledgeSource[] }>;
  unbound: AgentKnowledgeSource[];
}
export interface KnowledgeCitation {
  id: string;
  sourceId: string;
  sourceHash: string;
  passageHash: string;
  version: number;
  title: string;
  locator: string;
  scope: AgentKnowledgeScope;
  ownerId: string;
  shortened: boolean;
  href: string;
}
export interface KnowledgeCitationManifest {
  schemaVersion: 1;
  executionId: string;
  taskId: string;
  agentId: string;
  workspaceId: string;
  citations: KnowledgeCitation[];
  omitted: boolean;
  includedCharacters: number;
  createdAt: string;
}
export interface ResolvedKnowledgeCitation extends KnowledgeCitation {
  text: string;
}
