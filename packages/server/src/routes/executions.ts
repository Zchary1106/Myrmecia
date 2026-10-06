import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';
import { addExecutionMessage, getExecution, listExecutions, listExecutionMessages, updateExecution } from '../db/models/execution.js';
import { listLedgerEntries } from '../db/models/execution-ledger.js';
import { addTaskLog, getTask, updateTask } from '../db/models/task.js';
import { agentRuntime } from '../agents/agent-runtime.js';
import { messageBus } from '../agents/message-bus.js';
import { eventBus } from '../events/event-bus.js';
import { getRunTraceByExecution } from '../db/models/trace.js';
import { requestCanAccessWorkspace, workspaceIdFromRequest } from '../auth/tenant.js';
import type { TaskExecution } from '../types.js';
import { sessionDocumentContext } from '../knowledge/session-documents.js';
import { updateAgentRun } from '../agents/run-state.js';
import { recordLedgerEntry } from '../db/models/execution-ledger.js';
import { requireOperatorRole, sendError } from './http.js';
import { getExternalAgentRunForExecution } from '../db/models/external-agent.js';
import { getExternalAgentRuntime } from '../agents/external-agent-runtime.js';
import { canAcceptAgentOutput, isQualityStep } from '@myrmecia/shared';

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
  const cursor = afterId === undefined ? undefined : Number(afterId);
  const pageSize = limit === undefined ? 200 : Number(limit);
  if ((cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    return res.status(400).json({ error: { message: 'Invalid message cursor or limit' } });
  }
  const messages = listExecutionMessages(req.params.id, {
    afterId: cursor,
    limit: pageSize,
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
router.post('/:id/cancel', async (req, res) => {
  const execution = getAccessibleExecution(req, req.params.id);
  if (!execution) return res.status(404).json({ error: { message: 'Execution not found' } });
  if (execution.status !== 'running') return res.status(400).json({ error: { message: 'Execution is not running' } });
  const external = getExternalAgentRunForExecution(execution.id, executionWorkspaceId(execution));
  if (external) {
    try {
      requireOperatorRole(req, 'external-agent.cancel', ['admin', 'operator']);
      const run = await getExternalAgentRuntime().cancel(external.id, executionWorkspaceId(execution));
      return res.json({ ok: true, remoteOutcomeUnknown: run.error?.includes('outcome is unknown') === true });
    } catch (error) {
      return res.status(501).json({ error: {
        message: error instanceof Error ? error.message : 'External cancellation is unsupported',
        code: 'CANCEL_UNSUPPORTED',
      } });
    }
  }

  agentRuntime.cancel(execution.taskId);
  updateAgentRun(execution.id, 'cancelled', { stopReason: 'cancelled' });
  updateExecution(execution.id, { status: 'cancelled', completedAt: new Date().toISOString() });
  const task = updateTask(execution.taskId, { status: 'cancelled', completedAt: new Date().toISOString() });
  addTaskLog(execution.taskId, 'warn', `Execution ${execution.id} cancelled by user`, 'system');
  eventBus.emit('task:cancelled', { taskId: execution.taskId, task, workspaceId: executionWorkspaceId(execution) });
  res.json({ ok: true });
});

// Acceptance is a human decision; never infer it from a successful model call.
router.post('/:id/acceptance', (req, res) => {
  let actor: ReturnType<typeof requireOperatorRole>;
  try { actor = requireOperatorRole(req, 'execution.acceptance', ['admin', 'operator']); }
  catch (error) { return sendError(res, error); }
  const execution = getAccessibleExecution(req, req.params.id);
  if (!execution) return res.status(404).json({ error: { message: 'Execution not found' } });
  const { decision, note } = req.body || {};
  if (!['accepted', 'rejected'].includes(decision)
    || (note !== undefined && (typeof note !== 'string' || note.length > 2000))) {
    return res.status(400).json({ error: { message: 'Invalid acceptance decision or note' } });
  }
  const state = execution.runState;
  if (!state || execution.status === 'running') {
    return res.status(409).json({ error: { message: 'This run has no completed acceptance contract' } });
  }
  const task = getTask(execution.taskId);
  // Resolve every ancestor; a done QA child must never hide a failed root.
  let session = task;
  const seen = new Set<string>();
  while (session?.parentTaskId && !seen.has(session.id)) {
    seen.add(session.id);
    const parent = getTask(session.parentTaskId);
    if (!parent || (parent.workspaceId || 'default') !== executionWorkspaceId(execution)) {
      session = undefined;
      break;
    }
    session = parent;
  }
  if (!task || !session || seen.has(session.id) || isQualityStep(task)
    || (decision === 'accepted' && !canAcceptAgentOutput(execution, task, session.status))) {
    return res.status(409).json({ error: { message: 'Task must be successfully completed before its output can be accepted; internal QA steps cannot be reviewed as user deliverables' } });
  }
  if (state.acceptance !== 'pending') {
    if (state.acceptance === decision) return res.json(execution);
    return res.status(409).json({ error: { message: 'This run was already reviewed; request a new revision instead' } });
  }
  const updated = updateExecution(execution.id, { runState: {
    ...state, acceptance: decision, acceptanceNote: note?.trim(),
    acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } });
  recordLedgerEntry({
    executionId: execution.id, taskId: execution.taskId, agentId: execution.agentDefId,
    workspaceId: executionWorkspaceId(execution), type: 'output.reviewed', decision,
    summary: `User ${decision} the run output`, metadata: { note: note?.trim(), actor },
  });
  eventBus.emit('execution:progress', {
    executionId: execution.id, taskId: execution.taskId, workspaceId: executionWorkspaceId(execution),
    progress: execution.progress, runState: updated?.runState,
  });
  res.json(updated);
});

// POST /api/executions/:id/message — send a message to a running execution (mailbox)
router.post('/:id/message', (req, res) => {
  const execution = getAccessibleExecution(req, req.params.id);
  if (!execution) return res.status(404).json({ error: { message: 'Execution not found' } });
  if (execution.status !== 'running') return res.status(409).json({ error: { message: 'Execution is no longer accepting follow-up instructions' } });
  if (execution.agentDefId.startsWith('external:')) {
    return res.status(501).json({ error: {
      code: 'FOLLOWUP_UNSUPPORTED',
      message: 'This external adapter does not support live follow-up. Wait for its result, then start a new invocation.',
    } });
  }

  const { content, messageType = 'text' } = req.body;
  const followUp = typeof content === 'string' ? content.trim() : '';
  if (!followUp) return res.status(400).json({ error: { message: 'content is required' } });

  const task = getTask(execution.taskId);
  const msg = messageBus.send(null, execution.id, messageType, followUp + (task ? sessionDocumentContext(task, followUp) : ''));
  const conversationMessage = addExecutionMessage({
    executionId: execution.id,
    type: 'user_follow_up',
    content: followUp,
  });
  eventBus.emit('execution:message', {
    executionId: execution.id,
    taskId: execution.taskId,
    workspaceId: executionWorkspaceId(execution),
    type: 'user_follow_up',
    content: followUp,
  });
  res.json({ ...msg, conversationMessage });
});

// GET /api/executions/:id/agent-messages — get inter-agent messages
router.get('/:id/agent-messages', (req, res) => {
  const execution = getAccessibleExecution(req, req.params.id);
  if (!execution) return res.status(404).json({ error: { message: 'Execution not found' } });
  const messages = messageBus.listForExecution(req.params.id);
  res.json(messages);
});

export default router;
