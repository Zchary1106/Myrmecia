import { Router } from 'express';
import { z } from 'zod';
import { listAgents, getAgent, createAgent, updateAgent } from '../db/models/agent.js';
import { listExecutions, getActiveExecutionCount } from '../db/models/execution.js';
import { agentRuntime } from '../agents/agent-runtime.js';
import { forkExecutor } from '../agents/fork-executor.js';
import { createTask, getTask } from '../db/models/task.js';
import type { AgentDefinition } from '../types.js';
import type { TaskQueue } from '../queue/task-queue.js';
import { createOperatorAction } from '../db/models/operator-action.js';
import { eventBus } from '../events/event-bus.js';
import { logger } from '../lib/logger.js';
import { preflightAgent, setupEntity } from '../agents/agent-setup.js';
import { checkpointExecutionContext, persistExecutionContext } from '../agents/execution-context.js';
import { getSkillAssignmentForAgent } from '../db/models/skill.js';
import { getDb } from '../db/database.js';
import { HttpError, notFound, parseBody, requireOperatorRole, sendError } from './http.js';
import { workspaceIdFromRequest } from '../auth/tenant.js';
import { agentContractSchema } from '../contracts/team-composer-contracts.js';
import { saveDraftSchema } from '../agents/agent-setup-validation.js';
import { getSetupDraft, listSetupDrafts, saveSetupDraft, discardSetupDraft, validateDraftRequest } from '../db/models/agent-setup-draft.js';
import { randomUUID } from 'node:crypto';
import { scanForPII } from '../security/dlp.js';
import { agentConfigHistory, activateAgentVersion, getAgentConfigVersion, validateConfigReferences,
  versionAsAgent, agentForFutureDispatch } from '../db/models/agent-config-version.js';
import { listEvaluationSuites, saveEvaluationSuite, createEvaluationRun, listEvaluationRuns, evaluationRunSummary } from '../db/models/agent-evaluation.js';
import { evaluationSaveSchema, evaluationStartSchema, evaluationNextSchema } from '../agents/agent-evaluation-schema.js';
import { dispatchEvaluationCase, refreshEvaluationRun } from '../agents/agent-evaluation.js';
import { createAgentKnowledgeRoutes } from './agent-knowledge.js';
import { createAgentBudgetRoutes } from './agent-budget.js';
import { agentBudgetLimitsSchema } from '../agents/agent-budget.js';
import {
  isLegacyAgent,
  listLegacyAliases,
  loadLegacyAgentAliases,
  resolveLegacyAgentId,
} from '../agents/legacy-agent-alias-resolver.js';

const prioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
const stringListSchema = z.array(z.string().trim().min(1));
const agentConfigSchema = z.object({
  governanceBudget: agentBudgetLimitsSchema.optional(),
  systemInstructions: z.string().max(20_000).optional(),
  model: z.string().trim().min(1).optional(),
  maxConcurrent: z.number().int().min(1).optional(),
  timeout: z.number().int().min(1).optional(),
  workdir: z.string().trim().min(1).optional(),
  maxTurns: z.number().int().min(1).optional(),
  allowedTools: stringListSchema.optional(),
  contract: agentContractSchema.optional(),
}).passthrough().superRefine((config, ctx) => {
  if (config.systemInstructions === undefined) return; // Legacy configuration remains compatible.
  if (config.maxTurns !== undefined && config.maxTurns > 200
    || config.timeout !== undefined && (config.timeout < 10 || config.timeout > 3600)
    || config.maxConcurrent !== undefined && config.maxConcurrent > 8) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Setup limits exceed the supported bounds' });
  }
  if (scanForPII(JSON.stringify({ systemInstructions: config.systemInstructions, contract: config.contract }))
    .violations.some(violation => ['api_key', 'aws_key', 'private_key'].includes(violation.type))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Agent instructions cannot contain credentials' });
  }
});

const createAgentSchema = z.object({
  name: z.string().trim().min(1),
  role: z.string().trim().min(1),
  emoji: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  whenToUse: z.string().optional(),
  skillPath: z.string().optional(),
  config: agentConfigSchema.optional(),
  capabilities: stringListSchema.optional(),
  triggers: stringListSchema.optional(),
  allowedTools: stringListSchema.optional(),
  disallowedTools: stringListSchema.optional(),
  model: z.string().trim().min(1).optional(),
  maxTurns: z.number().int().min(1).optional(),
});

const updateAgentSchema = createAgentSchema.partial()
  .refine(data => Object.keys(data).length > 0, { message: 'At least one field must be provided' });

const executeAgentSchema = z.object({
  prompt: z.string().trim().min(1),
  workdir: z.string().trim().min(1).optional(),
  priority: prioritySchema.optional(),
  parentExecutionId: z.string().trim().min(1).optional(),
});

function agentAuditSnapshot(agent: AgentDefinition) {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    description: agent.description,
    whenToUse: agent.whenToUse,
    skillPath: agent.skillPath,
    capabilities: agent.capabilities,
    triggers: agent.triggers,
    allowedTools: agent.allowedTools || agent.config.allowedTools || [],
    disallowedTools: agent.disallowedTools || [],
    model: agent.model || agent.config.model,
    maxTurns: agent.maxTurns || agent.config.maxTurns,
    timeout: agent.config.timeout,
    contract: agent.config.contract,
  };
}

export function createAgentRoutes(taskQueue?: TaskQueue): Router {
  const router = Router();
  router.use('/:id/knowledge', createAgentKnowledgeRoutes());
  router.use('/:id/budget', createAgentBudgetRoutes());
  loadLegacyAgentAliases();
  const owner = (req: Parameters<typeof requireOperatorRole>[0]) => {
    const actor = requireOperatorRole(req, 'agent.setup-draft', ['admin', 'operator']);
    return { workspaceId: workspaceIdFromRequest(req) || 'default', actorId: actor.id || 'local' };
  };
  const accessibleAgent = (req: Parameters<typeof requireOperatorRole>[0]) => {
    requireOperatorRole(req, 'agent.config', ['admin', 'operator']);
    const workspaceId = workspaceIdFromRequest(req) || 'default';
    const agent = getAgent(String(req.params.id));
    if (!agent || !getDb().get('SELECT id FROM agents WHERE id = ? AND workspace_id = ?', agent.id, workspaceId)) notFound('AGENT_NOT_FOUND', 'Agent not found');
    return { agent, workspaceId };
  };
  const activationSchema = z.object({
    expectedCurrentVersionId: z.string().min(1).nullable(),
    expectedConfigHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict();
  const evaluationScope = (req: Parameters<typeof requireOperatorRole>[0]) => {
    const { agent, workspaceId } = accessibleAgent(req);
    return { agentId: agent.id, workspaceId, actorId: owner(req).actorId };
  };
  router.get('/:id/evaluation-suites', (req, res) => {
    try { res.setHeader('Cache-Control', 'no-store'); res.json(listEvaluationSuites(evaluationScope(req))); }
    catch (err) { sendError(res, err); }
  });
  router.put('/:id/evaluation-suites/:suiteId', (req, res) => {
    try {
      const scope = evaluationScope(req);
      if (!z.string().uuid().safeParse(req.params.suiteId).success) throw new HttpError(400, 'EVALUATION_SUITE_ID_INVALID', 'Invalid suite ID');
      const { expectedRevision, ...body } = parseBody(evaluationSaveSchema, req);
      const suite = saveEvaluationSuite(String(req.params.suiteId), scope, body, expectedRevision);
      res.json(suite);
    } catch (err) { sendError(res, err); }
  });
  router.get('/:id/evaluation-runs', (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const scope = evaluationScope(req), offset = Number(req.query.offset || 0);
      if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new HttpError(400, 'INVALID_INPUT', 'Invalid history offset');
      res.json(listEvaluationRuns(scope, offset).map(run => evaluationRunSummary(refreshEvaluationRun(run.id, scope))));
    } catch (err) { sendError(res, err); }
  });
  router.get('/:id/evaluation-runs/:runId', (req, res) => {
    try { res.setHeader('Cache-Control', 'no-store'); res.json(refreshEvaluationRun(String(req.params.runId), evaluationScope(req))); }
    catch (err) { sendError(res, err); }
  });
  router.post('/:id/evaluation-suites/:suiteId/runs', async (req, res) => {
    try {
      const scope = evaluationScope(req), body = parseBody(evaluationStartSchema, req);
      if (!taskQueue) throw new HttpError(503, 'TASK_QUEUE_UNAVAILABLE', 'Evaluation queue unavailable');
      const entity = createEvaluationRun(scope, String(req.params.suiteId), req.header('Idempotency-Key') || '', body);
      // Only the first selected case is submitted here. Replaying a response
      // cannot advance to a later case; advancing is a separate explicit action.
      const run = await dispatchEvaluationCase(entity.run.id, body.selectedCaseIds[0], scope, taskQueue);
      res.json({ ...run, replayed: entity.replayed });
    } catch (err) { sendError(res, err); }
  });
  router.post('/:id/evaluation-runs/:runId/next', async (req, res) => {
    try {
      const scope = evaluationScope(req), body = parseBody(evaluationNextSchema, req);
      if (!taskQueue) throw new HttpError(503, 'TASK_QUEUE_UNAVAILABLE', 'Evaluation queue unavailable');
      res.json(await dispatchEvaluationCase(String(req.params.runId), body.caseId, scope, taskQueue));
    } catch (err) { sendError(res, err); }
  });
  router.get('/:id/config-versions', (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const { agent, workspaceId } = accessibleAgent(req);
      res.json(agentConfigHistory(agent, workspaceId));
    } catch (err) { sendError(res, err); }
  });
  router.get('/:id/config-versions/:versionId', (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const { agent, workspaceId } = accessibleAgent(req);
      const version = getAgentConfigVersion(req.params.versionId, agent.id, workspaceId);
      if (!version) notFound('CONFIG_VERSION_NOT_FOUND', 'Revision not found');
      res.json(version);
    } catch (err) { sendError(res, err); }
  });
  router.post('/:id/config-versions/:versionId/preflight', (req, res) => {
    try {
      const { agent, workspaceId } = accessibleAgent(req);
      if (req.params.versionId === 'working') {
        res.json(preflightAgent(agent, getSkillAssignmentForAgent(agent.id)?.skillVersionId));
        return;
      }
      const version = getAgentConfigVersion(req.params.versionId, agent.id, workspaceId);
      if (!version) notFound('CONFIG_VERSION_NOT_FOUND', 'Revision not found');
      validateConfigReferences(version.snapshot, workspaceId);
      res.json(preflightAgent(versionAsAgent(version, agent), version.snapshot.skill?.versionId));
    } catch (err) { sendError(res, err); }
  });
  router.post('/:id/config-versions/publish', (req, res) => {
    try {
      const { agent, workspaceId } = accessibleAgent(req);
      const actor = requireOperatorRole(req, 'agent.config.publish', ['admin', 'operator']);
      res.json(activateAgentVersion({ ...parseBody(activationSchema, req), agentId: agent.id, workspaceId, actor }));
    } catch (err) { sendError(res, err); }
  });
  router.post('/:id/config-versions/:versionId/rollback', (req, res) => {
    try {
      const { agent, workspaceId } = accessibleAgent(req);
      const actor = requireOperatorRole(req, 'agent.config.rollback', ['admin', 'operator']);
      res.json(activateAgentVersion({ ...parseBody(activationSchema, req), agentId: agent.id, workspaceId, actor, targetVersionId: req.params.versionId }));
    } catch (err) { sendError(res, err); }
  });
  router.get('/setup-drafts', (req, res) => {
    try { res.setHeader('Cache-Control', 'no-store'); res.json(listSetupDrafts(owner(req))); }
    catch (err) { sendError(res, err); }
  });
  router.get('/setup-drafts/:draftId', (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const draft = getSetupDraft(req.params.draftId, owner(req));
      if (!draft) notFound('DRAFT_NOT_FOUND', '草稿不存在或无权访问');
      res.json(draft);
    } catch (err) { sendError(res, err); }
  });
  router.put('/setup-drafts/:draftId', (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const scope = owner(req);
      if (!z.string().uuid().safeParse(req.params.draftId).success) throw new HttpError(400, 'DRAFT_ID_INVALID', 'Invalid draft ID');
      res.json(saveSetupDraft(req.params.draftId, scope, parseBody(saveDraftSchema, req)));
    } catch (err) { sendError(res, err); }
  });
  router.delete('/setup-drafts/:draftId', (req, res) => {
    try {
      if (!discardSetupDraft(req.params.draftId, owner(req))) notFound('DRAFT_NOT_FOUND', '草稿不存在或无权访问');
      res.status(204).end();
    } catch (err) { sendError(res, err); }
  });
  router.post('/preflight', (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      requireOperatorRole(req, 'agent.preflight', ['admin', 'operator']);
      const body = parseBody(createAgentSchema.extend({ skillVersionId: z.string().optional() }), req);
      const agent: AgentDefinition = {
        ...body, id: '__new_agent__', emoji: body.emoji || '🤖', whenToUse: body.whenToUse || '',
        config: body.config || {}, capabilities: body.capabilities || [], triggers: body.triggers || [],
        stats: { tasksCompleted: 0, tasksFailed: 0, avgDurationMs: 0 }, createdAt: '', updatedAt: '',
      };
      res.json(preflightAgent(agent, body.skillVersionId));
    } catch (err) { sendError(res, err); }
  });
  router.post('/:id/preflight', (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      requireOperatorRole(req, 'agent.preflight', ['admin', 'operator']);
      const agent = getAgent(req.params.id);
      if (!agent || !listAgents({ workspaceId: workspaceIdFromRequest(req) || 'default' }).some(item => item.id === agent.id)) {
        notFound('AGENT_NOT_FOUND', 'Agent not found');
      }
      const effective = agentForFutureDispatch(agent, workspaceIdFromRequest(req) || 'default');
      res.json(preflightAgent(effective.agent, effective.skillVersionId));
    } catch (err) { sendError(res, err); }
  });
  router.post('/:id/test', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'agent.test', ['admin', 'operator']);
      const agent = getAgent(req.params.id);
      const workspaceId = workspaceIdFromRequest(req) || 'default';
      if (!agent || !listAgents({ workspaceId }).some(item => item.id === agent.id)) notFound('AGENT_NOT_FOUND', 'Agent not found');
      const body = parseBody(z.object({ prompt: z.string().trim().min(1).max(20000) }), req);
      const key = req.header('Idempotency-Key');
      if (!key) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Test runs require an idempotency key');
      validateDraftRequest({ workspaceId, actorId: actor.id || 'local' }, key, 'test', body);
      if (!taskQueue) throw new HttpError(503, 'TASK_QUEUE_UNAVAILABLE', 'Test queue unavailable; no untracked execution was launched');
      // Idempotent replay inspects the already-created task even if readiness changed.
      const entity = setupEntity({ actorId: actor.id || 'local', workspaceId, operation: `test:${agent.id}`, key, payload: body }, () => {
        const effective = agentForFutureDispatch(agent, workspaceId);
        const preflight = preflightAgent(effective.agent, effective.skillVersionId);
        if (!preflight.canTest) throw new HttpError(409, 'AGENT_NOT_READY', 'Resolve blocking checks before testing', preflight);
        const task = createTask({
          title: `Test run: ${body.prompt.slice(0, 70)}`, description: body.prompt, input: body.prompt,
          mode: 'direct', assigneeId: agent.id, createdBy: 'user', workspaceId,
          modelId: effective.agent.model || effective.agent.config.model, maxRetries: 0,
        });
        checkpointExecutionContext(persistExecutionContext(task), { phase: 'queued', completed: [],
          pending: ['agent test execution'], blocked: [], resumeHint: 'Dispatch the persisted test task without replacing its identity.' });
        createOperatorAction({ action: 'agent.test', actor, targetType: 'agent', targetId: agent.id, taskId: task.id,
          metadata: { promptChars: body.prompt.length } });
        return task.id;
      });
      const task = getTask(entity.id);
      if (!task || task.workspaceId !== workspaceId) throw new HttpError(410, 'SETUP_ENTITY_MISSING', 'The prior test task is no longer available');
      if (!entity.replayed) eventBus.emit('task:created', { taskId: task.id, task, workspaceId });
      await taskQueue.dispatchExisting(task.id);
      res.json({ taskId: task.id, status: getTask(task.id)!.status, replayed: entity.replayed });
    } catch (err) { sendError(res, err); }
  });
  // Legacy task agents are hidden from the directory by default. Operators can
  // opt back in with MYRMECIA_SHOW_LEGACY_AGENTS=true (or the legacy
  // MYRMECIA_HIDE_LEGACY_AGENTS=false), and ?includeLegacy=true overrides per-request.
  const showLegacyByDefault =
    process.env.MYRMECIA_SHOW_LEGACY_AGENTS === 'true' ||
    process.env.MYRMECIA_HIDE_LEGACY_AGENTS === 'false';

  function legacyAnnotation(agentId: string) {
    const alias = resolveLegacyAgentId(agentId);
    if (!alias) return undefined;
    return {
      deprecated: true,
      replacement: {
        agentId: alias.agentId,
        skills: alias.skills,
        tools: alias.tools,
      },
    };
  }

  // GET /api/agents — list agent definitions (capability templates)
  router.get('/', (req, res) => {
    const { role } = req.query;
    const includeLegacy = req.query.includeLegacy === 'true';
    let agents = listAgents({ role: role as string });
    if (!showLegacyByDefault && !includeLegacy) {
      agents = agents.filter(agent => !isLegacyAgent(agent.id));
    }

    // Enrich with runtime info (active execution count)
    const enriched = agents.map(agent => ({
      ...agent,
      activeExecutions: getActiveExecutionCount(agent.id),
      legacy: legacyAnnotation(agent.id),
    }));

    res.json(enriched);
  });

  // GET /api/agents/legacy — list all legacy aliases and their replacements
  router.get('/legacy', (_req, res) => {
    res.json({ aliases: listLegacyAliases() });
  });

  // GET /api/agents/:id — single agent definition
  router.get('/:id', (req, res) => {
    const agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: { message: 'Agent not found' } });
    res.json({
      ...agent,
      activeExecutions: getActiveExecutionCount(agent.id),
      legacy: legacyAnnotation(agent.id),
    });
  });

  // GET /api/agents/:id/deprecation — deprecation status for a single id
  router.get('/:id/deprecation', (req, res) => {
    if (!isLegacyAgent(req.params.id)) {
      return res.json({ deprecated: false });
    }
    res.json({ deprecated: true, legacy: legacyAnnotation(req.params.id) });
  });

  // POST /api/agents — register a new agent definition
  router.post('/', (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'agent.create', ['admin', 'operator']);
      const body = parseBody(createAgentSchema, req);
      const contract = body.config?.contract;
      if (contract && contract.role !== body.role) {
        throw new HttpError(400, 'AGENT_CONTRACT_ROLE_MISMATCH', 'Agent Contract role must match the Agent role');
      }
      const workspaceId = workspaceIdFromRequest(req) || 'default';
      validateDraftRequest({ workspaceId, actorId: actor.id || 'local' }, req.header('Idempotency-Key'), 'create', body);
      const entity = setupEntity({ workspaceId, actorId: actor.id || 'local', operation: 'create', key: req.header('Idempotency-Key'), payload: body }, () => {
        // __new_agent__ is the editor placeholder, never an actual reusable ID.
        const id = !contract || contract.agentId === '__new_agent__' ? randomUUID() : contract.agentId;
        if (getAgent(id)) throw new HttpError(409, 'AGENT_ID_EXISTS', 'Agent ID already exists');
        const agent = createAgent({ ...body, id, workspaceId,
          config: { ...body.config, ...(contract ? { contract: { ...contract, agentId: id } } : {}) } });
        createOperatorAction({ action: 'agent.create', actor, targetType: 'agent', targetId: agent.id,
          metadata: { next: agentAuditSnapshot(agent) } });
        return agent.id;
      });
      const agent = getAgent(entity.id);
      if (!agent || !getDb().get('SELECT id FROM agents WHERE id = ? AND workspace_id = ?', entity.id, workspaceId)) {
        throw new HttpError(410, 'SETUP_ENTITY_MISSING', 'The prior Agent no longer exists; start a new setup');
      }
      if (!entity.replayed) eventBus.emit('agent:status', { agentId: agent.id, agent });
      res.status(entity.replayed ? 200 : 201).json(agent);
    } catch (err) {
      sendError(res, err);
    }
  });

  // PATCH /api/agents/:id — update agent definition
  router.patch('/:id', (req, res) => {
    try {
      const agent = getAgent(req.params.id);
      if (!agent) notFound('AGENT_NOT_FOUND', 'Agent not found');
      const actor = requireOperatorRole(req, 'agent.update', ['admin', 'operator']);
      if (!listAgents({ workspaceId: workspaceIdFromRequest(req) || 'default' }).some(item => item.id === agent.id)) notFound('AGENT_NOT_FOUND', 'Agent not found');
      const patch = parseBody(updateAgentSchema, req);
      const contract = patch.config?.contract;
      if (!contract && agent.config.contract && patch.role && patch.role !== agent.config.contract.role) {
        throw new HttpError(400, 'AGENT_CONTRACT_ROLE_MISMATCH', 'Update the responsibility contract together with the role');
      }
      if (contract && contract.agentId !== agent.id) {
        throw new HttpError(400, 'AGENT_CONTRACT_ID_MISMATCH', 'Agent Contract agentId must match the Agent being updated');
      }
      if (contract && contract.role !== (patch.role || agent.role)) {
        throw new HttpError(400, 'AGENT_CONTRACT_ROLE_MISMATCH', 'Agent Contract role must match the Agent role');
      }
      if (patch.config && (Object.hasOwn(patch.config, 'governanceBudget') || agent.config.governanceBudget
        && ['maxTurns', 'timeout', 'maxConcurrent'].some(key => Object.hasOwn(patch.config!, key)))
        || agent.config.governanceBudget && patch.maxTurns !== undefined) {
        throw new HttpError(400, 'BUDGET_REVISION_REQUIRED', 'Use the budget editor with an expected policy revision');
      }
      const updated = updateAgent(req.params.id, {
        ...patch,
        ...(patch.config ? { config: { ...agent.config, ...patch.config } } : {}),
      });
      if (!updated) throw new HttpError(404, 'AGENT_NOT_FOUND', 'Agent not found');
      createOperatorAction({
        action: 'agent.update',
        actor,
        targetType: 'agent',
        targetId: req.params.id,
        metadata: {
          previous: agentAuditSnapshot(agent),
          next: agentAuditSnapshot(updated),
        },
      });
      eventBus.emit('agent:status', { agentId: updated.id, agent: updated });
      res.json(updated);
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/agents/:id/execute — create a new execution (async, returns immediately)
  router.post('/:id/execute', async (req, res) => {
    try {
      const agent = getAgent(req.params.id);
      if (!agent) notFound('AGENT_NOT_FOUND', 'Agent not found');
      const actor = requireOperatorRole(req, 'agent.execute', ['admin', 'operator']);

      const { prompt, workdir, priority, parentExecutionId } = parseBody(executeAgentSchema, req);
      const workspaceId = workspaceIdFromRequest(req);

      let taskId: string;
      if (parentExecutionId) {
        // Fork mode: still async but we fire-and-forget
        const task = await (taskQueue
          ? taskQueue.enqueue({
              title: prompt.slice(0, 80),
              description: prompt,
              mode: 'direct',
              priority: priority || 'normal',
              assigneeId: agent.id,
              input: prompt,
              parentTaskId: parentExecutionId,
              workspaceActorId: actor.id,
              workdir,
              workspaceId,
            })
          : Promise.resolve(createTask({
              title: prompt.slice(0, 80),
              description: prompt,
              mode: 'direct' as any,
              priority: priority || 'normal',
              assigneeId: agent.id,
              input: prompt,
              workdir,
              workspaceId,
              createdBy: 'user',
            }))
        );

        // Fire-and-forget if no queue (queue handles execution internally)
        if (!taskQueue) {
          forkExecutor.fork(parentExecutionId, prompt, agent.id).catch(err => {
            logger.error({ agentId: agent.id, err: err.message }, 'Fork execution failed');
          });
        }

        taskId = task.id;
      } else {
        // Spawn mode: enqueue to task queue (returns immediately)
        if (taskQueue) {
          const task = await taskQueue.enqueue({
            title: prompt.slice(0, 80),
            description: prompt,
            mode: 'direct',
            priority: priority || 'normal',
            assigneeId: agent.id,
            input: prompt,
            workdir,
            workspaceId,
            workspaceActorId: actor.id,
          });
          taskId = task.id;
        } else {
          // No queue: create task and fire-and-forget
          const task = createTask({
            title: prompt.slice(0, 80),
            description: prompt,
            mode: 'direct' as any,
            priority: priority || 'normal',
            assigneeId: agent.id,
            input: prompt,
            workdir,
            workspaceId,
            createdBy: 'user',
          });
          forkExecutor.spawn(agent.id, prompt, { workdir, priority, workspaceId }).catch(err => {
            logger.error({ agentId: agent.id, err: err.message }, 'Spawn execution failed');
          });
          taskId = task.id;
        }
      }
      createOperatorAction({
        action: 'agent.execute',
        actor,
        targetType: 'agent',
        targetId: agent.id,
        taskId,
        metadata: { priority: priority || 'normal', parentExecutionId, promptChars: prompt.length },
      });
      // Queueing preserves the Agent's single-workspace safety boundary. The
      // worker starts it once capacity is free instead of rejecting the request.
      res.json({ taskId, status: taskQueue ? 'queued' : 'started' });
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/agents/:id/executions — execution history for this agent
  router.get('/:id/executions', (req, res) => {
    const { status, limit } = req.query;
    const executions = listExecutions({
      agentDefId: req.params.id,
      status: status as any,
      workspaceId: workspaceIdFromRequest(req),
      limit: limit ? Number(limit) : 20,
    });
    res.json(executions);
  });

  // Legacy compatibility endpoints (no-op, agents are always "on")
  router.post('/:id/start', (_req, res) => res.json({ success: true, message: 'Agents are always available as capability templates' }));
  router.post('/:id/stop', (_req, res) => res.json({ success: true, message: 'Use execution cancel instead' }));

  return router;
}
