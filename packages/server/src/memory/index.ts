/**
 * Memory System — Unified Entry Point
 *
 * Initializes the vector memory and trajectory learning subsystem.
 */

export { HNSWIndex } from './hnsw.js';
export { getEmbeddingService, resetEmbeddingService, type EmbeddingService } from './embedding.js';
export {
  TrajectoryStore,
  getTrajectoryStore,
  resetTrajectoryStore,
  type TaskTrajectory,
  type RouteRecommendation,
  type SimilarTrajectory,
} from './trajectory-store.js';

import { getTrajectoryStore } from './trajectory-store.js';
import { logger } from '../lib/logger.js';

/** Initialize the memory system (call once at startup) */
export async function initMemorySystem(): Promise<void> {
  const store = getTrajectoryStore();
  await store.initialize();
  logger.info('Memory system initialized (trajectory store + HNSW)');
}
