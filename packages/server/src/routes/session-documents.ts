import { Router, raw } from 'express';
import { getTask } from '../db/models/task.js';
import { requestCanAccessWorkspace } from '../auth/tenant.js';
import { HttpError, requireOperatorRole, requireConfirmation, sendError } from './http.js';
import { MAX_DOCUMENT_BYTES, parseSessionDocument } from '../knowledge/session-document-parser.js';
import { listSessionDocuments, sessionDocument, storeSessionDocument } from '../knowledge/session-documents.js';
import { getDb } from '../db/database.js';

export function createSessionDocumentRoutes(): Router {
  const router = Router();
  router.use('/:taskId/documents', (req, res, next) => {
    const task = getTask(req.params.taskId);
    if (!task || !requestCanAccessWorkspace(req, task.workspaceId)) {
      res.status(404).json({ error: { message: 'Session not found' } }); return;
    }
    res.locals.task = task;
    next();
  });
  router.get('/:taskId/documents', (_req, res) => res.json(listSessionDocuments(res.locals.task)));
  let parsing = 0;
  router.post('/:taskId/documents',
    (req, res, next) => {
      try { requireOperatorRole(req, 'session.document.upload', ['admin', 'operator']); next(); }
      catch (error) { sendError(res, error); }
    },
    raw({ type: 'application/octet-stream', limit: MAX_DOCUMENT_BYTES }),
    async (req, res) => {
      let admitted = false;
      try {
        if (parsing >= 2) throw new HttpError(429, 'PARSER_BUSY', 'Document parser is busy; try again shortly');
        if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'INVALID_UPLOAD', 'Send the file as application/octet-stream');
        const name = decodeURIComponent(String(req.headers['x-document-name'] || ''));
        if (!name || name.length > 200 || /[\\/\x00-\x1f]/.test(name)) throw new HttpError(400, 'INVALID_NAME', 'Invalid filename');
        if (listSessionDocuments(res.locals.task).length >= 10) throw new HttpError(400, 'DOCUMENT_LIMIT', 'A session supports at most 10 documents');
        parsing++; admitted = true;
        const passages = await parseSessionDocument(name, req.body);
        res.status(201).json(storeSessionDocument(res.locals.task, name, req.body, passages));
      } catch (error) {
        sendError(res, error instanceof HttpError ? error : new HttpError(400, 'DOCUMENT_PARSE_FAILED', error instanceof Error ? error.message : 'Unable to parse document'));
      } finally { if (admitted) parsing--; }
    });
  router.get('/:taskId/documents/:id', (req, res) => {
    const doc = sessionDocument(res.locals.task, req.params.id);
    if (!doc) { res.status(404).json({ error: { message: 'Document not found' } }); return; }
    res.json({ id: doc.id, name: doc.name, passages: JSON.parse(doc.passages) });
  });
  router.delete('/:taskId/documents/:id', (req, res) => {
    try {
      requireOperatorRole(req, 'session.document.remove', ['admin', 'operator']);
      requireConfirmation(req, 'session.document.remove');
      const doc = sessionDocument(res.locals.task, req.params.id);
      if (!doc) throw new HttpError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      getDb().run('DELETE FROM session_documents WHERE id = ?', doc.id);
      res.json({ ok: true });
    } catch (error) { sendError(res, error); }
  });
  return router;
}
