/**
 * Memory System — Unified Entry Point
 *
 * Initializes the unified memory substrate (vector store + trajectory learning).
 */

export { HNSWIndex } from './hnsw.js';
export { getEmbeddingService, resetEmbeddingService, type EmbeddingService } from './embedding.js';
export {
  SqliteMemoryStore,
  getMemoryStore,
  resetMemoryStore,
  MEMORY_SCHEMA,
} from './memory-store.js';
export {
  MEMORY_TYPES,
  MEMORY_SCOPE_KEYS,
  type MemoryType,
  type MemoryScope,
  type MemoryItem,
  type MemoryWriteInput,
  type MemoryQuery,
  type ScoredMemory,
  type ScoreWeights,
  type MemoryStore,
} from './types.js';
export {
  TrajectoryStore,
  getTrajectoryStore,
  resetTrajectoryStore,
  type TaskTrajectory,
  type RouteRecommendation,
  type SimilarTrajectory,
} from './trajectory-store.js';
export {
  MemoryService,
  getMemoryService,
  resetMemoryService,
  estimateTokens,
  type ContextBlockOptions,
  type CaptureEpisodeInput,
} from './memory-service.js';
export {
  WritePipeline,
  getWritePipeline,
  resetWritePipeline,
  extractFacts,
  type FactCandidate,
  type IngestResult,
  type IngestOptions,
  type ConsolidationAction,
} from './write-pipeline.js';
export {
  ReflectionService,
  getReflectionService,
  resetReflectionService,
  type ReflectionResult,
} from './reflection.js';
export {
  MemoryMaintenance,
  getMemoryMaintenance,
  resetMemoryMaintenance,
  type DecayResult,
} from './decay.js';
export {
  GraphMemory,
  getGraphMemory,
  resetGraphMemory,
  extractEntities,
  type GraphEdge,
  type IngestGraphResult,
} from './graph.js';

import { getMemoryStore } from './memory-store.js';
import { getTrajectoryStore } from './trajectory-store.js';
import { getMemoryMaintenance } from './decay.js';
import { logger } from '../lib/logger.js';

/** Initialize the memory system (call once at startup) */
export async function initMemorySystem(): Promise<void> {
  await getMemoryStore().initialize();
  // TrajectoryStore.initialize() also runs the one-time legacy migration.
  await getTrajectoryStore().initialize();
  // Best-effort decay pass on boot (expires TTLs, prunes stale ephemeral memory).
  await getMemoryMaintenance().runDecay().catch(() => undefined);
  logger.info('Memory system initialized (unified MemoryStore + trajectory routing)');
}
