import { Router } from 'express';
import { z } from 'zod';
import { execFile, spawnSync } from 'node:child_process';
import { createOperatorAction } from '../db/models/operator-action.js';
import { actorFromRequest, HttpError, notFound, parseBody, parseQuery, requireOperatorRole, sendError } from './http.js';
import {
  getModel,
  getModelRoute,
  COPILOT_COMPATIBILITY_MODEL_IDS,
  createCustomModel,
  deleteCustomModel,
  listModelRoutes,
  listModels,
  recordModelHealth,
  syncProviderModels,
  updateModel,
  upsertModelRoute,
} from '../models/model-registry.js';
import { getModelGateway, readProviders, resetModelGateway, shutdownModelGateway } from '../models/gateway.js';
import type { ModelProviderSettings, ProviderAccount, ProviderModelOption } from '../types.js';

const COPILOT_COMPATIBILITY_MODEL_ID_SET = new Set<string>(COPILOT_COMPATIBILITY_MODEL_IDS);

const listModelsQuerySchema = z.object({
  enabled: z.enum(['true', 'false']).optional(),
});

const updateModelSchema = z.object({
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  fallbackGroup: z.string().trim().min(1).optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'At least one field must be provided' });

const updateRouteSchema = z.object({
  routeKey: z.string().trim().min(1),
  defaultModelId: z.string().trim().min(1).optional(),
  fallbackGroup: z.string().trim().min(1).default('balanced'),
});

const createModelSchema = z.object({
  id: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9._:/-]+$/, 'Model ID contains unsupported characters'),
  provider: z.string().trim().min(1).max(80),
  displayName: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).optional(),
  capabilityTags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  fallbackGroup: z.string().trim().min(1).max(80).optional(),
  tier: z.enum(['strong', 'balanced', 'cheap', 'fallback']).optional(),
  maxTokens: z.number().int().positive().max(10_000_000).optional(),
});

const providerModelSchema = z.object({
  modelId: z.string().trim().min(1).max(200),
});

const copilotAccountSchema = z.object({
  login: z.string().trim().min(1).max(39).regex(/^[A-Za-z0-9-]+$/, 'GitHub login contains unsupported characters'),
});

function configuredProvider(): string {
  return process.env.MYRMECIA_MODEL_PROVIDER?.trim().toLowerCase() || 'openai-compatible';
}

function discoveryProviderName(): string {
  const configured = configuredProvider();
  if (configured === 'copilot') return 'copilot';
  return readProviders()[configured] ? configured : 'default';
}

function registryFallbackModels(provider: string): ProviderModelOption[] {
  return listModels({ enabled: true })
    .filter(model => provider === 'deepseek'
      ? model.provider === 'deepseek'
      : provider === 'copilot'
      ? model.provider === 'copilot' || COPILOT_COMPATIBILITY_MODEL_ID_SET.has(model.id)
      : model.provider !== 'deepseek' && model.provider !== 'copilot')
    .map(model => ({
      id: model.id,
      name: model.displayName,
      supportsReasoningEffort: model.capabilityTags.includes('reasoning') || model.capabilityTags.includes('reasoning-effort'),
      supportedReasoningEfforts: [],
      maxTokens: model.maxTokens,
      source: 'registry' as const,
      selectable: true,
    }));
}

function isChatModel(modelId: string): boolean {
  return !/(embedding|embed|moderation|whisper|tts|dall[-.]e|rerank|speech|audio)/i.test(modelId);
}

async function discoverCopilotModels(): Promise<ProviderModelOption[]> {
  const discovered = await getModelGateway().listProviderModels('copilot');
  const models = discovered.map(model => ({
    id: model.id,
    name: model.name,
    supportsReasoningEffort: Boolean(model.supportedReasoningEfforts?.length),
    supportedReasoningEfforts: model.supportedReasoningEfforts as ProviderModelOption['supportedReasoningEfforts'],
    maxTokens: model.maxTokens,
    source: 'provider' as const,
    policyState: model.policy?.state,
    policyTerms: model.policy?.terms,
    billingMultiplier: model.billing?.multiplier,
    selectable: model.policy?.state !== 'disabled',
  }));
  syncProviderModels('copilot', discovered.map(model => ({
    ...model,
    supportsReasoningEffort: Boolean(model.supportedReasoningEfforts?.length),
  })));
  return models;
}

function cachedCopilotModels(): ProviderModelOption[] {
  return listModels({ enabled: true })
    .filter(model => model.provider === 'copilot')
    .map(model => ({
      id: model.id,
      name: model.displayName,
      supportsReasoningEffort: model.capabilityTags.includes('reasoning-effort'),
      supportedReasoningEfforts: [],
      maxTokens: model.maxTokens,
      source: 'registry' as const,
      policyState: (model.costProfile.policy as { state?: ProviderModelOption['policyState'] } | undefined)?.state,
      policyTerms: (model.costProfile.policy as { terms?: string } | undefined)?.terms,
      billingMultiplier: (model.costProfile.billing as { multiplier?: number } | undefined)?.multiplier,
      selectable: (model.costProfile.policy as { state?: string } | undefined)?.state !== 'disabled',
    }));
}

function compatibilityCopilotModels(): ProviderModelOption[] {
  const ids = new Set<string>(COPILOT_COMPATIBILITY_MODEL_IDS);
  return listModels({ enabled: true })
    .filter(model => ids.has(model.id))
    .map(model => ({
      id: model.id,
      name: model.displayName,
      supportsReasoningEffort: model.capabilityTags.includes('reasoning') || model.capabilityTags.includes('reasoning-effort'),
      supportedReasoningEfforts: [],
      maxTokens: model.maxTokens,
      source: 'registry' as const,
      policyState: 'unconfigured' as const,
      policyTerms: 'Compatibility model. GitHub Copilot may remap the request when the account model catalog is temporarily unavailable.',
      selectable: true,
    }));
}

function mergeProviderModels(primary: ProviderModelOption[], fallback: ProviderModelOption[]): ProviderModelOption[] {
  const merged = new Map(fallback.map(model => [model.id, model]));
  for (const model of primary) merged.set(model.id, model);
  return [...merged.values()].sort((left, right) => {
    if (left.id === 'auto') return -1;
    if (right.id === 'auto') return 1;
    return left.name.localeCompare(right.name);
  });
}

async function availableCopilotModels(): Promise<{ models: ProviderModelOption[]; warning?: string }> {
  const liveModels = await discoverCopilotModels();
  const onlyAuto = liveModels.length === 1 && liveModels[0]?.id === 'auto';
  if (!onlyAuto) return { models: liveModels };

  const models = mergeProviderModels(
    liveModels,
    mergeProviderModels(cachedCopilotModels(), compatibilityCopilotModels()),
  );
  return {
    models,
    ...(models.length > liveModels.length
      ? { warning: 'Copilot model discovery temporarily returned only Auto; showing the last discovered account models.' }
      : {}),
  };
}

async function providerSettings(): Promise<ModelProviderSettings> {
  const provider = configuredProvider();
  const selectedModelId = provider === 'copilot'
    ? getModelRoute('provider:copilot')?.defaultModelId || process.env.MYRMECIA_MODEL || process.env.AGENT_FACTORY_MODEL || 'auto'
    : process.env.MYRMECIA_MODEL || process.env.AGENT_FACTORY_MODEL;

  if (provider === 'copilot') {
    try {
      const { models, warning } = await availableCopilotModels();
      const account = await getModelGateway().copilotAuthStatus();
      const accounts = await listGithubAccounts();
      return {
        provider,
        selectedModelId: models.some(model => model.id === selectedModelId && model.selectable)
          ? selectedModelId
          : models.find(model => model.selectable)?.id || selectedModelId,
        models,
        account,
        accounts,
        source: warning ? 'registry' : 'provider',
        ...(warning ? { error: warning } : {}),
      };
    } catch (err) {
      const fallbackModels = cachedCopilotModels();
      let accounts: ProviderAccount[] = [];
      try { accounts = await listGithubAccounts(); } catch { /* preserve the model discovery error */ }
      return { provider, selectedModelId, models: fallbackModels, accounts, account: { authenticated: false }, source: 'registry', error: err instanceof Error ? err.message : 'Unable to discover Copilot models.' };
    }
  }

  try {
    const providerConfig = readProviders()[discoveryProviderName()];
    if (!providerConfig || providerConfig.type !== 'openai' || !providerConfig.apiKey || providerConfig.baseURL.includes('your-model-endpoint.example.com')) {
      throw new Error('Provider API credentials are not configured for live model discovery.');
    }
    const discovered = (await getModelGateway().listProviderModels(discoveryProviderName())).filter(model => isChatModel(model.id));
    if (discovered.length === 0) throw new Error('The provider returned no available models.');
    const models = discovered.map(model => ({
      id: model.id,
      name: model.name || model.id,
      supportsReasoningEffort: Boolean(model.supportedReasoningEfforts?.length),
      supportedReasoningEfforts: model.supportedReasoningEfforts as ProviderModelOption['supportedReasoningEfforts'],
      maxTokens: model.maxTokens,
      source: 'provider' as const,
      selectable: true,
    }));
    syncProviderModels(provider, discovered.map(model => ({
      id: model.id,
      name: model.name || model.id,
      capabilities: model.capabilities,
      supportsReasoningEffort: Boolean(model.supportedReasoningEfforts?.length),
      policy: model.policy,
      billing: model.billing,
      maxTokens: model.maxTokens,
    })));
    return {
      provider,
      selectedModelId: models.some(model => model.id === selectedModelId) ? selectedModelId : models[0]?.id,
      models,
      source: 'provider',
    };
  } catch (err) {
    const fallbackModels = registryFallbackModels(provider);
    return {
      provider,
      selectedModelId: fallbackModels.some(model => model.id === selectedModelId) ? selectedModelId : fallbackModels[0]?.id,
      models: fallbackModels,
      source: 'registry',
      error: err instanceof Error ? err.message : 'Unable to discover provider models.',
    };
  }
}

function copilotCliPath(): string {
  const configured = process.env.COPILOT_CLI_PATH?.trim();
  if (configured) return configured;
  const discovered = spawnSync('which', ['copilot'], { encoding: 'utf8' }).stdout.trim();
  return discovered || 'copilot';
}

function githubCliPath(): string {
  const configured = process.env.GH_CLI_PATH?.trim();
  if (configured) return configured;
  const discovered = spawnSync('which', ['gh'], { encoding: 'utf8' }).stdout.trim();
  return discovered || 'gh';
}

function runGithubCli(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(githubCliPath(), args, {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function listGithubAccounts(): Promise<ProviderAccount[]> {
  const result = await runGithubCli(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']);
  try {
    const parsed = JSON.parse(result.stdout) as { hosts?: Record<string, Array<{ login?: string; active?: boolean; host?: string }>> };
    return (parsed.hosts?.['github.com'] || [])
      .filter(account => typeof account.login === 'string' && account.login.length > 0)
      .map(account => ({
        login: account.login!,
        host: account.host || 'github.com',
        active: account.active === true,
      }));
  } catch {
    if (!result.ok) return [];
    throw new Error('无法读取 GitHub CLI 账号列表。');
  }
}

async function loginCopilot(): Promise<{ ok: boolean; message: string }> {
  // The Copilot SDK reports the signed-in `gh` identity (`authType: gh-cli`),
  // so use the GitHub CLI flow here as well. This makes a newly authorized
  // account discoverable by `gh auth status` and switchable from the UI.
  const result = await runGithubCli(['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https']);
  return result.ok
    ? { ok: true, message: 'GitHub 账号登录完成。' }
    : { ok: false, message: 'GitHub 账号登录未完成，请重新发起登录。' };
}

export function createModelRoutes(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    try {
      const query = parseQuery(listModelsQuerySchema, req);
      res.json(listModels({ enabled: query.enabled === undefined ? undefined : query.enabled === 'true' }));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/routes', (_req, res) => {
    res.json(listModelRoutes());
  });

  router.get('/provider-settings', async (_req, res) => {
    res.json(await providerSettings());
  });

  router.post('/copilot/login', async (req, res) => {
    try {
      requireOperatorRole(req, 'model.provider.login', ['admin', 'operator']);
      if (configuredProvider() !== 'copilot') {
        throw new HttpError(409, 'PROVIDER_NOT_ACTIVE', 'GitHub Copilot is not the active model provider');
      }
      const result = await loginCopilot();
      if (result.ok) {
        await shutdownModelGateway();
        resetModelGateway();
      }
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/copilot/account', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'model.provider.account.switch', ['admin', 'operator']);
      if (configuredProvider() !== 'copilot') {
        throw new HttpError(409, 'PROVIDER_NOT_ACTIVE', 'GitHub Copilot is not the active model provider');
      }
      const { login } = parseBody(copilotAccountSchema, req);
      const accounts = await listGithubAccounts();
      if (!accounts.some(account => account.login === login)) {
        throw new HttpError(404, 'GITHUB_ACCOUNT_NOT_FOUND', 'The GitHub account is not logged in on this device');
      }
      const result = await runGithubCli(['auth', 'switch', '--hostname', 'github.com', '--user', login]);
      if (!result.ok) {
        throw new HttpError(502, 'GITHUB_ACCOUNT_SWITCH_FAILED', result.stderr.trim() || '无法切换 GitHub 账号');
      }
      await shutdownModelGateway();
      resetModelGateway();
      createOperatorAction({
        action: 'model.provider.account.switch',
        actor,
        targetType: 'model',
        targetId: `github.com:${login}`,
        metadata: { provider: 'copilot', host: 'github.com', login },
      });
      res.json(await providerSettings());
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/', (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'model.create', ['admin', 'operator']);
      const body = parseBody(createModelSchema, req);
      if (getModel(body.id)) {
        throw new HttpError(409, 'MODEL_EXISTS', 'A model with this ID already exists');
      }
      const model = createCustomModel(body);
      createOperatorAction({
        action: 'model.create',
        actor,
        targetType: 'model',
        targetId: model.id,
        metadata: { provider: model.provider, source: 'custom' },
      });
      res.status(201).json(model);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put('/provider-settings', async (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'model.provider.update', ['admin', 'operator']);
      if (configuredProvider() !== 'copilot') {
        throw new HttpError(409, 'PROVIDER_NOT_ACTIVE', 'GitHub Copilot is not the active model provider');
      }
      const { modelId } = parseBody(providerModelSchema, req);
      const { models, warning } = await availableCopilotModels();
      const selected = models.find(model => model.id === modelId);
      if (!selected) notFound('MODEL_NOT_FOUND', 'Model is not available for the signed-in Copilot account');
      if (!selected.selectable) {
        throw new HttpError(409, 'MODEL_DISABLED', 'Model is disabled by the current Copilot account or organization policy');
      }

      upsertModelRoute({
        routeKey: 'provider:copilot',
        defaultModelId: selected.id,
        fallbackGroup: 'copilot',
        modelTier: 'balanced',
      });
      createOperatorAction({
        action: 'model.provider.update',
        actor,
        targetType: 'model',
        targetId: selected.id,
        metadata: { provider: 'copilot', modelId: selected.id },
      });
      const account = await getModelGateway().copilotAuthStatus();
      const accounts = await listGithubAccounts();
      res.json({
        provider: 'copilot',
        selectedModelId: selected.id,
        models,
        account,
        accounts,
        ...(warning ? { error: warning } : {}),
      } satisfies ModelProviderSettings);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.patch('/routes', (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'model.route.update', ['admin', 'operator']);
      const body = parseBody(updateRouteSchema, req);
      if (body.defaultModelId && !getModel(body.defaultModelId)) {
        notFound('MODEL_NOT_FOUND', 'Default model not found');
      }
      const route = upsertModelRoute({ ...body, fallbackGroup: body.fallbackGroup || 'balanced' });
      createOperatorAction({
        action: 'model.route.update',
        actor,
        targetType: 'model',
        targetId: route.routeKey,
        metadata: route as unknown as Record<string, unknown>,
      });
      res.json(route);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/:id', (req, res) => {
    const model = getModel(req.params.id);
    if (!model) return res.status(404).json({ error: { message: 'Model not found' } });
    res.json(model);
  });

  router.patch('/:id', (req, res) => {
    try {
      const existing = getModel(req.params.id);
      if (!existing) notFound('MODEL_NOT_FOUND', 'Model not found');
      const actor = requireOperatorRole(req, 'model.update', ['admin', 'operator']);
      const updates = parseBody(updateModelSchema, req);
      const model = updateModel(req.params.id, updates);
      if (!model) throw new HttpError(404, 'MODEL_NOT_FOUND', 'Model not found');
      createOperatorAction({
        action: 'model.update',
        actor,
        targetType: 'model',
        targetId: req.params.id,
        metadata: {
          previous: {
            enabled: existing.enabled,
            priority: existing.priority,
            fallbackGroup: existing.fallbackGroup,
          },
          next: {
            enabled: model.enabled,
            priority: model.priority,
            fallbackGroup: model.fallbackGroup,
          },
        },
      });
      res.json(model);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      const existing = getModel(req.params.id);
      if (!existing) notFound('MODEL_NOT_FOUND', 'Model not found');
      if (existing.costProfile.source !== 'custom') {
        throw new HttpError(409, 'BUILTIN_MODEL', 'Built-in models cannot be deleted');
      }
      const actor = requireOperatorRole(req, 'model.delete', ['admin', 'operator']);
      if (!deleteCustomModel(req.params.id)) notFound('MODEL_NOT_FOUND', 'Model not found');
      createOperatorAction({ action: 'model.delete', actor, targetType: 'model', targetId: req.params.id });
      res.json({ success: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/health-check', async (req, res) => {
    try {
      const model = getModel(req.params.id);
      if (!model) notFound('MODEL_NOT_FOUND', 'Model not found');
      const actor = actorFromRequest(req);
      let status: 'healthy' | 'degraded' | 'disabled' = model.enabled ? 'healthy' : 'disabled';
      let error: string | undefined;
      const startedAt = Date.now();
      if (model.provider === 'copilot' && model.enabled) {
        try {
          const discovered = await getModelGateway().listProviderModels('copilot');
          const match = discovered.find(candidate => candidate.id === model.id);
          if (!match) {
            status = 'degraded';
            error = 'Model is not present in the latest authenticated Copilot catalog; cached compatibility entry only.';
          } else if (match.policy?.state === 'disabled') {
            status = 'disabled';
            error = match.policy.terms || 'Disabled by Copilot policy';
          }
        } catch (healthError) {
          status = 'degraded';
          error = healthError instanceof Error ? healthError.message : 'Copilot model discovery failed';
        }
      }
      const checked = recordModelHealth({
        modelId: req.params.id,
        status,
        latencyMs: Date.now() - startedAt,
        error,
      });
      createOperatorAction({
        action: 'model.health_check',
        actor,
        targetType: 'model',
        targetId: req.params.id,
        metadata: { status: checked?.healthStatus },
      });
      res.json(checked);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
