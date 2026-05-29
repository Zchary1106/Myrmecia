import { getDb } from '../db/database.js';
import type { AgentDefinition, ModelDefinition, ModelHealthStatus, ModelRoute, ModelSelection, ModelTier } from '../types.js';

interface BuiltinModel {
  id: string;
  displayName: string;
  description: string;
  capabilityTags: string[];
  priority: number;
  fallbackGroup: string;
  tier: ModelTier;
  maxTokens?: number;
}

const PROVIDER = 'copilot-api';

export const BUILTIN_MODELS: BuiltinModel[] = [
  {
    id: 'openai/claude-opus-4.7',
    displayName: 'Claude Opus 4.7',
    description: 'Strongest Claude reasoning for master planning, architecture, and high-risk review.',
    capabilityTags: ['reasoning', 'architecture', 'review', 'long-context'],
    priority: 100,
    fallbackGroup: 'premium-reasoning',
    tier: 'strong',
  },
  {
    id: 'openai/claude-opus-4.6',
    displayName: 'Claude Opus 4.6',
    description: 'Complex planning and long-context analysis.',
    capabilityTags: ['reasoning', 'planning', 'long-context'],
    priority: 95,
    fallbackGroup: 'premium-reasoning',
    tier: 'strong',
  },
  {
    id: 'openai/gpt-5.5',
    displayName: 'GPT-5.5',
    description: 'Strong general reasoning for orchestration, review, and planning.',
    capabilityTags: ['reasoning', 'planning', 'review'],
    priority: 92,
    fallbackGroup: 'premium-reasoning',
    tier: 'strong',
  },
  {
    id: 'openai/claude-sonnet-4.6',
    displayName: 'Claude Sonnet 4.6',
    description: 'High-quality balanced Claude model for PM, review, content, and docs.',
    capabilityTags: ['balanced', 'reasoning', 'content', 'review'],
    priority: 90,
    fallbackGroup: 'balanced',
    tier: 'balanced',
  },
  {
    id: 'openai/claude-sonnet-4.5',
    displayName: 'Claude Sonnet 4.5',
    description: 'Stable balanced Claude fallback.',
    capabilityTags: ['balanced', 'reasoning'],
    priority: 84,
    fallbackGroup: 'balanced',
    tier: 'balanced',
  },
  {
    id: 'openai/gpt-5.4',
    displayName: 'GPT-5.4',
    description: 'Default balanced GPT model for most agents.',
    capabilityTags: ['balanced', 'reasoning', 'content'],
    priority: 82,
    fallbackGroup: 'balanced',
    tier: 'balanced',
  },
  {
    id: 'openai/claude-sonnet-4',
    displayName: 'Claude Sonnet 4',
    description: 'Claude Sonnet compatibility fallback.',
    capabilityTags: ['balanced'],
    priority: 78,
    fallbackGroup: 'balanced',
    tier: 'balanced',
  },
  {
    id: 'openai/gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex',
    description: 'Coding, refactoring, and engineering work.',
    capabilityTags: ['coding', 'engineering', 'refactor'],
    priority: 88,
    fallbackGroup: 'coding',
    tier: 'balanced',
  },
  {
    id: 'openai/gpt-5.2-codex',
    displayName: 'GPT-5.2 Codex',
    description: 'Coding fallback.',
    capabilityTags: ['coding', 'engineering'],
    priority: 80,
    fallbackGroup: 'coding',
    tier: 'balanced',
  },
  {
    id: 'openai/claude-haiku-4.5',
    displayName: 'Claude Haiku 4.5',
    description: 'Fast/low-cost Claude model for QA, i18n, and simple processing.',
    capabilityTags: ['fast', 'cheap', 'qa', 'i18n'],
    priority: 76,
    fallbackGroup: 'fast',
    tier: 'cheap',
  },
  {
    id: 'openai/gpt-5.4-mini',
    displayName: 'GPT-5.4 mini',
    description: 'Fast/low-cost QA, i18n, and simple docs.',
    capabilityTags: ['fast', 'cheap', 'qa', 'docs'],
    priority: 74,
    fallbackGroup: 'fast',
    tier: 'cheap',
  },
  {
    id: 'openai/gpt-5.2',
    displayName: 'GPT-5.2',
    description: 'General fallback.',
    capabilityTags: ['general'],
    priority: 70,
    fallbackGroup: 'balanced',
    tier: 'fallback',
  },
  {
    id: 'openai/gpt-5-mini',
    displayName: 'GPT-5 mini',
    description: 'Lightweight tasks.',
    capabilityTags: ['fast', 'cheap'],
    priority: 68,
    fallbackGroup: 'fast',
    tier: 'cheap',
  },
  {
    id: 'openai/gpt-4.1',
    displayName: 'GPT-4.1',
    description: 'Compatibility and fast fallback.',
    capabilityTags: ['fast', 'compatibility'],
    priority: 60,
    fallbackGroup: 'fast',
    tier: 'fallback',
  },
];

const BUILTIN_ROUTES: ModelRoute[] = [
  { routeKey: 'global', defaultModelId: 'openai/claude-sonnet-4.6', fallbackGroup: 'balanced', modelTier: 'balanced', createdAt: '', updatedAt: '' },
  { routeKey: 'role:orchestrator', defaultModelId: 'openai/claude-opus-4.7', fallbackGroup: 'premium-reasoning', modelTier: 'strong', createdAt: '', updatedAt: '' },
  { routeKey: 'role:architect', defaultModelId: 'openai/claude-sonnet-4.6', fallbackGroup: 'balanced', modelTier: 'strong', createdAt: '', updatedAt: '' },
  { routeKey: 'role:security-reviewer', defaultModelId: 'openai/claude-sonnet-4.6', fallbackGroup: 'balanced', modelTier: 'strong', createdAt: '', updatedAt: '' },
  { routeKey: 'role:product-manager', defaultModelId: 'openai/claude-sonnet-4.6', fallbackGroup: 'balanced', modelTier: 'strong', createdAt: '', updatedAt: '' },
  { routeKey: 'role:designer', defaultModelId: 'openai/claude-sonnet-4.6', fallbackGroup: 'balanced', modelTier: 'balanced', createdAt: '', updatedAt: '' },
  { routeKey: 'role:developer', defaultModelId: 'openai/gpt-5.3-codex', fallbackGroup: 'coding', modelTier: 'balanced', createdAt: '', updatedAt: '' },
  { routeKey: 'role:tester', defaultModelId: 'openai/claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:qa-automation', defaultModelId: 'openai/claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:devops', defaultModelId: 'openai/claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:gitops', defaultModelId: 'openai/claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:reviewer', defaultModelId: 'openai/claude-sonnet-4.6', fallbackGroup: 'balanced', modelTier: 'strong', createdAt: '', updatedAt: '' },
  { routeKey: 'role:documentation', defaultModelId: 'openai/claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:internationalization', defaultModelId: 'openai/claude-haiku-4.5', fallbackGroup: 'fast', modelTier: 'cheap', createdAt: '', updatedAt: '' },
  { routeKey: 'role:content-writer', defaultModelId: 'openai/claude-sonnet-4.6', fallbackGroup: 'balanced', modelTier: 'balanced', createdAt: '', updatedAt: '' },
  { routeKey: 'role:researcher', defaultModelId: 'openai/claude-sonnet-4.6', fallbackGroup: 'balanced', modelTier: 'balanced', createdAt: '', updatedAt: '' },
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
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    description: row.description || '',
    capabilityTags: parseArray(row.capability_tags),
    costProfile: parseObject(row.cost_profile),
    maxTokens: row.max_tokens ?? undefined,
    enabled: Boolean(row.enabled),
    priority: row.priority,
    fallbackGroup: row.fallback_group,
    tier: row.model_tier || row.cost_profile?.tier || 'balanced',
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
          updated_at = CURRENT_TIMESTAMP
      `,
        model.id,
        PROVIDER,
        model.displayName,
        model.description,
        JSON.stringify(model.capabilityTags),
        JSON.stringify({ tier: model.tier, fallbackGroup: model.fallbackGroup }),
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
        ON CONFLICT(route_key) DO NOTHING
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

export function selectModelForAgent(agent: AgentDefinition): ModelSelection {
  const policy = agent.config.modelPolicy || {};
  const explicit = agent.model || agent.config.model || policy.preferredModel;
  const explicitSource = agent.model ? 'agent.model' : agent.config.model ? 'agent.config.model' : policy.preferredModel ? 'agent.config.modelPolicy' : undefined;
  const budget = Object.keys(policy).length > 0 ? policy : undefined;
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
  const roleModel = enabledModel(roleRoute?.defaultModelId);
  if (roleModel) {
    return {
      modelId: roleModel.id,
      source: 'role.route',
      requestedModelId: explicit,
      fallbackGroup: roleRoute?.fallbackGroup || roleModel.fallbackGroup,
      fallbackModelId: policy.fallbackModel,
      modelTier: roleRoute?.modelTier || roleModel.tier,
      routeKey: roleRoute?.routeKey,
      budget,
      reason: explicit
        ? `requested model unavailable; using role route ${agent.role}`
        : `using role route ${agent.role}`,
    };
  }

  const globalRoute = getModelRoute('global');
  const globalModel = enabledModel(globalRoute?.defaultModelId);
  if (globalModel) {
    return {
      modelId: globalModel.id,
      source: 'global.route',
      requestedModelId: explicit,
      fallbackGroup: globalRoute?.fallbackGroup || globalModel.fallbackGroup,
      fallbackModelId: policy.fallbackModel,
      modelTier: globalRoute?.modelTier || globalModel.tier,
      routeKey: globalRoute?.routeKey,
      budget,
      reason: 'using global route',
    };
  }

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

  const envModel = process.env.CREWAI_MODEL;
  return {
    modelId: envModel || 'openai/gpt-5.4',
    source: envModel ? 'env.default' : 'runtime.default',
    requestedModelId: explicit,
    fallbackModelId: policy.fallbackModel,
    modelTier: 'fallback',
    budget,
    reason: envModel ? 'using CREWAI_MODEL env default' : 'using runtime hard default',
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
    data.costUSD || 0,
    data.modelTier || getModel(data.modelId)?.tier || null,
    data.routeSource || null,
    data.latencyMs ?? null,
    data.routeReason || null,
    data.workspaceId || taskRow?.workspace_id || 'default',
    data.pipelineId || taskRow?.pipeline_id || null,
    data.stageIndex ?? taskRow?.stage_index ?? null,
  );
}
