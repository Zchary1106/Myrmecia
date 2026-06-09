/**
 * Graph Workflow REST API — /api/v1/graph-workflows
 *
 * CRUD for visual agent graphs plus run / replay / resume / cancel and run-event
 * history for replay/audit.
 */

import { Router } from 'express';
import {
  createGraphWorkflow,
  getGraphWorkflow,
  listGraphWorkflows,
  updateGraphWorkflow,
  deleteGraphWorkflow,
  listGraphRunEvents,
  type GraphWorkflowEngine,
} from '../agents/graph-workflow.js';

export function createGraphWorkflowRoutes(engine: GraphWorkflowEngine): Router {
  const router = Router();

  const ws = (req: any): string | undefined => req.tenantContext?.workspaceId || undefined;

  // GET / — list graphs
  router.get('/', (req, res) => {
    res.json(listGraphWorkflows({ workspaceId: ws(req) }));
  });

  // GET /:id — get one
  router.get('/:id', (req, res) => {
    const wf = getGraphWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: { message: 'workflow not found' } });
    res.json(wf);
  });

  // POST / — create
  router.post('/', (req, res) => {
    const { name, description, graph, input } = req.body || {};
    if (!name) return res.status(400).json({ error: { message: 'name required' } });
    const wf = createGraphWorkflow({ name, description, graph, input, workspaceId: ws(req) });
    res.status(201).json(wf);
  });

  // PATCH /:id — update (canvas save)
  router.patch('/:id', (req, res) => {
    const existing = getGraphWorkflow(req.params.id);
    if (!existing) return res.status(404).json({ error: { message: 'workflow not found' } });
    const { name, description, graph, input } = req.body || {};
    const wf = updateGraphWorkflow(req.params.id, { name, description, graph, input });
    res.json(wf);
  });

  // DELETE /:id
  router.delete('/:id', (req, res) => {
    const ok = deleteGraphWorkflow(req.params.id);
    if (!ok) return res.status(404).json({ error: { message: 'workflow not found' } });
    res.json({ ok: true, id: req.params.id });
  });

  // POST /:id/run
  router.post('/:id/run', async (req, res) => {
    try {
      const wf = await engine.run(req.params.id, req.body?.input);
      res.json(wf);
    } catch (err: any) {
      res.status(400).json({ error: { message: err.message } });
    }
  });

  // POST /:id/replay
  router.post('/:id/replay', async (req, res) => {
    try {
      res.json(await engine.replay(req.params.id, req.body?.input));
    } catch (err: any) {
      res.status(400).json({ error: { message: err.message } });
    }
  });

  // POST /:id/resume
  router.post('/:id/resume', async (req, res) => {
    try {
      res.json(await engine.resume(req.params.id));
    } catch (err: any) {
      res.status(400).json({ error: { message: err.message } });
    }
  });

  // POST /:id/cancel
  router.post('/:id/cancel', (req, res) => {
    const wf = engine.cancel(req.params.id);
    if (!wf) return res.status(404).json({ error: { message: 'workflow not found' } });
    res.json(wf);
  });

  // GET /:id/events?runId=... — run journal
  router.get('/:id/events', (req, res) => {
    const wf = getGraphWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: { message: 'workflow not found' } });
    const runId = (req.query.runId as string) || wf.runState?.runId;
    if (!runId) return res.json([]);
    res.json(listGraphRunEvents(runId));
  });

  return router;
}
