import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';
import { getExecution, listExecutions, listExecutionMessages, updateExecution } from '../db/models/execution.js';
import { listLedgerEntries } from '../db/models/execution-ledger.js';
import { addTaskLog, getTask, updateTask } from '../db/models/task.js';
import { agentRuntime } from '../agents/agent-runtime.js';
import { messageBus } from '../agents/message-bus.js';
import { eventBus } from '../events/event-bus.js';
import { getRunTraceByExecution } from '../db/models/trace.js';
import { requestCanAccessWorkspace, workspaceIdFromRequest } from '../auth/tenant.js';
import type { TaskExecution } from '../types.js';

const router: ExpressRouter = Router();

function executionWorkspaceId(execution: TaskExecution): string {
  return execution.workspaceId || getTask(execution.taskId)?.workspaceId || 'default';
}

function getAccessibleExecution(req: any, executionId: string): TaskExecution | undefined {
  const execution = getExecution(executionId);
  if (!execution || !requestCanAccessWorkspace(req, executionWorkspaceId(execution))) return undefined;
  return execution;
}

// GET /api/executions — list all executions
router.get('/', (req, res) => {
  const { taskId, agentDefId, status, limit } = req.query;
  const executions = listExecutions({
    taskId: taskId as string,
    agentDefId: agentDefId as string,
    status: status as any,
    workspaceId: workspaceIdFromRequest(req),
    limit: limit ? Number(limit) : 50,
  });
  res.json(executions);
});

// GET /api/executions/:id — get execution details
router.get('/:id', (req, res) => {
  const execution = getAccessibleExecution(req, req.params.id);
  if (!execution) return res.status(404).json({ error: { message: 'Execution not found' } });
  res.json(execution);
});

// GET /api/executions/:id/messages — get execution message stream
router.get('/:id/messages', (req, res) => {
  const execution = getAccessibleExecution(req, req.params.id);
  if (!execution) return res.status(404).json({ error: { message: 'Execution not found' } });
  const { afterId, limit } = req.query;
  const messages = listExecutionMessages(req.params.id, {
    afterId: afterId ? Number(afterId) : undefined,
    limit: limit ? Number(limit) : 200,
  });
  res.json(messages);
});

// GET /api/executions/:id/trace — get structured run trace and spans
router.get('/:id/trace', (req, res) => {
  const execution = getAccessibleExecution(req, req.params.id);
  if (!execution) return res.status(404).json({ error: { message: 'Execution not found' } });
  res.json(getRunTraceByExecution(req.params.id) || null);
});

// GET /api/executions/:id/ledger — get the ordered decision ledger for replay/audit
router.get('/:id/ledger', (req, res) => {
  const execution = getAccessibleExecution(req, req.params.id);
  if (!execution) return res.status(404).json({ error: { message: 'Execution not found' } });
  res.json(listLedgerEntries({ executionId: req.params.id }));
});

// POST /api/executions/:id/cancel — cancel a running execution
router.post('/:id/cancel', (req, res) => {
  const execution = getAccessibleExecution(req, req.params.id);
  if (!execution) return res.status(404).json({ error: { message: 'Execution not found' } });
  if (execution.status !== 'running') return res.status(400).json({ error: { message: 'Execution is not running' } });

  agentRuntime.cancel(execution.taskId);
  updateExecution(execution.id, { status: 'cancelled', completedAt: new Date().toISOString() });
  const task = updateTask(execution.taskId, { status: 'cancelled', completedAt: new Date().toISOString() });
  addTaskLog(execution.taskId, 'warn', `Execution ${execution.id} cancelled by user`, 'system');
  eventBus.emit('task:cancelled', { taskId: execution.taskId, task, workspaceId: executionWorkspaceId(execution) });
  res.json({ ok: true });
});

// POST /api/executions/:id/message — send a message to a running execution (mailbox)
router.post('/:id/message', (req, res) => {
  const execution = getAccessibleExecution(req, req.params.id);
  if (!execution) return res.status(404).json({ error: { message: 'Execution not found' } });

  const { content, messageType = 'text' } = req.body;
  if (!content) return res.status(400).json({ error: { message: 'content is required' } });

  const msg = messageBus.send(null, execution.id, messageType, content);
  res.json(msg);
});

// GET /api/executions/:id/agent-messages — get inter-agent messages
router.get('/:id/agent-messages', (req, res) => {
  const execution = getAccessibleExecution(req, req.params.id);
  if (!execution) return res.status(404).json({ error: { message: 'Execution not found' } });
  const messages = messageBus.listForExecution(req.params.id);
  res.json(messages);
});

export default router;
