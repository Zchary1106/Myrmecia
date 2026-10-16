import { Router } from 'express';
import { z } from 'zod';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createTask, listTasks, getTask, updateTask, deleteTask, getTaskLogs } from '../db/models/task.js';
import { listQualityLoopAttempts } from '../db/models/quality-loop.js';
import { createOperatorAction } from '../db/models/operator-action.js';
import { TaskQueue } from '../queue/task-queue.js';
import { HttpError, notFound, parseBody, parseQuery, requireConfirmation, requireOperatorRole, sendError } from './http.js';
import { requestCanAccessWorkspace, workspaceIdFromRequest } from '../auth/tenant.js';
import type { Task } from '../types.js';
import { validateModelId, validateRequestedModelId } from './model-selection.js';
import { getLatestTaskCheckpoint, listTaskCheckpoints } from '../db/models/execution-context.js';
import { checkpointExecutionContext, loadExecutionContext, persistExecutionContext, persistInheritedExecutionContext } from '../agents/execution-context.js';
import { listAgents, getAgent } from '../db/models/agent.js';
import { taskControlCapabilities } from '../agents/task-controls.js';
import { budgetUsage } from '../agents/budget-service.js';
import { setupEntity } from '../agents/agent-setup.js';
import { getAgentSetupSnapshot, pinAgentSetup } from '../agents/agent-setup-snapshot.js';
import { getDb } from '../db/database.js';
import { continuationInput } from '../agents/task-continuation.js';
import { listExecutions } from '../db/models/execution.js';
import { isWaitingForAgentInput } from '@myrmecia/shared';
import { getExternalAgent, getExternalAgentRunForExecution } from '../db/models/external-agent.js';
import { getExternalAgentRuntime } from '../agents/external-agent-runtime.js';
import { eventBus } from '../events/event-bus.js';
import { completionCriteriaSchema } from '../agents/completion-gate.js';
import { getWorkspaceBinding } from '../db/models/managed-workspace.js';
import { grantTaskTestAuthorization, taskTestAuthorization, revokeTaskTestAuthorization } from '../testing/task-test-authorization.js';

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
  filesystemWorkspaceId: z.string().max(100).optional(),
  workspaceAccessMode: z.enum(['isolated', 'shared_readonly', 'shared_write']).optional(),
  domainId: z.string().trim().min(1).optional(),
  completionCriteria: completionCriteriaSchema.optional(),
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

function getAccessibleTask(req: any, taskId: string): Task {
  const task = getTask(taskId);
  if (!task || !requestCanAccessWorkspace(req, task.workspaceId)) {
    notFound('TASK_NOT_FOUND', 'Task not found');
  }
  return task;
}

export function createTaskRoutes(taskQueue: TaskQueue): Router {
  const router = Router();
  router.get('/:id/test-authorization', (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ authorization: taskTestAuthorization(getAccessibleTask(req, String(req.params.id))) || null });
    } catch (error) { sendError(res, error instanceof HttpError ? error : new HttpError(409, 'TEST_AUTH_SCOPE_CHANGED', String(error))); }
  });
  router.post('/:id/test-authorization', (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'task.test.authorize', ['admin', 'operator']);
      const task = getAccessibleTask(req, String(req.params.id));
      requireConfirmation(req, 'task.test.authorize');
      const body = parseBody(z.object({ command: z.literal('npm test'), confirm: z.boolean().optional(),
        confirmation: z.string().optional() }).strict(), req);
      res.status(201).json({ authorization: grantTaskTestAuthorization(task, actor, body.command) });
    } catch (error) { sendError(res, error instanceof HttpError ? error : new HttpError(409, 'TEST_AUTH_DENIED', String(error))); }
  });
  router.post('/:id/test-authorization/revoke', (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'task.test.revoke', ['admin', 'operator']);
      const task = getAccessibleTask(req, String(req.params.id));
      requireConfirmation(req, 'task.test.revoke');
      revokeTaskTestAuthorization(task, actor);
      res.json({ revoked: true });
    } catch (error) { sendError(res, error instanceof HttpError ? error : new HttpError(409, 'TEST_AUTH_DENIED', String(error))); }
  });
  router.get('/:id/controls', (req, res) => {
    try {
      requireOperatorRole(req, 'task.controls', ['admin', 'operator']);
      res.setHeader('Cache-Control', 'no-store');
      res.json(taskControlCapabilities(getAccessibleTask(req, String(req.params.id)), taskQueue));
    } catch (error) { sendError(res, error); }
  });
  router.get('/:id/budget', (req, res) => {
    try {
      requireOperatorRole(req, 'task.budget', ['admin', 'operator']);
      const task = getAccessibleTask(req, String(req.params.id));
      res.setHeader('Cache-Control', 'no-store'); res.json(budgetUsage(task.workspaceId || 'default', task.assigneeId, task.id));
    } catch (error) { sendError(res, error); }
  });
  router.get('/:id/debug-history', (req, res) => {
    try {
      requireOperatorRole(req, 'task.debug-history', ['admin', 'operator']);
      const task = getAccessibleTask(req, String(req.params.id)), workspaceId = task.workspaceId || 'default';
      const root = getDb().get<{ root_task_id: string }>('SELECT root_task_id FROM agent_debug_task_history WHERE workspace_id = ? AND task_id = ?', workspaceId, task.id)?.root_task_id || task.id;
      res.setHeader('Cache-Control', 'no-store');
      res.json([root, ...getDb().all<{ task_id: string }>(`SELECT task_id FROM agent_debug_task_history
        WHERE workspace_id = ? AND root_task_id = ? ORDER BY created_at, rowid LIMIT 100`, workspaceId, root).map(row => row.task_id)]
        .filter((id, index, all) => all.indexOf(id) === index && !!getTask(id)));
    } catch (error) { sendError(res, error); }
  });
  router.post('/:id/rerun', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'task.rerun', ['admin', 'operator']);
      requireConfirmation(req, 'task.rerun');
      const { idempotencyKey } = parseBody(z.object({ idempotencyKey: z.string().uuid(), confirm: z.literal(true) }).strict(), req);
      const original = getAccessibleTask(req, String(req.params.id));
      const prior = setupEntity({ operation: 'debug-rerun', key: idempotencyKey, actorId: actor.id || 'local',
        workspaceId: original.workspaceId || 'default', payload: { taskId: original.id } }, () => {
        const controls = taskControlCapabilities(original, taskQueue);
        if (!controls.operations.rerun.allowed || !original.assigneeId) throw new HttpError(409, 'RERUN_UNSUPPORTED', controls.operations.rerun.reason);
        const task = createTask({ title: original.title, description: original.description, input: original.input,
          mode: 'direct', assigneeId: original.assigneeId, workspaceId: original.workspaceId, createdBy: 'user', maxRetries: 0,
          modelId: original.modelId, contextLength: original.contextLength, reasoningEffort: original.reasoningEffort,
          completionCriteria: original.completionCriteria,
          domainId: original.domainId, workdir: original.workdir, workspacePath: original.workspacePath });
        const versionId = getAgentSetupSnapshot(original.id)?.versionId;
        const agent = getAgent(original.assigneeId);
        if (!agent) throw new HttpError(409, 'AGENT_UNAVAILABLE', 'The original Agent is unavailable');
        pinAgentSetup(task.id, agent, true, versionId);
        persistExecutionContext(task);
        const root = getDb().get<{ root_task_id: string }>('SELECT root_task_id FROM agent_debug_task_history WHERE workspace_id = ? AND task_id = ?',
          original.workspaceId || 'default', original.id)?.root_task_id || original.id;
        getDb().run('INSERT INTO agent_debug_task_history(workspace_id, root_task_id, task_id) VALUES (?,?,?)',
          original.workspaceId || 'default', root, task.id);
        return task.id;
      });
      const task = getTask(prior.id)!;
      await taskQueue.dispatchExisting(task.id);
      res.status(prior.replayed ? 200 : 201).json(task);
    } catch (error) { sendError(res, error); }
  });
  const continuing = new Set<string>();

  // New execution within an existing conversation; never reopen a terminal task.
  router.post('/:id/continue', async (req, res) => {
    let lockedRoot: string | undefined;
    try {
      const actor = requireOperatorRole(req, 'task.continue', ['admin', 'operator']);
      const { content, idempotencyKey } = parseBody(z.object({ content: z.string().trim().min(1).max(8_000), idempotencyKey: z.string().uuid().optional() }), req);
      const original = getAccessibleTask(req, String(req.params.id));
      if (idempotencyKey) {
        const prior = getDb().get<{ entity_id: string }>(`SELECT entity_id FROM agent_setup_requests
          WHERE workspace_id = ? AND actor_id = ? AND operation = 'debug-followup' AND request_key = ?`,
        original.workspaceId || 'default', actor.id || 'local', idempotencyKey);
        if (prior) {
          const entity = setupEntity({ operation: 'debug-followup', key: idempotencyKey, workspaceId: original.workspaceId || 'default',
            actorId: actor.id || 'local', payload: { taskId: original.id, content } }, () => { throw new Error('Unexpected follow-up replay'); });
          const task = getAccessibleTask(req, entity.id);
          await taskQueue.dispatchExisting(task.id);
          return res.json(task);
        }
      }
      let root = getAccessibleTask(req, req.params.id);
      const visited = new Set<string>();
      while (root.parentTaskId) {
        if (visited.has(root.id)) throw new HttpError(409, 'INVALID_SESSION', 'Task ancestry contains a cycle');
        visited.add(root.id);
        root = getAccessibleTask(req, root.parentTaskId);
      }
      if (continuing.has(root.id)) throw new HttpError(409, 'SESSION_BUSY', 'A follow-up is already being scheduled');
      continuing.add(root.id);
      lockedRoot = root.id;
      const family: Task[] = [root];
      const pending = [root.id];
      const known = new Set(pending);
      while (pending.length) {
        for (const child of listTasks({ parentTaskId: pending.shift()!, workspaceId: root.workspaceId })) {
          if (known.has(child.id)) continue;
          known.add(child.id);
          family.push(child);
          pending.push(child.id);
        }
      }
      if (family.some(task => !['done', 'failed', 'cancelled'].includes(task.status)
        && !isWaitingForAgentInput(task, listExecutions({ taskId: task.id, workspaceId: task.workspaceId })))) {
        throw new HttpError(409, 'SESSION_BUSY', 'This conversation still has active work. Send an instruction to the running Agent or wait until it settles.');
      }
      const turns = family.filter(task => task.id === root.id || task.createdBy === 'user')
        .sort((a, b) => Date.parse(a.completedAt || a.createdAt) - Date.parse(b.completedAt || b.createdAt));
      const previous = turns[turns.length - 1] || root;
      const context = loadExecutionContext(previous);
      const previousExecution = listExecutions({ taskId: previous.id, workspaceId: root.workspaceId, limit: 1 })[0];
      const externalRun = previousExecution
        ? getExternalAgentRunForExecution(previousExecution.id, root.workspaceId || 'default') : undefined;
      if (externalRun) {
        const externalAgent = getExternalAgent(externalRun.externalAgentId, root.workspaceId || 'default');
        if (!externalAgent || externalAgent.status === 'disabled') {
          throw new HttpError(409, 'AGENT_UNAVAILABLE', 'The original external Agent is unavailable; select a new Agent explicitly');
        }
        const workdir = validateWorkspacePath(context.workdir || context.workspacePath);
        const task = createTask({
          title: content.slice(0, 80), description: content,
          input: continuationInput(root, turns, content, context),
          mode: 'direct', parentTaskId: root.id, createdBy: 'user', maxRetries: 0,
          priority: previous.priority, workspaceId: root.workspaceId, workdir,
          workspacePath: workdir, modelId: context.modelId, reasoningEffort: context.reasoningEffort,
          contextLength: context.contextLength, domainId: previous.domainId,
          completionCriteria: previous.completionCriteria?.length ? previous.completionCriteria : root.completionCriteria,
        });
        persistInheritedExecutionContext(context, task);
        createOperatorAction({
          action: 'task.continue', actor, targetType: 'task', targetId: task.id, taskId: task.id,
          metadata: { sessionRootTaskId: root.id, previousTaskId: previous.id, externalAgentId: externalAgent.id },
        });
        // The new message authorizes a new invocation, not reopening the old
        // remote job or silently routing the user's message to Master instead.
        void getExternalAgentRuntime().run(externalAgent.id, root.workspaceId || 'default', {
          taskId: task.id, parentTaskId: root.id, workspaceId: root.workspaceId || 'default',
          objective: task.input, constraints: context.constraints,
          workdir, modelId: context.modelId, provider: context.provider,
          reasoningEffort: context.reasoningEffort, contextLength: context.contextLength,
        }, 'manual').catch(error => {
          if (['done', 'failed', 'cancelled'].includes(getTask(task.id)?.status || '')) return;
          const failed = updateTask(task.id, {
            status: 'failed', error: error instanceof Error ? error.message : String(error),
            completedAt: new Date().toISOString(),
          });
          eventBus.emit('task:updated', { taskId: task.id, task: failed, workspaceId: root.workspaceId });
        });
        return res.status(201).json(getTask(task.id));
      }
      const availableAgents = listAgents();
      const agent = availableAgents.find(agent => agent.id === previous.assigneeId)
        || availableAgents.find(agent => agent.id === 'master' || agent.role === 'orchestrator');
      if (!agent) throw new HttpError(409, 'AGENT_UNAVAILABLE', 'No Agent is available to continue this conversation');
      const workdir = validateWorkspacePath(context.workdir || context.workspacePath);
      const createFollowup = () => {
        const task = createTask({
        title: content.slice(0, 80),
        description: content,
        input: continuationInput(root, turns, content, context),
        mode: 'direct',
        assigneeId: agent.id,
        parentTaskId: root.id,
        createdBy: 'user',
        priority: previous.priority,
        workspaceId: root.workspaceId,
        workdir,
        workspacePath: workdir,
        modelId: validateModelId(context.modelId),
        reasoningEffort: context.reasoningEffort,
        contextLength: context.contextLength,
        domainId: previous.domainId,
        completionCriteria: previous.completionCriteria?.length ? previous.completionCriteria : root.completionCriteria,
        });
        persistInheritedExecutionContext(context, task);
        const debugRoot = getDb().get<{ root_task_id: string }>('SELECT root_task_id FROM agent_debug_task_history WHERE workspace_id = ? AND task_id = ?',
          root.workspaceId || 'default', original.id)?.root_task_id || original.id;
        getDb().run('INSERT INTO agent_debug_task_history(workspace_id, root_task_id, task_id) VALUES (?,?,?)',
          root.workspaceId || 'default', debugRoot, task.id);
        return task.id;
      };
      const entity = setupEntity({ operation: 'debug-followup', key: idempotencyKey, workspaceId: root.workspaceId || 'default',
        actorId: actor.id || 'local', payload: { taskId: original.id, content } }, createFollowup);
      const task = await taskQueue.dispatchExisting(entity.id);
      createOperatorAction({
        action: 'task.continue', actor, targetType: 'task', targetId: task.id, taskId: task.id,
        metadata: { sessionRootTaskId: root.id, previousTaskId: previous.id },
      });
      res.status(201).json(task);
    } catch (error) {
      sendError(res, error);
    } finally {
      if (lockedRoot) continuing.delete(lockedRoot);
    }
  });

  // Create task
  router.post('/', async (req, res) => {
    try {
      const { title, description, mode, priority, assigneeId, input, modelId, reasoningEffort, contextLength, workspacePath: requestedWorkspacePath, filesystemWorkspaceId, workspaceAccessMode, domainId, completionCriteria } = parseBody(createTaskSchema, req);
      const actor = requireOperatorRole(req, 'task.create', ['admin', 'operator']);
      const workspaceId = workspaceIdFromRequest(req);
      const workspacePath = validateWorkspacePath(requestedWorkspacePath);
      const selectedModelId = await validateRequestedModelId(modelId);
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
        filesystemWorkspaceId, workspaceAccessMode, workspaceActorId: actor.id,
        selectedWorkspaceSource: !!workspacePath,
        workspaceId,
        domainId,
        completionCriteria,
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
      requireOperatorRole(req, 'task.update', ['admin', 'operator']);
      const changes = parseBody(updateTaskSchema, req);
      const binding = getWorkspaceBinding(req.params.id);
      if (binding && changes.workspacePath !== undefined && changes.workspacePath !== binding.executionPath) throw new HttpError(409, 'WORKSPACE_BINDING_IMMUTABLE', 'Create a new task to use a different execution directory');
      const updated = updateTask(req.params.id, changes);
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
      if (task.pauseControl) {
        const resumed = await taskQueue.resumeTask(task.id);
        createOperatorAction({ action: 'task.resume', actor, targetType: 'task', targetId: task.id, taskId: task.id });
        return res.json(resumed);
      }
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

  router.post('/:id/pause', async (req, res) => {
    try {
      const task = getAccessibleTask(req, req.params.id);
      const actor = requireOperatorRole(req, 'task.pause', ['admin', 'operator']);
      const paused = await taskQueue.pauseTask(task.id);
      createOperatorAction({ action: 'task.pause', actor, targetType: 'task', targetId: task.id, taskId: task.id });
      res.json(paused);
    } catch (err) {
      if (err instanceof HttpError) return sendError(res, err);
      sendError(res, new HttpError(409, 'TASK_PAUSE_FAILED', err instanceof Error ? err.message : 'Unable to pause'));
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
