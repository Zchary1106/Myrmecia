import { createArtifact, getArtifact, listArtifacts, deleteExpiredArtifacts } from '../db/models/shared-artifact.js';
import { eventBus } from '../events/event-bus.js';
import { logger } from '../lib/logger.js';
import type { CapabilityRegistry } from './capability-registry.js';
import type { Artifact } from '../types.js';

export class SharedArtifactStore {
  private registry: CapabilityRegistry;

  constructor(registry: CapabilityRegistry) {
    this.registry = registry;
  }

  publish(data: {
    ownerId: string;
    name: string;
    content: string;
    readableBy: string[];
    ttlHours?: number;
  }): Artifact {
    const artifact = createArtifact({
      ownerId: data.ownerId,
      name: data.name,
      content: data.content,
      readableBy: data.readableBy,
      ttlHours: data.ttlHours,
    });

    eventBus.emit('artifact:published', { artifact: { ...artifact, content: undefined } });
    logger.info({ artifactId: artifact.id, owner: data.ownerId, name: data.name }, 'Artifact published');
    return artifact;
  }

  read(artifactId: string, readerId: string): string | null {
    const artifact = getArtifact(artifactId);
    if (!artifact) return null;

    if (artifact.ownerId === readerId) {
      eventBus.emit('artifact:read', { artifactId, readerId, allowed: true });
      return artifact.content;
    }

    const readerCaps = this.registry.getAgentCapabilities(readerId);
    const hasAccess = artifact.readableBy.some(cap => readerCaps.includes(cap));

    eventBus.emit('artifact:read', { artifactId, readerId, allowed: hasAccess });

    if (!hasAccess) {
      logger.warn({ artifactId, readerId, required: artifact.readableBy, actual: readerCaps }, 'Artifact access denied');
      return null;
    }

    return artifact.content;
  }

  listAccessible(agentId: string): Artifact[] {
    const agentCaps = this.registry.getAgentCapabilities(agentId);
    const allArtifacts = listArtifacts();

    return allArtifacts.filter(art => {
      if (art.ownerId === agentId) return true;
      return art.readableBy.some(cap => agentCaps.includes(cap));
    });
  }

  cleanup(): number {
    const deleted = deleteExpiredArtifacts();
    if (deleted > 0) {
      logger.info({ deleted }, 'Expired artifacts cleaned up');
    }
    return deleted;
  }
}
