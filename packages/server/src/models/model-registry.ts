import { getDb } from '../db/database.js';
import { envWithAlias } from '../lib/brand-config.js';
import type { AgentDefinition, ModelDefinition, ModelHealthStatus, ModelRoute, ModelSelection, ModelTier, Task } from '../types.js';

interface BuiltinModel {
  id: string;
  displayName: string;
  description: string;
  capabilityTags: string[];
  priority: number;
  fallbackGroup: string;
  tier: ModelTier;
  maxTokens?: number;
  inputCostPer1k: number;
  outputCostPer1k: number;
}

const PROVIDER = 'copilot-api';

export const BUILTIN_MODELS: BuiltinModel[] = [
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    description: 'Primary strong model for orchestration, security, architecture, and difficult cross-file reasoning.',
    capabilityTags: ['reasoning', 'planning', 'review', 'tool-calls', 'structured-output', 'long-context'],
    priority: 110,
    fallbackGroup: 'premium-reasoning',
    tier: 'strong',
    maxTokens: 1_050_000,
    inputCostPer1k: 0.006,
    outputCostPer1k: 0.018,
  },
  {
    id: 'claude-opus-4.8',
    displayName: 'Claude Opus 4.8',
    description: 'Strong Claude fallback for planning, writing quality, and high-risk review.',
    capabilityTags: ['reasoning', 'architecture', 'review', 'vision', 'tool-calls', 'structured-output'],
    priority: 105,
    fallbackGroup: 'premium-reasoning',
    tier: 'strong',
    maxTokens: 200_000,
    inputCostPer1k: 0.005,
    outputCostPer1k: 0.015,
  },
  {
    id: 'claude-opus-4.7',
    displayName: 'Claude Opus 4.7',
    description: 'Strong Claude model for architecture and security review.',
    capabilityTags: ['reasoning', 'architecture', 'review', 'vision', 'tool-calls', 'structured-output'],
    priority: 100,
    fallbackGroup: 'premium-reasoning',
    tier: 'strong',
    maxTokens: 200_000,
    inputCostPer1k: 0.005,
    outputCostPer1k: 0.015,
  },
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    description: 'Long-context general model for large tasks, fallback, and broad analysis.',
    capabilityTags: ['reasoning', 'planning', 'review', 'tool-calls', 'structured-output', 'long-context'],
    priority: 96,
    fallbackGroup: 'balanced',
    tier: 'balanced',
    maxTokens: 1_050_000,
    inputCostPer1k: 0.004,
    outputCostPer1k: 0.012,
  },
  {
    id: 'gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro Preview',
    description: 'Powerful Gemini alternative for planning and multimodal/web-heavy review.',
    capabilityTags: ['reasoning', 'planning', 'vision', 'tool-calls'],
    priority: 88,
    fallbackGroup: 'balanced',
    tier: 'balanced',
    maxTokens: 200_000,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.009,
  },
  {
    id: 'gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex',
    description: 'Primary coding, refactoring, and engineering model.',
    capabilityTags: ['coding', 'engineering', 'refactor', 'tool-calls', 'structured-output'],
    priority: 94,
    fallbackGroup: 'coding',
    tier: 'balanced',
    maxTokens: 400_000,
    inputCostPer1k: 0.004,
    outputCostPer1k: 0.012,
  },
  {
    id: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 mini',
    description: 'Default cheap model for routing, QA, docs, GitOps, and simple structured work.',
    capabilityTags: ['fast', 'cheap', 'qa', 'docs', 'tool-calls', 'structured-output'],
    priority: 90,
    fallbackGroup: 'fast',
    tier: 'cheap',
    maxTokens: 400_000,
    inputCostPer1k: 0.0005,
    outputCostPer1k: 0.0015,
  },
  {
    id: 'claude-haiku-4.5',
    displayName: 'Claude Haiku 4.5',
    description: 'Fast Claude model for lightweight review, summaries, QA, and i18n.',
    capabilityTags: ['fast', 'cheap', 'qa', 'i18n', 'vision', 'tool-calls'],
    priority: 82,
    fallbackGroup: 'fast',
    tier: 'cheap',
    maxTokens: 200_000,
    inputCostPer1k: 0.0008,
    outputCostPer1k: 0.0024,
  },
  {
    id: 'gemini-3-flash-preview',
    displayName: 'Gemini 3 Flash Preview',
    description: 'Lightweight Gemini fallback for cheap multimodal or web-heavy tasks.',
    capabilityTags: ['fast', 'cheap', 'vision', 'tool-calls'],
    priority: 76,
    fallbackGroup: 'fast',
    tier: 'cheap',
    maxTokens: 128_000,
    inputCostPer1k: 0.0004,
    outputCostPer1k: 0.0012,
  },
];

const LEGACY_BUILTIN_MODEL_IDS = [
  'openai/claude-opus-4.7',
  'openai/claude-opus-4.6',
  'openai/gpt-5.5',
  'openai/claude-sonnet-4.6',
  'openai/claude-sonnet-4.5',
  'openai/gpt-5.4',
  'openai/claude-sonnet-4',
  'openai/gpt-5.3-codex',
  'openai/gpt-5.2-codex',
  'openai/claude-haiku-4.5',
  'openai/gpt-5.4-mini',
  'openai/gpt-5.2',
  'openai/gpt-5-mini',
  'openai/gpt-4.1',
];

const BUILTIN_ROUTES: ModelRoute[] = [
  { routeKey: 'global', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'task:simple', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'task:long-context', defaultModelId: 'gpt-5.4', fallbackGroup: 'balanced', modelTier: 'balanced', createdAt: '', updatedAt: '' },
  { routeKey: 'task:coding', defaultModelId: 'gpt-5.4', fallbackGroup: 'balanced', modelTier: 'balanced', createdAt: '', updatedAt: '' },
  { routeKey: 'task:high-risk', defaultModelId: 'claude-opus-4.7', fallbackGroup: 'premium-reasoning', modelTier: 'strong', createdAt: '', updatedAt: '' },
  { routeKey: 'role:orchestrator', defaultModelId: 'claude-opus-4.7', fallbackGroup: 'premium-reasoning', modelTier: 'strong', createdAt: '', updatedAt: '' },
  { routeKey: 'role:architect', defaultModelId: 'claude-opus-4.7', fallbackGroup: 'premium-reasoning', modelTier: 'strong', createdAt: '', updatedAt: '' },
  { routeKey: 'role:security-reviewer', defaultModelId: 'claude-opus-4.7', fallbackGroup: 'premium-reasoning', modelTier: 'strong', createdAt: '', updatedAt: '' },
  { routeKey: 'role:product-manager', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:designer', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:developer', defaultModelId: 'gpt-5.4', fallbackGroup: 'balanced', modelTier: 'balanced', createdAt: '', updatedAt: '' },
  { routeKey: 'role:database', defaultModelId: 'gpt-5.4', fallbackGroup: 'balanced', modelTier: 'balanced', createdAt: '', updatedAt: '' },
  { routeKey: 'role:api-architect', defaultModelId: 'gpt-5.4', fallbackGroup: 'balanced', modelTier: 'balanced', createdAt: '', updatedAt: '' },
  { routeKey: 'role:tester', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:qa-automation', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:devops', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:gitops', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:reviewer', defaultModelId: 'claude-opus-4.7', fallbackGroup: 'premium-reasoning', modelTier: 'strong', createdAt: '', updatedAt: '' },
  { routeKey: 'role:documentation', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:internationalization', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:content-writer', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:issue-refiner', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:release-compliance', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:accessibility-tester', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:react-dashboard-auditor', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:performance-investigator', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:release-notes', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:researcher', defaultModelId: 'claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
];

function parseArray(value: string | null | undefined): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function parseObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  const parsed = JSON.parse(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function rowToModel(row: any): ModelDefinition {
  const costProfile = parseObject(row.cost_profile);
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    description: row.description || '',
    capabilityTags: parseArray(row.capability_tags),
    costProfile,
    maxTokens: row.max_tokens ?? undefined,
    enabled: Boolean(row.enabled),
    priority: row.priority,
    fallbackGroup: row.fallback_group,
    tier: (row.model_tier || costProfile.tier || 'balanced') as ModelTier,
    healthStatus: row.health_status,
    lastCheckedAt: row.last_checked_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRoute(row: any): ModelRoute {
  return {
    routeKey: row.route_key,
    defaultModelId: row.default_model_id || undefined,
    fallbackGroup: row.fallback_group,
    modelTier: row.model_tier || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function syncBuiltinModels(): void {
  const db = getDb();
  db.transaction(() => {
    if (LEGACY_BUILTIN_MODEL_IDS.length > 0) {
      db.run(
        `UPDATE model_registry SET enabled = 0, updated_at = CURRENT_TIMESTAMP
         WHERE provider = ? AND id IN (${LEGACY_BUILTIN_MODEL_IDS.map(() => '?').join(',')})`,
        PROVIDER,
        ...LEGACY_BUILTIN_MODEL_IDS,
      );
    }
    for (const model of BUILTIN_MODELS) {
      db.run(`
        INSERT INTO model_registry (
          id, provider, display_name, description, capability_tags, cost_profile,
          max_tokens, priority, fallback_group, model_tier
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          provider = excluded.provider,
          display_name = excluded.display_name,
          description = excluded.description,
          capability_tags = excluded.capability_tags,
          cost_profile = excluded.cost_profile,
          max_tokens = excluded.max_tokens,
          priority = excluded.priority,
          fallback_group = excluded.fallback_group,
          model_tier = excluded.model_tier,
          enabled = 1,
          updated_at = CURRENT_TIMESTAMP
      `,
        model.id,
        PROVIDER,
        model.displayName,
        model.description,
        JSON.stringify(model.capabilityTags),
        JSON.stringify({
          source: 'builtin',
          tier: model.tier,
          fallbackGroup: model.fallbackGroup,
          pricing: {
            inputPer1k: model.inputCostPer1k,
            outputPer1k: model.outputCostPer1k,
          },
        }),
        model.maxTokens || null,
        model.priority,
        model.fallbackGroup,
        model.tier,
      );
    }

    for (const route of BUILTIN_ROUTES) {
      db.run(`
        INSERT INTO model_routes (route_key, default_model_id, fallback_group, model_tier)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(route_key) DO UPDATE SET
          default_model_id = excluded.default_model_id,
          fallback_group = excluded.fallback_group,
          model_tier = excluded.model_tier,
          updated_at = CURRENT_TIMESTAMP
      `, route.routeKey, route.defaultModelId || null, route.fallbackGroup, route.modelTier || null);
    }
  });
}

export function listModels(filter?: { enabled?: boolean }): ModelDefinition[] {
  const db = getDb();
  let sql = 'SELECT * FROM model_registry';
  const params: any[] = [];
  if (filter?.enabled !== undefined) {
    sql += ' WHERE enabled = ?';
    params.push(filter.enabled ? 1 : 0);
  }
  sql += ' ORDER BY enabled DESC, fallback_group ASC, priority DESC, display_name ASC';
  return (db.all(sql, ...params) as any[]).map(rowToModel);
}

export function getModel(id: string): ModelDefinition | undefined {
  const row = getDb().get('SELECT * FROM model_registry WHERE id = ?', id) as any;
  return row ? rowToModel(row) : undefined;
}

export function updateModel(id: string, updates: Partial<Pick<ModelDefinition, 'enabled' | 'priority' | 'fallbackGroup'>>): ModelDefinition | undefined {
  const sets: string[] = [];
  const params: any[] = [];
  if (updates.enabled !== undefined) { sets.push('enabled = ?'); params.push(updates.enabled ? 1 : 0); }
  if (updates.priority !== undefined) { sets.push('priority = ?'); params.push(updates.priority); }
  if (updates.fallbackGroup !== undefined) { sets.push('fallback_group = ?'); params.push(updates.fallbackGroup); }
  if (sets.length === 0) return getModel(id);
  sets.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  getDb().run(`UPDATE model_registry SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getModel(id);
}

export function listModelRoutes(): ModelRoute[] {
  return (getDb().all('SELECT * FROM model_routes ORDER BY route_key ASC') as any[]).map(rowToRoute);
}

export function upsertModelRoute(data: { routeKey: string; defaultModelId?: string; fallbackGroup: string; modelTier?: ModelTier }): ModelRoute {
  getDb().run(`
    INSERT INTO model_routes (route_key, default_model_id, fallback_group, model_tier)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(route_key) DO UPDATE SET
      default_model_id = excluded.default_model_id,
      fallback_group = excluded.fallback_group,
      model_tier = excluded.model_tier,
      updated_at = CURRENT_TIMESTAMP
  `, data.routeKey, data.defaultModelId || null, data.fallbackGroup, data.modelTier || null);
  return getModelRoute(data.routeKey)!;
}

export function getModelRoute(routeKey: string): ModelRoute | undefined {
  const row = getDb().get('SELECT * FROM model_routes WHERE route_key = ?', routeKey) as any;
  return row ? rowToRoute(row) : undefined;
}

function bestEnabledModel(fallbackGroup?: string): ModelDefinition | undefined {
  const db = getDb();
  const row = fallbackGroup
    ? db.get(`
        SELECT * FROM model_registry
        WHERE enabled = 1 AND fallback_group = ?
        ORDER BY priority DESC LIMIT 1
      `, fallbackGroup) as any
    : db.get(`
        SELECT * FROM model_registry
        WHERE enabled = 1
        ORDER BY priority DESC LIMIT 1
      `) as any;
  return row ? rowToModel(row) : undefined;
}

function bestEnabledModelByTier(tier?: ModelTier): ModelDefinition | undefined {
  if (!tier) return undefined;
  const row = getDb().get(`
    SELECT * FROM model_registry
    WHERE enabled = 1 AND model_tier = ?
    ORDER BY priority DESC LIMIT 1
  `, tier) as any;
  return row ? rowToModel(row) : undefined;
}

function enabledModel(id: string | undefined): ModelDefinition | undefined {
  if (!id) return undefined;
  const model = getModel(id);
  return model?.enabled ? model : undefined;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type ModelRouteTask = Partial<Pick<Task, 'title' | 'description' | 'input' | 'mode' | 'retryCount'>>;

function routeFromTask(agent: AgentDefinition, task?: ModelRouteTask, promptText?: string): {
  routeKey: string;
  profile: string;
  reason: string;
} | undefined {
  if (!task && !promptText) return undefined;
  const text = `${task?.title || ''}\n${task?.description || ''}\n${task?.input || ''}\n${promptText || ''}`.toLowerCase();
  const tokenEstimate = estimateTokens(text);
  const role = agent.role.toLowerCase();
  const retryCount = task?.retryCount || 0;

  if (tokenEstimate > 160_000 || /\b(large context|long context|entire repo|whole repository|全量|整个仓库|长上下文)\b/i.test(text)) {
    return { routeKey: 'task:long-context', profile: 'long-context', reason: `task needs long context (~${tokenEstimate} tokens)` };
  }

  if (retryCount >= 2) {
    return { routeKey: 'task:high-risk', profile: 'retry-escalation-strong', reason: `task has ${retryCount} failed attempt(s); escalating to strong model` };
  }

  const codingIntent = /\b(implement|fix|refactor|code|typescript|react|express|api|database|sql|test failure|bug|实现|修复|代码|重构)\b/i.test(text)
    || ['developer', 'database', 'api-architect'].includes(role);
  const explicitRiskReview = /\b(security review|security audit|threat model|vulnerability|exploit|prompt injection|sandbox escape|tenant isolation|dlp leak|secret leak|production rollback|release gate|合规审查|安全审查|漏洞|越权|租户隔离)\b/i.test(text)
    || ['orchestrator', 'architect', 'security-reviewer', 'reviewer'].includes(role);

  if (explicitRiskReview) {
    return { routeKey: 'task:high-risk', profile: 'high-risk', reason: 'task is high-risk or requires strong review' };
  }

  if (codingIntent) {
    return { routeKey: 'task:coding', profile: 'coding', reason: 'task requires code generation or engineering changes' };
  }

  if (retryCount >= 1) {
    return { routeKey: 'task:long-context', profile: 'retry-escalation-balanced', reason: 'cheap route failed once; escalating to balanced model' };
  }

  if (tokenEstimate < 12_000
    && /\b(summary|summarize|translate|docs|changelog|qa|test plan|triage|release notes|总结|翻译|文档|测试计划)\b/i.test(text)) {
    return { routeKey: 'task:simple', profile: 'simple', reason: 'task is small and low-risk' };
  }

  return undefined;
}

function selectionFromRoute(
  route: ModelRoute | undefined,
  source: ModelSelection['source'],
  reason: string,
  requestedModelId: string | undefined,
  budget: ModelSelection['budget'],
  taskProfile?: string,
): ModelSelection | undefined {
  const routeFallback = route?.fallbackGroup ? bestEnabledModel(route.fallbackGroup) : undefined;
  const model = enabledModel(route?.defaultModelId) || routeFallback;
  if (!model) return undefined;
  return {
    modelId: model.id,
    source,
    requestedModelId,
    fallbackGroup: route?.fallbackGroup || model.fallbackGroup,
    fallbackModelId: model.id !== route?.defaultModelId ? model.id : undefined,
    modelTier: route?.modelTier || model.tier,
    routeKey: route?.routeKey,
    budget,
    taskProfile,
    reason: model.id === route?.defaultModelId ? reason : `${reason}; route default unavailable, using ${route?.fallbackGroup || model.fallbackGroup} fallback ${model.id}`,
  };
}

export function selectModelForAgent(agent: AgentDefinition, task?: ModelRouteTask, options?: { promptText?: string }): ModelSelection {
  const policy = agent.config.modelPolicy || {};
  const explicit = agent.model || agent.config.model || policy.preferredModel;
  const explicitSource = agent.model ? 'agent.model' : agent.config.model ? 'agent.config.model' : policy.preferredModel ? 'agent.config.modelPolicy' : undefined;
  const budget = Object.keys(policy).length > 0 ? policy : undefined;
  const taskRoute = routeFromTask(agent, task, options?.promptText);
  if (taskRoute) {
    const selection = selectionFromRoute(
      getModelRoute(taskRoute.routeKey),
      'task.route',
      taskRoute.reason,
      explicit,
      budget,
      taskRoute.profile,
    );
    if (selection) return selection;
  }

  const fallbackModel = enabledModel(policy.fallbackModel);
  const explicitModel = enabledModel(explicit);
  if (explicitModel && explicitSource) {
    return {
      modelId: explicitModel.id,
      source: explicitSource,
      requestedModelId: explicit,
      fallbackGroup: explicitModel.fallbackGroup,
      fallbackModelId: policy.fallbackModel,
      modelTier: explicitModel.tier,
      budget,
      reason: `using ${explicitSource}`,
    };
  }

  const requestedModel = explicit ? getModel(explicit) : undefined;
  if (fallbackModel) {
    return {
      modelId: fallbackModel.id,
      source: 'agent.config.modelPolicy',
      requestedModelId: explicit,
      fallbackGroup: fallbackModel.fallbackGroup,
      fallbackModelId: fallbackModel.id,
      modelTier: fallbackModel.tier,
      budget,
      reason: explicit ? `requested model unavailable; using agent fallback ${fallbackModel.id}` : `using agent fallback ${fallbackModel.id}`,
    };
  }

  const tierModel = bestEnabledModelByTier(policy.tier);
  if (tierModel) {
    return {
      modelId: tierModel.id,
      source: 'agent.config.modelPolicy',
      requestedModelId: explicit,
      fallbackGroup: tierModel.fallbackGroup,
      fallbackModelId: policy.fallbackModel,
      modelTier: tierModel.tier,
      budget,
      reason: `using ${policy.tier} model tier`,
    };
  }

  const roleRoute = getModelRoute(`role:${agent.role}`);
  const roleSelection = selectionFromRoute(
    roleRoute,
    'role.route',
    explicit ? `requested model unavailable; using role route ${agent.role}` : `using role route ${agent.role}`,
    explicit,
    budget,
  );
  if (roleSelection) return roleSelection;

  const globalRoute = getModelRoute('global');
  const globalSelection = selectionFromRoute(globalRoute, 'global.route', 'using global route', explicit, budget);
  if (globalSelection) return globalSelection;

  const fallback = bestEnabledModel(requestedModel?.fallbackGroup || roleRoute?.fallbackGroup || globalRoute?.fallbackGroup)
    || bestEnabledModel();
  if (fallback) {
    return {
      modelId: fallback.id,
      source: 'fallback',
      requestedModelId: explicit,
      fallbackGroup: fallback.fallbackGroup,
      fallbackModelId: policy.fallbackModel,
      modelTier: fallback.tier,
      budget,
      reason: explicit ? `fallback for ${explicit}` : 'best enabled fallback',
    };
  }

  const envModel = envWithAlias('MYRMECIA_MODEL', 'AGENT_FACTORY_MODEL');
  return {
    modelId: envModel || 'gpt-5.4-mini',
    source: envModel ? 'env.default' : 'runtime.default',
    requestedModelId: explicit,
    fallbackModelId: policy.fallbackModel,
    modelTier: 'fallback',
    budget,
    reason: envModel ? 'using AGENT_FACTORY_MODEL env default' : 'using runtime hard default',
  };
}

export function recordModelHealth(data: {
  modelId: string;
  status: Exclude<ModelHealthStatus, 'unknown'>;
  latencyMs?: number;
  error?: string;
}): ModelDefinition | undefined {
  const db = getDb();
  db.run(`
    INSERT INTO model_health_checks (model_id, status, latency_ms, error)
    VALUES (?, ?, ?, ?)
  `, data.modelId, data.status, data.latencyMs ?? null, data.error || null);
  db.run(`
    UPDATE model_registry
    SET health_status = ?, last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, data.status, data.modelId);
  return getModel(data.modelId);
}

export function recordModelUsage(data: {
  modelId: string;
  agentId?: string;
  taskId?: string;
  executionId?: string;
  status: 'success' | 'failed';
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
  latencyMs?: number;
  routeReason?: string;
  routeSource?: ModelSelection['source'];
  modelTier?: ModelTier;
  workspaceId?: string;
  pipelineId?: string;
  stageIndex?: number;
}): void {
  if (!getModel(data.modelId)) return;
  const taskRow = data.taskId
    ? getDb().get('SELECT workspace_id, pipeline_id, stage_index FROM tasks WHERE id = ?', data.taskId) as any
    : undefined;
  getDb().run(`
    INSERT INTO model_usage_stats (
      model_id, task_id, execution_id, agent_id, status,
      input_tokens, output_tokens, cost_usd, model_tier, route_source,
      latency_ms, route_reason, workspace_id, pipeline_id, stage_index
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    data.modelId,
    data.taskId || null,
    data.executionId || null,
    data.agentId || null,
    data.status,
    data.inputTokens || 0,
    data.outputTokens || 0,
    data.costUSD && data.costUSD > 0 ? data.costUSD : estimateModelCost(data.modelId, data.inputTokens || 0, data.outputTokens || 0),
    data.modelTier || getModel(data.modelId)?.tier || null,
    data.routeSource || null,
    data.latencyMs ?? null,
    data.routeReason || null,
    data.workspaceId || taskRow?.workspace_id || 'default',
    data.pipelineId || taskRow?.pipeline_id || null,
    data.stageIndex ?? taskRow?.stage_index ?? null,
  );
}

export function estimateModelCost(modelId: string, inputTokens: number, outputTokens: number): number {
  const model = getModel(modelId);
  const pricing = model?.costProfile?.pricing;
  if (pricing && typeof pricing === 'object' && !Array.isArray(pricing)) {
    const inputPer1k = Number((pricing as Record<string, unknown>).inputPer1k);
    const outputPer1k = Number((pricing as Record<string, unknown>).outputPer1k);
    if (Number.isFinite(inputPer1k) && Number.isFinite(outputPer1k)) {
      return (inputTokens / 1000) * inputPer1k + (outputTokens / 1000) * outputPer1k;
    }
  }

  const modelLower = modelId.toLowerCase();
  let inputPrice = 0.003, outputPrice = 0.006;
  if (modelLower.includes('opus') || modelLower.includes('gpt-5.5')) { inputPrice = 0.006; outputPrice = 0.018; }
  else if (modelLower.includes('haiku') || modelLower.includes('mini') || modelLower.includes('flash')) { inputPrice = 0.0008; outputPrice = 0.0024; }
  else if (modelLower.includes('codex') || modelLower.includes('gpt-5.4')) { inputPrice = 0.004; outputPrice = 0.012; }
  return (inputTokens / 1000) * inputPrice + (outputTokens / 1000) * outputPrice;
}
