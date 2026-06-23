import { Router } from 'express';
import { z } from 'zod';
import {
  listDomains, getDomain, createDomain, updateDomain, deleteDomain, bindKnowledge,
} from '../agents/domain-registry.js';
import { ingestDocument } from '../knowledge/rag.js';
import { getDb } from '../db/database.js';
import { notFound, parseBody, sendError } from './http.js';

const retrievalSchema = z.object({
  enabled: z.boolean().optional(),
  topK: z.number().int().min(1).max(20).optional(),
  minScore: z.number().min(0).max(1).optional(),
});

const domainSchema = z.object({
  id: z.string().trim().optional(),
  name: z.string().trim().min(1, 'name is required'),
  emoji: z.string().trim().optional(),
  persona: z.string().trim().min(1, 'persona is required'),
  guidelines: z.array(z.string().trim()).optional(),
  terminology: z.record(z.string()).optional(),
  disclaimer: z.string().trim().optional(),
  tone: z.string().trim().optional(),
  retrieval: retrievalSchema.optional(),
  knowledgeIds: z.array(z.string().trim()).optional(),
  agentIds: z.array(z.string().trim()).optional(),
});
const domainPatchSchema = domainSchema.partial().refine(
  d => Object.keys(d).length > 0,
  { message: 'no fields to update' },
);

const uploadSchema = z.object({
  title: z.string().trim().min(1, 'title is required'),
  content: z.string().min(1, 'content is required'),
  metadata: z.record(z.unknown()).optional(),
});

function workspaceOf(req: any): string {
  return req.tenantContext?.workspaceId || 'default';
}

/** Attach the bound knowledge documents to a domain for display. */
function withDocs(domain: ReturnType<typeof getDomain>) {
  if (!domain) return domain;
  let documents: Array<{ id: string; title: string; chunkCount: number }> = [];
  try {
    const db = getDb();
    if (domain.knowledgeIds.length) {
      const placeholders = domain.knowledgeIds.map(() => '?').join(',');
      documents = db.all(
        `SELECT id, title, chunk_count AS chunkCount FROM knowledge_documents WHERE id IN (${placeholders})`,
        ...domain.knowledgeIds,
      ) as any[];
    }
  } catch { /* ignore */ }
  return { ...domain, documents };
}

export function createDomainRoutes(): Router {
  const router = Router();

  // GET /domains — list all domains (built-ins overlaid by custom)
  router.get('/', (req, res) => {
    try {
      res.json({ domains: listDomains(workspaceOf(req)).map(withDocs) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /domains — create a custom domain
  router.post('/', (req, res) => {
    try {
      const body = parseBody(domainSchema, req);
      const domain = createDomain(body, workspaceOf(req));
      res.status(201).json(withDocs(domain));
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /domains/:id — one domain with bound documents
  router.get('/:id', (req, res) => {
    try {
      const domain = getDomain(req.params.id, workspaceOf(req));
      if (!domain) notFound('DOMAIN_NOT_FOUND', 'Domain not found');
      res.json(withDocs(domain));
    } catch (err) {
      sendError(res, err);
    }
  });

  // PATCH /domains/:id — edit (built-ins are materialized as a custom override)
  router.patch('/:id', (req, res) => {
    try {
      const domain = getDomain(req.params.id, workspaceOf(req));
      if (!domain) notFound('DOMAIN_NOT_FOUND', 'Domain not found');
      const body = parseBody(domainPatchSchema, req);
      const updated = updateDomain(req.params.id, body, workspaceOf(req));
      res.json(withDocs(updated));
    } catch (err) {
      sendError(res, err);
    }
  });

  // DELETE /domains/:id — delete a custom domain (or revert a built-in override)
  router.delete('/:id', (req, res) => {
    try {
      const result = deleteDomain(req.params.id);
      res.json({ ok: true, ...result });
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /domains/:id/knowledge — upload a document straight into this domain
  router.post('/:id/knowledge', async (req, res) => {
    try {
      const domain = getDomain(req.params.id, workspaceOf(req));
      if (!domain) notFound('DOMAIN_NOT_FOUND', 'Domain not found');
      const body = parseBody(uploadSchema, req);
      const ws = workspaceOf(req);
      const doc = await ingestDocument(ws, body.title, body.content, body.metadata || {}, domain!.id);
      const updated = bindKnowledge(domain!.id, [doc.id], ws);
      res.status(201).json({ document: { id: doc.id, title: doc.title, chunkCount: doc.chunkCount }, domain: withDocs(updated) });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
