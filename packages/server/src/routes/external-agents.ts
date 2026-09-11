import { Router } from 'express';
import type { ExternalAgentConfig, ExternalAgentInvocationContext, ExternalAgentStatus } from '@myrmecia/shared';
import { workspaceIdFromRequest } from '../auth/tenant.js';
import {
  createExternalAgent,
  deleteExternalAgent,
  getExternalAgent,
  listExternalAgentRuns,
  listExternalAgents,
  updateExternalAgent,
} from '../db/models/external-agent.js';
import { getExternalAgentRuntime } from '../agents/external-agent-runtime.js';
import { HttpError, requireOperatorRole, sendError } from './http.js';

function workspace(req: any): string {
  return workspaceIdFromRequest(req) || 'default';
}

function invalidInput(message: string): never {
  throw new HttpError(400, 'INVALID_INPUT', message);
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    return invalidInput(`${name} must be an array of strings.`);
  }
  return value;
}

function externalConfig(value: unknown): ExternalAgentConfig {
  if (!value || typeof value !== 'object') return invalidInput('adapter is required.');
  const adapter = value as Record<string, unknown>;
  if (adapter.kind === 'local_cli' && typeof adapter.profile === 'string') {
    const allowedWorkspaceRoots = adapter.allowedWorkspaceRoots === undefined
      ? []
      : stringArray(adapter.allowedWorkspaceRoots, 'adapter.allowedWorkspaceRoots');
    if (!allowedWorkspaceRoots.length) return invalidInput('At least one allowed workspace root is required for a local CLI Agent.');
    return {
      kind: 'local_cli',
      profile: adapter.profile as Extract<ExternalAgentConfig, { kind: 'local_cli' }>['profile'],
      profileId: typeof adapter.profileId === 'string' ? adapter.profileId : undefined,
      allowedWorkspaceRoots,
    };
  }
  if (adapter.kind === 'http' && typeof adapter.endpoint === 'string') {
    const credentialRef = adapter.credentialRef;
    const allowedHosts = adapter.allowedHosts === undefined
      ? []
      : stringArray(adapter.allowedHosts, 'adapter.allowedHosts');
    return {
      kind: 'http',
      endpoint: adapter.endpoint,
      credentialRef: credentialRef && typeof credentialRef === 'object' && typeof (credentialRef as any).key === 'string'
        ? { provider: (credentialRef as any).provider || 'env', key: (credentialRef as any).key }
        : undefined,
      callbackUrl: typeof adapter.callbackUrl === 'string' ? adapter.callbackUrl : undefined,
      allowedHosts,
    };
  }
  return invalidInput('adapter must be a supported local_cli or http configuration.');
}

function invocation(value: unknown): ExternalAgentInvocationContext {
  if (!value || typeof value !== 'object' || typeof (value as any).objective !== 'string' || !(value as any).objective.trim()) {
    return invalidInput('invocation.objective is required.');
  }
  const input = value as Record<string, unknown>;
  return {
    taskId: typeof input.taskId === 'string' ? input.taskId : undefined,
    parentTaskId: typeof input.parentTaskId === 'string' ? input.parentTaskId : undefined,
    executionContextId: typeof input.executionContextId === 'string' ? input.executionContextId : undefined,
    workspaceId: typeof input.workspaceId === 'string' ? input.workspaceId : undefined,
    workdir: typeof input.workdir === 'string' ? input.workdir : undefined,
    objective: String(input.objective).trim(),
    constraints: input.constraints === undefined ? [] : stringArray(input.constraints, 'invocation.constraints'),
    provider: typeof input.provider === 'string' ? input.provider : undefined,
    modelId: typeof input.modelId === 'string' ? input.modelId : undefined,
    reasoningEffort: typeof input.reasoningEffort === 'string' ? input.reasoningEffort : undefined,
    contextLength: typeof input.contextLength === 'number' ? input.contextLength : undefined,
    artifactIds: Array.isArray(input.artifactIds) ? input.artifactIds.filter((item): item is string => typeof item === 'string') : [],
  };
}

async function validateAgentConfig(agent: Parameters<ReturnType<typeof getExternalAgentRuntime>['validate']>[0]): Promise<void> {
  try {
    await getExternalAgentRuntime().validate(agent);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    invalidInput(error instanceof Error ? error.message : 'Invalid external Agent configuration.');
  }
}

export function createExternalAgentRoutes(): Router {
  const router = Router();
  const runtime = getExternalAgentRuntime();

  router.get('/', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status as ExternalAgentStatus : undefined;
    res.json(listExternalAgents({ workspaceId: workspace(req), status }));
  });

  router.post('/', async (req, res) => {
    try {
      requireOperatorRole(req, 'external-agent.create', ['admin', 'operator']);
      const body = req.body || {};
      if (typeof body.name !== 'string' || !body.name.trim()) invalidInput('name is required.');
      const agent = createExternalAgent({
        workspaceId: workspace(req),
        name: body.name.trim(),
        description: typeof body.description === 'string' ? body.description : '',
        adapter: externalConfig(body.adapter),
        status: 'draft',
        capabilities: body.capabilities === undefined ? [] : stringArray(body.capabilities, 'capabilities'),
        allowedTools: body.allowedTools === undefined ? [] : stringArray(body.allowedTools, 'allowedTools'),
        defaultModelId: typeof body.defaultModelId === 'string' ? body.defaultModelId : undefined,
      });
      await validateAgentConfig(agent);
      const active = updateExternalAgent(agent.id, workspace(req), { status: 'active' }) || agent;
      return res.status(201).json(active);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:id', (req, res) => {
    const agent = getExternalAgent(req.params.id, workspace(req));
    if (!agent) return res.status(404).json({ error: { message: 'External Agent not found.' } });
    return res.json(agent);
  });

  router.patch('/:id', async (req, res) => {
    try {
      requireOperatorRole(req, 'external-agent.update', ['admin', 'operator']);
      const body = req.body || {};
      const current = getExternalAgent(req.params.id, workspace(req));
      if (!current) return res.status(404).json({ error: { message: 'External Agent not found.' } });
      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim()) invalidInput('name must be a non-empty string.');
        updates.name = body.name.trim();
      }
      if (body.description !== undefined) {
        if (typeof body.description !== 'string') invalidInput('description must be a string.');
        updates.description = body.description;
      }
      if (body.adapter !== undefined) updates.adapter = externalConfig(body.adapter);
      if (body.status !== undefined) {
        if (!['draft', 'active', 'degraded', 'disabled'].includes(body.status)) invalidInput('status must be draft, active, degraded, or disabled.');
        updates.status = body.status;
      }
      if (body.capabilities !== undefined) updates.capabilities = stringArray(body.capabilities, 'capabilities');
      if (body.allowedTools !== undefined) updates.allowedTools = stringArray(body.allowedTools, 'allowedTools');
      if (body.defaultModelId !== undefined) {
        if (typeof body.defaultModelId !== 'string') invalidInput('defaultModelId must be a string.');
        updates.defaultModelId = body.defaultModelId;
      }
      await validateAgentConfig({ ...current, ...updates } as typeof current);
      const agent = updateExternalAgent(req.params.id, workspace(req), updates);
      return res.json(agent);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      requireOperatorRole(req, 'external-agent.delete', ['admin', 'operator']);
      if (!deleteExternalAgent(req.params.id, workspace(req))) return res.status(404).json({ error: { message: 'External Agent not found.' } });
      return res.status(204).send();
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:id/health', async (req, res) => {
    try {
      requireOperatorRole(req, 'external-agent.health', ['admin', 'operator']);
      const agent = getExternalAgent(req.params.id, workspace(req));
      if (!agent) return res.status(404).json({ error: { message: 'External Agent not found.' } });
      return res.json(await runtime.healthCheck(agent));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:id/runs', (req, res) => {
    if (!getExternalAgent(req.params.id, workspace(req))) return res.status(404).json({ error: { message: 'External Agent not found.' } });
    return res.json(listExternalAgentRuns({ workspaceId: workspace(req), externalAgentId: req.params.id, limit: Number(req.query.limit) || 50 }));
  });

  router.post('/:id/runs', async (req, res) => {
    try {
      requireOperatorRole(req, 'external-agent.run', ['admin', 'operator']);
      const result = await runtime.run(req.params.id, workspace(req), invocation(req.body?.invocation), 'manual');
      return res.status(201).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
