import { Router } from 'express';
import { z } from 'zod';
import { listTasks, getTask, updateTask, deleteTask, getTaskLogs } from '../db/models/task.js';
import { listQualityLoopAttempts } from '../db/models/quality-loop.js';
import { createOperatorAction } from '../db/models/operator-action.js';
import { TaskQueue } from '../queue/task-queue.js';
import { HttpError, notFound, parseBody, parseQuery, requireConfirmation, requireOperatorRole, sendError } from './http.js';

const taskStatusSchema = z.enum(['pending', 'queued', 'assigned', 'running', 'review', 'done', 'failed', 'cancelled']);
const taskModeSchema = z.enum(['master', 'direct', 'pipeline']);
const prioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);

const createTaskSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  mode: taskModeSchema,
  priority: prioritySchema.optional(),
  assigneeId: z.string().trim().min(1).optional(),
  input: z.string().trim().min(1).optional(),
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

export function createTaskRoutes(taskQueue: TaskQueue): Router {
  const router = Router();

  // Create task
  router.post('/', async (req, res) => {
    try {
      const { title, description, mode, priority, assigneeId, input } = parseBody(createTaskSchema, req);
      const actor = requireOperatorRole(req, 'task.create', ['admin', 'operator']);
      const task = await taskQueue.enqueue({
        title,
        description: description || title,
        mode,
        priority,
        assigneeId,
        input: input || description || title,
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
      const tasks = listTasks({ status, mode, assigneeId: assignee, limit, offset });
      res.json(tasks);
    } catch (err) {
      sendError(res, err);
    }
  });

  // Get task detail
  router.get('/:id', (req, res) => {
    try {
      const task = getTask(req.params.id);
      if (!task) notFound('TASK_NOT_FOUND', 'Task not found');
      res.json(task);
    } catch (err) {
      sendError(res, err);
    }
  });

  // Update task
  router.patch('/:id', (req, res) => {
    try {
      const task = getTask(req.params.id);
      if (!task) notFound('TASK_NOT_FOUND', 'Task not found');
      const updated = updateTask(req.params.id, parseBody(updateTaskSchema, req));
      res.json(updated);
    } catch (err) {
      sendError(res, err);
    }
  });

  // Cancel task
  router.post('/:id/cancel', async (req, res) => {
    try {
      const task = getTask(req.params.id);
      if (!task) notFound('TASK_NOT_FOUND', 'Task not found');
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
      const task = getTask(req.params.id);
      if (!task) notFound('TASK_NOT_FOUND', 'Task not found');
      const actor = requireOperatorRole(req, 'task.retry', ['admin', 'operator']);
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
      const task = getTask(req.params.id);
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
      const logs = getTaskLogs(req.params.id, { limit, since });
      res.json(logs);
    } catch (err) {
      sendError(res, err);
    }
  });

  // Get quality-loop review/fix attempt history
  router.get('/:id/quality-attempts', (req, res) => {
    try {
      const task = getTask(req.params.id);
      if (!task) notFound('TASK_NOT_FOUND', 'Task not found');
      res.json(listQualityLoopAttempts({ taskId: req.params.id }));
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
