import { Router, raw } from 'express';
import { z } from 'zod';
import { workspaceIdFromRequest } from '../auth/tenant.js';
import { HttpError, parseBody, requireOperatorRole, requireConfirmation, sendError } from './http.js';
import { MAX_DOCUMENT_BYTES, parseSessionDocument } from '../knowledge/session-document-parser.js';
import { assertKnowledgeAgent, assertKnowledgeOwner, knowledgeCatalog, createKnowledgeSource,
  bindKnowledgeSource, unbindKnowledgeSource, deleteKnowledgeSource } from '../db/models/agent-knowledge.js';
import { createOperatorAction } from '../db/models/operator-action.js';

export function createAgentKnowledgeRoutes(): Router {
  const router = Router({ mergeParams: true });
  let parsing = 0;
  router.use((req, res, next) => {
    try {
      const actor = requireOperatorRole(req, 'agent.knowledge', ['admin', 'operator']);
      const agentId = String(req.params.id), workspaceId = workspaceIdFromRequest(req) || 'default';
      assertKnowledgeAgent(agentId, workspaceId);
      res.locals.knowledge = { agentId, workspaceId, actorId: actor.id || 'local' };
      res.locals.knowledgeActor = actor;
      next();
    } catch (error) { sendError(res, error); }
  });
  router.get('/', (_req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(knowledgeCatalog(res.locals.knowledge.agentId, res.locals.knowledge.workspaceId));
    } catch (error) { sendError(res, error); }
  });
  router.post('/upload', raw({ type: 'application/octet-stream', limit: MAX_DOCUMENT_BYTES }), async (req, res) => {
    let admitted = false;
    try {
      const body = z.object({ scope: z.enum(['agent_private', 'team_shared']), teamId: z.string().max(100).optional() }).strict().safeParse(req.query);
      if (!body.success) throw new HttpError(400, 'KNOWLEDGE_SCOPE_INVALID', 'Choose an Agent-private or Team-shared destination');
      const scope = body.data.scope, input = res.locals.knowledge;
      const ownerId = scope === 'agent_private' ? input.agentId : body.data.teamId;
      if (!ownerId) throw new HttpError(400, 'KNOWLEDGE_TEAM_REQUIRED', 'Select a Team');
      assertKnowledgeOwner(input.agentId, input.workspaceId, scope, ownerId);
      if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'INVALID_UPLOAD', 'Send application/octet-stream');
      const title = decodeURIComponent(String(req.header('X-Document-Name') || ''));
      if (!title || title.length > 200 || /[\\/\x00-\x1f]/.test(title)) throw new HttpError(400, 'INVALID_NAME', 'Invalid filename');
      if (parsing >= 2) throw new HttpError(429, 'PARSER_BUSY', 'Document parser is busy; try again shortly');
      parsing++; admitted = true;
      const passages = await parseSessionDocument(title, req.body);
      const source = createKnowledgeSource({ ...input, scope, ownerId, title, bytes: req.body, passages });
      createOperatorAction({ action: 'agent.knowledge.upload', actor: res.locals.knowledgeActor,
        targetType: 'agent', targetId: input.agentId, metadata: { workspaceId: input.workspaceId, sourceId: source.sourceId,
          bindingId: source.bindingId, scope, ownerId, sourceHash: source.sourceHash } });
      res.status(201).json(source);
    } catch (error) {
      sendError(res, error instanceof HttpError ? error : new HttpError(400, 'DOCUMENT_PARSE_FAILED',
        error instanceof Error ? error.message : 'Unable to parse document'));
    } finally { if (admitted) parsing--; }
  });
  router.post('/bindings', (req, res) => {
    try {
      const input = res.locals.knowledge;
      const { sourceId } = parseBody(z.object({ sourceId: z.string().uuid() }).strict(), req);
      const source = bindKnowledgeSource(input.agentId, input.workspaceId, sourceId);
      createOperatorAction({ action: 'agent.knowledge.bind', actor: res.locals.knowledgeActor,
        targetType: 'agent', targetId: input.agentId, metadata: { workspaceId: input.workspaceId, sourceId, bindingId: source.bindingId } });
      res.json(source);
    } catch (error) { sendError(res, error); }
  });
  router.delete('/bindings/:bindingId', (req, res) => {
    try {
      requireConfirmation(req, 'agent.knowledge.unbind');
      unbindKnowledgeSource(res.locals.knowledge.agentId, res.locals.knowledge.workspaceId, String(req.params.bindingId));
      createOperatorAction({ action: 'agent.knowledge.unbind', actor: res.locals.knowledgeActor,
        targetType: 'agent', targetId: res.locals.knowledge.agentId, metadata: {
          workspaceId: res.locals.knowledge.workspaceId, bindingId: String(req.params.bindingId) } });
      res.json({ ok: true });
    } catch (error) { sendError(res, error); }
  });
  router.delete('/sources/:sourceId', (req, res) => {
    try {
      requireConfirmation(req, 'agent.knowledge.delete');
      deleteKnowledgeSource(res.locals.knowledge.agentId, res.locals.knowledge.workspaceId, String(req.params.sourceId));
      createOperatorAction({ action: 'agent.knowledge.delete', actor: res.locals.knowledgeActor,
        targetType: 'agent', targetId: res.locals.knowledge.agentId, metadata: {
          workspaceId: res.locals.knowledge.workspaceId, sourceId: String(req.params.sourceId), recoverable: 'tombstone' } });
      res.json({ ok: true });
    } catch (error) { sendError(res, error); }
  });
  return router;
}
