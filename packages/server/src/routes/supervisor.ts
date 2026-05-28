import { Router } from 'express';
import { intentClassifier } from '../agents/intent-classifier.js';
import { guardrails } from '../agents/safety-guardrails.js';
import { TaskQueue } from '../queue/task-queue.js';
import { PipelineEngine } from '../pipelines/pipeline-engine.js';
import { Orchestrator, listOrchestrations, getOrchestration } from '../agents/orchestrator.js';
import { getDb } from '../db/database.js';
import { listTasks, getTask } from '../db/models/task.js';

export function createSupervisorRoutes(taskQueue: TaskQueue, pipelineEngine: PipelineEngine): Router {
  const router = Router();
  const orchestrator = new Orchestrator(taskQueue, pipelineEngine);

  /**
   * POST /api/supervisor/dispatch
   * Unified orchestration entry: classify → orchestrate → dispatch
   */
  router.post('/dispatch', async (req, res) => {
    try {
      const { input } = req.body;
      if (!input) return res.status(400).json({ error: { message: 'input is required' } });

      // 1. Check budget
      const budget = guardrails.checkBudget();
      if (!budget.allowed) {
        return res.status(429).json({ error: { code: 'BUDGET_EXCEEDED', message: budget.reason } });
      }

      // 2. Classify intent
      const intent = await intentClassifier.classify(input);

      // 3. Orchestrate (unified entry — handles trivial, pipeline, and complex)
      const result = await orchestrator.plan(input, intent);

      res.status(201).json({
        orchestrationId: result.orchestration.id,
        mode: intent.suggestedMode,
        intent,
        orchestration: result.orchestration,
        tasks: result.tasks,
      });
    } catch (err: any) {
      res.status(500).json({ error: { code: 'DISPATCH_FAILED', message: err.message } });
    }
  });

  /** POST /api/supervisor/classify — preview intent without dispatching */
  router.post('/classify', async (req, res) => {
    try {
      const { input } = req.body;
      if (!input) return res.status(400).json({ error: { message: 'input is required' } });
      const intent = await intentClassifier.classify(input);
      res.json(intent);
    } catch (err: any) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  /** GET /api/supervisor/guardrails — get current safety config */
  router.get('/guardrails', (req, res) => {
    res.json({
      config: guardrails.getConfig(),
      costs: guardrails.getCostSummary(),
    });
  });

  /** PATCH /api/supervisor/guardrails — update safety config */
  router.patch('/guardrails', (req, res) => {
    guardrails.updateConfig(req.body);
    res.json({ config: guardrails.getConfig() });
  });

  // ==================== Orchestration API ====================

  /** GET /api/orchestrations — list all orchestrations */
  router.get('/orchestrations', (req, res) => {
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;
    const orchestrations = listOrchestrations(limit, offset);
    res.json(orchestrations);
  });

  /** GET /api/orchestrations/:id — orchestration detail with tasks */
  router.get('/orchestrations/:id', (req, res) => {
    const orch = getOrchestration(req.params.id);
    if (!orch) return res.status(404).json({ error: { message: 'Orchestration not found' } });

    const tasks = orch.taskIds.map(id => getTask(id)).filter(Boolean);
    res.json({ ...orch, tasks });
  });

  /** GET /api/orchestrations/:id/messages — agent messages for this orchestration */
  router.get('/orchestrations/:id/messages', (req, res) => {
    const orch = getOrchestration(req.params.id);
    if (!orch) return res.status(404).json({ error: { message: 'Orchestration not found' } });

    const db = getDb();
    // Get all messages between executions of tasks in this orchestration
    const taskIds = orch.taskIds;
    if (taskIds.length === 0) return res.json([]);

    const placeholders = taskIds.map(() => '?').join(',');
    const messages = db.all(`
      SELECT m.*, te.task_id, te.agent_def_id
      FROM agent_messages m
      JOIN task_executions te ON (m.from_execution = te.id OR m.to_execution = te.id)
      WHERE te.task_id IN (${placeholders})
      ORDER BY m.id ASC
    `, ...taskIds);

    res.json(messages);
  });

  /** GET /api/orchestrations/:id/timeline — timeline events */
  router.get('/orchestrations/:id/timeline', (req, res) => {
    const orch = getOrchestration(req.params.id);
    if (!orch) return res.status(404).json({ error: { message: 'Orchestration not found' } });

    const db = getDb();
    const taskIds = orch.taskIds;
    if (taskIds.length === 0) return res.json([]);

    const placeholders = taskIds.map(() => '?').join(',');
    const logs = db.all(`
      SELECT * FROM task_logs
      WHERE task_id IN (${placeholders})
      ORDER BY created_at ASC
    `, ...taskIds);

    res.json(logs);
  });

  return router;
}
