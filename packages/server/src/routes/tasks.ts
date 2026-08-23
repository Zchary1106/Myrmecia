import { Router } from 'express';
import { z } from 'zod';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { listTasks, getTask, updateTask, deleteTask, getTaskLogs } from '../db/models/task.js';
import { listQualityLoopAttempts } from '../db/models/quality-loop.js';
import { createOperatorAction } from '../db/models/operator-action.js';
import { TaskQueue } from '../queue/task-queue.js';
import { HttpError, notFound, parseBody, parseQuery, requireConfirmation, requireOperatorRole, sendError } from './http.js';
import { requestCanAccessWorkspace, workspaceIdFromRequest } from '../auth/tenant.js';
import type { Task } from '../types.js';
import { getModel } from '../models/model-registry.js';
import { getLatestTaskCheckpoint, listTaskCheckpoints } from '../db/models/execution-context.js';
import { checkpointExecutionContext, loadExecutionContext, persistExecutionContext } from '../agents/execution-context.js';
import { listAgents } from '../db/models/agent.js';

const taskStatusSchema = z.enum(['pending', 'queued', 'assigned', 'running', 'waiting_for_tool', 'review', 'done', 'failed', 'cancelled']);
const taskModeSchema = z.enum(['master', 'direct', 'pipeline']);
const prioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);

const createTaskSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  mode: taskModeSchema,
  priority: prioritySchema.optional(),
  assigneeId: z.string().trim().min(1).optional(),
  input: z.string().trim().min(1).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  contextLength: z.number().int().min(8_000).max(10_000_000).optional(),
  workspacePath: z.string().trim().min(1).max(16_384).optional(),
  domainId: z.string().trim().min(1).optional(),
});

const listTasksQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  mode: taskModeSchema.optional(),
  assignee: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const updateTaskSchema = z.object({
  status: taskStatusSchema.optional(),
  assigneeId: z.string().trim().min(1).nullable().optional(),
  output: z.string().nullable().optional(),
  workspacePath: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  retryCount: z.number().int().min(0).optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'At least one field must be provided' });

const logsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  since: z.string().optional(),
});

function validateWorkspacePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!isAbsolute(value)) throw new HttpError(400, 'INVALID_WORKSPACE_PATH', 'Workspace path must be absolute');
  const workspacePath = resolve(value);
  if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
    throw new HttpError(400, 'INVALID_WORKSPACE_PATH', 'Workspace directory does not exist');
  }
  return workspacePath;
}

function validateModelId(value: string | undefined): string | undefined {
  if (!value || value === 'auto') return undefined;
  const model = getModel(value);
  if (!model || !model.enabled) throw new HttpError(400, 'INVALID_MODEL', 'Selected model is not enabled');
  return model.id;
}

function getAccessibleTask(req: any, taskId: string): Task {
  const task = getTask(taskId);
  if (!task || !requestCanAccessWorkspace(req, task.workspaceId)) {
    notFound('TASK_NOT_FOUND', 'Task not found');
  }
  return task;
}

export function createTaskRoutes(taskQueue: TaskQueue): Router {
  const router = Router();

  // Create task
  router.post('/', async (req, res) => {
    try {
      const { title, description, mode, priority, assigneeId, input, modelId, reasoningEffort, contextLength, workspacePath: requestedWorkspacePath, domainId } = parseBody(createTaskSchema, req);
      const actor = requireOperatorRole(req, 'task.create', ['admin', 'operator']);
      const workspaceId = workspaceIdFromRequest(req);
      const workspacePath = validateWorkspacePath(requestedWorkspacePath);
      const selectedModelId = validateModelId(modelId);
      const task = await taskQueue.enqueue({
        title,
        description: description || title,
        mode,
        priority,
        assigneeId,
        input: input || description || title,
        modelId: selectedModelId,
        reasoningEffort,
        contextLength,
        workspacePath,
        workspaceId,
        domainId,
      });
      createOperatorAction({
        action: 'task.create',
        actor,
        targetType: 'task',
        targetId: task.id,
        taskId: task.id,
        metadata: { mode: task.mode, priority: task.priority, assigneeId: task.assigneeId },
      });
      res.status(201).json(task);
    } catch (err) {
      sendError(res, err);
    }
  });

  // List tasks
  router.get('/', (req, res) => {
    try {
      const { status, mode, assignee, limit, offset } = parseQuery(listTasksQuerySchema, req);
      const tasks = listTasks({ status, mode, assigneeId: assignee, workspaceId: workspaceIdFromRequest(req), limit, offset });
      res.json(tasks);
    } catch (err) {
      sendError(res, err);
    }
  });

  // Get task detail
  router.get('/:id', (req, res) => {
    try {
      const task = getAccessibleTask(req, req.params.id);
      res.json(task);
    } catch (err) {
      sendError(res, err);
    }
  });

  // Update task
  router.patch('/:id', (req, res) => {
    try {
      getAccessibleTask(req, req.params.id);
      const updated = updateTask(req.params.id, parseBody(updateTaskSchema, req));
      res.json(updated);
    } catch (err) {
      sendError(res, err);
    }
  });

  // Cancel task
  router.post('/:id/cancel', async (req, res) => {
    try {
      const task = getAccessibleTask(req, req.params.id);
      const actor = requireOperatorRole(req, 'task.cancel', ['admin', 'operator']);
      requireConfirmation(req, 'task.cancel');
      const cancelled = await taskQueue.cancelTask(req.params.id);
      createOperatorAction({
        action: 'task.cancel',
        actor,
        targetType: 'task',
        targetId: req.params.id,
        taskId: req.params.id,
        metadata: { previousStatus: task.status },
      });
      res.json(cancelled);
    } catch (err) {
      sendError(res, err);
    }
  });

  // Retry task
  router.post('/:id/retry', async (req, res) => {
    try {
      const task = getAccessibleTask(req, req.params.id);
      const actor = requireOperatorRole(req, 'task.retry', ['admin', 'operator']);
      if (task.mode === 'pipeline' && task.assigneeId === 'social-publisher') {
        throw new HttpError(
          409,
          'PUBLISH_TASK_RETRY_FORBIDDEN',
          'Publish tasks cannot be retried directly; retry the pipeline stage with publish confirmation',
        );
      }
      const retried = await taskQueue.retryTask(req.params.id);
      createOperatorAction({
        action: 'task.retry',
        actor,
        targetType: 'task',
        targetId: req.params.id,
        taskId: req.params.id,
        metadata: { previousStatus: task.status, retryCount: retried.retryCount },
      });
      res.json(retried);
    } catch (err: any) {
      sendError(res, err?.message?.includes('not retryable')
        ? new HttpError(400, 'TASK_RETRY_FAILED', err.message)
        : err);
    }
  });

  // Delete task
  router.delete('/:id', (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'task.delete', ['admin']);
      requireConfirmation(req, 'task.delete');
      const task = getAccessibleTask(req, req.params.id);
      const deleted = deleteTask(req.params.id);
      if (!deleted) notFound('TASK_NOT_FOUND', 'Task not found');
      createOperatorAction({
        action: 'task.delete',
        actor,
        targetType: 'task',
        targetId: req.params.id,
        taskId: req.params.id,
        metadata: { title: task?.title, previousStatus: task?.status },
      });
      res.json({ success: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Get task logs
  router.get('/:id/logs', (req, res) => {
    try {
      const { limit, since } = parseQuery(logsQuerySchema, req);
      getAccessibleTask(req, req.params.id);
      const logs = getTaskLogs(req.params.id, { limit, since });
      res.json(logs);
    } catch (err) {
      sendError(res, err);
    }
  });

  // Get quality-loop review/fix attempt history
  router.get('/:id/quality-attempts', (req, res) => {
    try {
      getAccessibleTask(req, req.params.id);
      res.json(listQualityLoopAttempts({ taskId: req.params.id }));
    } catch (err) {
      sendError(res, err);
    }
  });

  // Durable context and append-only checkpoints are read-only evidence for operators.
  router.get('/:id/context', (req, res) => {
    try {
      const task = getAccessibleTask(req, req.params.id);
      res.json(loadExecutionContext(task));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/:id/checkpoints', (req, res) => {
    try {
      getAccessibleTask(req, req.params.id);
      res.json(listTaskCheckpoints(req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  // Resume is intentionally a re-queue from the latest checkpoint, never a claim that
  // the interrupted process itself can be resumed.
  router.post('/:id/resume', async (req, res) => {
    try {
      const task = getAccessibleTask(req, req.params.id);
      const actor = requireOperatorRole(req, 'task.retry', ['admin', 'operator']);
      const latest = getLatestTaskCheckpoint(task.id);
      if (!latest) throw new HttpError(409, 'TASK_CHECKPOINT_MISSING', 'Task has no checkpoint to resume from');
      const context = loadExecutionContext(task);
      checkpointExecutionContext(context, {
        phase: 'resuming',
        completed: latest.completed,
        pending: ['agent execution'],
        blocked: [],
        lastValidation: latest.lastValidation,
        resumeHint: 'Operator requested a re-queue from the latest checkpoint.',
      });
      const resumed = await taskQueue.retryTask(task.id);
      createOperatorAction({
        action: 'task.retry', actor, targetType: 'task', targetId: task.id, taskId: task.id,
        metadata: { previousStatus: task.status, checkpointId: latest.id, resumedFromCheckpoint: true },
      });
      res.json(resumed);
    } catch (err: any) {
      sendError(res, err?.message?.includes('not retryable')
        ? new HttpError(400, 'TASK_RESUME_FAILED', err.message)
        : err);
    }
  });

  // Replanning is deliberately a new, independent planning task. It retains a
  // durable source-task reference in ExecutionContext, rather than pretending
  // that a failed process or its old plan can be resumed.
  router.post('/:id/replan', async (req, res) => {
    try {
      const task = getAccessibleTask(req, req.params.id);
      const actor = requireOperatorRole(req, 'task.replan', ['admin', 'operator']);
      const planner = listAgents({ workspaceId: task.workspaceId }).find(agent => agent.role === 'orchestrator')
        || listAgents({ workspaceId: task.workspaceId }).find(agent => agent.id === 'master');
      const input = [
        'Create a revised execution plan for the task below. Do not modify files.',
        'Return a concise ordered plan, acceptance checks, risks, and the first executable next step.',
        `Original task: ${task.description || task.title}`,
        task.error ? `Previous failure: ${task.error}` : '',
      ].filter(Boolean).join('\n\n');
      const replanned = await taskQueue.enqueue({
        title: `Replan: ${task.title}`.slice(0, 160),
        description: input,
        input,
        mode: 'direct',
        priority: task.priority,
        assigneeId: planner?.id,
        modelId: task.modelId,
        reasoningEffort: task.reasoningEffort,
        contextLength: task.contextLength,
        workdir: task.workdir,
        workspacePath: task.workspacePath,
        workspaceId: task.workspaceId,
        domainId: task.domainId,
      });
      const context = loadExecutionContext(replanned);
      checkpointExecutionContext(context, {
        phase: 'replanning', completed: [], pending: ['revised plan'], blocked: [],
        resumeHint: `Created from task ${task.id}; review the plan before starting new implementation work.`,
      });
      // Preserve a reference without setting Task.parentTaskId: that field has
      // scheduling semantics for Master and must not turn the old task into a parent.
      persistExecutionContext(replanned, {
        parentTaskId: task.id,
        goal: `Replan the failed or completed work: ${task.description || task.title}`,
        constraints: [`Source task: ${task.id}`, ...(task.error ? [`Previous failure: ${task.error}`] : [])],
      });
      createOperatorAction({
        action: 'task.replan', actor, targetType: 'task', targetId: replanned.id, taskId: replanned.id,
        metadata: { sourceTaskId: task.id },
      });
      res.status(201).json(replanned);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
