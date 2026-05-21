import { Router } from 'express';
import type { CapabilityRegistry } from '../agents/capability-registry.js';

export function createCapabilityRoutes(registry: CapabilityRegistry): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(registry.listCapabilities());
  });

  router.get('/:name/providers', (req, res) => {
    const providers = registry.findAllProviders(req.params.name);
    res.json({
      capability: req.params.name,
      providers: providers.map(p => ({ id: p.id, name: p.name, role: p.role })),
    });
  });

  return router;
}
