import type { BackgroundWorker, WorkerContext, WorkerResult } from './scheduler.js';
import { deleteExpiredArtifacts } from '../db/models/shared-artifact.js';

export const artifactCleanupWorker: BackgroundWorker = {
  id: 'artifact-cleanup',
  name: 'Artifact Cleanup',
  intervalMs: 30 * 60 * 1000,
  enabled: true,

  async run(ctx: WorkerContext): Promise<WorkerResult> {
    const deleted = deleteExpiredArtifacts();
    return {
      success: true,
      message: `Cleaned up ${deleted} expired artifacts`,
    };
  },
};
