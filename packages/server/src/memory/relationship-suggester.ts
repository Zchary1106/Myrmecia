import type { MemoryEdge, MemoryRelation } from './types.js';

export interface RelationshipNode {
  id: string;
  content: string;
  summary?: string;
  importance: number;
  metadata?: Record<string, unknown>;
}

export interface RelationshipSuggestion {
  sourceId: string;
  targetId: string;
  relation: MemoryRelation;
  confidence: number;
  reason: string;
}

const MAX_CANDIDATES = 40;
const STOPWORDS = new Set(['this', 'that', 'with', 'from', 'then', 'into', 'about', 'the', 'and', 'for', 'task', 'agent', 'memory', '项目', '任务', '使用', '需要', '可以', '进行', '相关', '内容']);

function metadataValue(node: RelationshipNode, keys: string[]): string | undefined {
  const metadata = node.metadata || {};
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function tokens(node: RelationshipNode): Set<string> {
  const text = `${node.summary || ''} ${node.content}`.toLowerCase();
  const words = text.match(/[a-z0-9_/-]{3,}|[\u4e00-\u9fff]{2,}/g) || [];
  return new Set(words.filter(token => !STOPWORDS.has(token)));
}

function overlap(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return { shared: 0, ratio: 0 };
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return { shared, ratio: shared / Math.min(left.size, right.size) };
}

function edgeKey(sourceId: string, targetId: string) {
  return [sourceId, targetId].sort().join(':');
}

/**
 * Creates explainable, non-persistent suggestions. An operator must explicitly
 * confirm a suggestion before it is stored as a graph edge.
 */
export function suggestMemoryRelationships(
  nodes: RelationshipNode[],
  edges: MemoryEdge[],
  limit = MAX_CANDIDATES,
): RelationshipSuggestion[] {
  const existing = new Set(edges.map(edge => edgeKey(edge.sourceId, edge.targetId)));
  const candidates: RelationshipSuggestion[] = [];
  const vectors = new Map(nodes.map(node => [node.id, tokens(node)]));

  for (let sourceIndex = 0; sourceIndex < nodes.length; sourceIndex += 1) {
    const source = nodes[sourceIndex];
    for (let targetIndex = sourceIndex + 1; targetIndex < nodes.length; targetIndex += 1) {
      const target = nodes[targetIndex];
      if (existing.has(edgeKey(source.id, target.id))) continue;

      const sourceTask = metadataValue(source, ['taskId', 'executionId']);
      const targetTask = metadataValue(target, ['taskId', 'executionId']);
      const sourceArtifact = metadataValue(source, ['artifactId', 'artifact', 'evidenceId']);
      const targetArtifact = metadataValue(target, ['artifactId', 'artifact', 'evidenceId']);
      const sourceSession = metadataValue(source, ['sessionId', 'conversationId']);
      const targetSession = metadataValue(target, ['sessionId', 'conversationId']);
      const sourceAgent = metadataValue(source, ['agentId', 'agent']);
      const targetAgent = metadataValue(target, ['agentId', 'agent']);
      const score = overlap(vectors.get(source.id) || new Set(), vectors.get(target.id) || new Set());

      let confidence = 0;
      let reason = '';
      if (sourceArtifact && sourceArtifact === targetArtifact) {
        confidence = 0.96;
        reason = 'Both memories cite the same artifact.';
      } else if (sourceTask && sourceTask === targetTask) {
        confidence = 0.92;
        reason = 'Both memories came from the same task.';
      } else if (sourceSession && sourceSession === targetSession) {
        confidence = 0.86;
        reason = 'Both memories came from the same session.';
      } else if (sourceAgent && sourceAgent === targetAgent && score.shared >= 2 && score.ratio >= 0.28) {
        confidence = Math.min(0.82, 0.58 + score.ratio * 0.4);
        reason = `Same agent and ${score.shared} shared topic terms.`;
      } else if (score.shared >= 3 && score.ratio >= 0.46) {
        confidence = Math.min(0.74, 0.42 + score.ratio * 0.5);
        reason = `${score.shared} shared topic terms.`;
      }
      if (!reason) continue;

      candidates.push({
        sourceId: source.id,
        targetId: target.id,
        relation: 'related_to',
        confidence: Math.round(confidence * 100) / 100,
        reason,
      });
    }
  }
  return candidates
    .sort((left, right) => right.confidence - left.confidence || left.sourceId.localeCompare(right.sourceId))
    .slice(0, Math.min(Math.max(limit, 1), MAX_CANDIDATES));
}

