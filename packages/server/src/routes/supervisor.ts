import { Router } from 'express';
import { intentClassifier } from '../agents/intent-classifier.js';
import { MasterAgent } from '../agents/master-agent.js';
import { guardrails } from '../agents/safety-guardrails.js';
import { TaskQueue } from '../queue/task-queue.js';
import { PipelineEngine } from '../pipelines/pipeline-engine.js';
import { createTask, getTask, addTaskLog } from '../db/models/task.js';
import { eventBus } from '../events/event-bus.js';

export function createSupervisorRoutes(taskQueue: TaskQueue, pipelineEngine: PipelineEngine): Router {
  const router = Router();
  const masterAgent = new MasterAgent(taskQueue);

  /**
   * POST /api/supervisor/dispatch
   * Supervisor mode: single input, auto-classifies and dispatches
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

      // 3. Dispatch based on intent
      let result: any;

      switch (intent.suggestedMode) {
        case 'direct': {
          const task = await taskQueue.enqueue({
            title: input.slice(0, 80),
            description: input,
            mode: 'direct',
            assigneeId: intent.suggestedAgent,
            input,
            priority: 'normal',
          });
          result = { mode: 'direct', task, intent };
          break;
        }

        case 'pipeline': {
          if (intent.suggestedTemplate) {
            const pipeline = await pipelineEngine.create({
              name: input.slice(0, 60),
              templateId: intent.suggestedTemplate,
              input,
              gateMode: 'auto',
            });
            result = { mode: 'pipeline', pipeline, intent };
          } else {
            // No template found, fall back to master mode
            const task = await taskQueue.enqueue({
              title: input.slice(0, 80),
              description: input,
              mode: 'master',
              input,
              priority: 'normal',
            });
            await masterAgent.decompose(task);
            result = { mode: 'master', task, intent };
          }
          break;
        }

        case 'master': {
          const task = await taskQueue.enqueue({
            title: input.slice(0, 80),
            description: input,
            mode: 'master',
            input,
            priority: 'normal',
          });
          await masterAgent.decompose(task);
          result = { mode: 'master', task, intent };
          break;
        }
      }

      res.status(201).json(result);
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

  return router;
}
