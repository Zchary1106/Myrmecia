import { Router } from 'express';
import type { SharedArtifactStore } from '../agents/shared-artifact-store.js';
import { listArtifacts, getArtifact } from '../db/models/shared-artifact.js';

export function createArtifactRoutes(store: SharedArtifactStore): Router {
  const router = Router();

  router.post('/', (req, res) => {
    try {
      const { ownerId, name, content, readableBy, ttlHours } = req.body;
      if (!ownerId || !name || !content) {
        return res.status(400).json({ error: 'ownerId, name, and content are required' });
      }
      const artifact = store.publish({ ownerId, name, content, readableBy: readableBy || [], ttlHours });
      res.status(201).json({ ...artifact, content: undefined });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/', (req, res) => {
    const agentId = req.query.agentId as string;
    if (agentId) {
      const accessible = store.listAccessible(agentId);
      res.json(accessible.map(a => ({ ...a, content: undefined })));
    } else {
      const all = listArtifacts({ limit: parseInt(req.query.limit as string) || 50 });
      res.json(all.map(a => ({ ...a, content: undefined })));
    }
  });

  router.get('/:id', (req, res) => {
    const agentId = req.query.agentId as string;
    if (!agentId) {
      const art = getArtifact(req.params.id);
      if (!art) return res.status(404).json({ error: 'Artifact not found' });
      return res.json(art);
    }
    const content = store.read(req.params.id, agentId);
    if (content === null) {
      return res.status(403).json({ error: 'Access denied or artifact not found' });
    }
    const art = getArtifact(req.params.id)!;
    res.json({ ...art, content });
  });

  return router;
}
