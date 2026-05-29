import { Router } from 'express';
import { z } from 'zod';
import {
  listSources,
  getSource,
  createSource,
  deleteSource,
  browseCatalog,
  syncSource,
  importSkill,
} from '../skills/skill-registry-service.js';
import { sendError, parseBody } from './http.js';

const addSourceSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  type: z.enum(['github', 'http', 'local']),
  url: z.string().url(),
  branch: z.string().optional(),
  pathPrefix: z.string().optional(),
  authToken: z.string().optional(),
});

const importSchema = z.object({
  catalogId: z.string().trim().min(1),
  transform: z.boolean().optional(),
});

export function createSkillRegistryRoutes(): Router {
  const router = Router();

  /** GET /registry/sources */
  router.get('/sources', (_req, res) => {
    res.json(listSources());
  });

  /** POST /registry/sources */
  router.post('/sources', (req, res) => {
    try {
      const data = parseBody(addSourceSchema, req);
      const source = createSource(data);
      res.status(201).json(source);
    } catch (err) {
      sendError(res, err);
    }
  });

  /** DELETE /registry/sources/:id */
  router.delete('/sources/:id', (req, res) => {
    const deleted = deleteSource(req.params.id);
    if (!deleted) return res.status(404).json({ error: { message: 'Source not found' } });
    res.json({ success: true });
  });

  /** POST /registry/sources/:id/sync */
  router.post('/sources/:id/sync', async (req, res) => {
    try {
      const result = await syncSource(req.params.id);
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  /** GET /registry/browse */
  router.get('/browse', (req, res) => {
    const filter: any = {};
    if (req.query.sourceId) filter.sourceId = req.query.sourceId;
    if (req.query.search) filter.search = req.query.search;
    if (req.query.structured === 'true') filter.structured = true;
    if (req.query.structured === 'false') filter.structured = false;
    res.json(browseCatalog(filter));
  });

  /** POST /registry/import */
  router.post('/import', async (req, res) => {
    try {
      const { catalogId, transform } = parseBody(importSchema, req);
      const result = await importSkill(catalogId, { transform });
      res.status(201).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
