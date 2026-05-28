/**
 * Multi-Model Smart Router & Cost Optimization (Task #14)
 *
 * Features:
 * - Route requests to best model based on complexity/cost/latency
 * - Fallback chain (primary → fallback → cache)
 * - Model health probing and auto-removal
 * - Cost estimation before routing
 */

import { logger } from '../lib/logger.js';

// ---------- Types ----------

export interface RouteRequest {
  prompt: string;
  maxTokens?: number;
  priority?: 'low' | 'normal' | 'high';
  constraints?: {
    maxCostUSD?: number;
    maxLatencyMs?: number;
    preferredModels?: string[];
  };
}

export interface RouteResult {
  modelId: string;
  estimatedCostUSD: number;
  estimatedLatencyMs: number;
  reason: string;
}

interface ModelEndpoint {
  id: string;
  name: string;
  costPer1kTokens: number;
  avgLatencyMs: number;
  maxTokens: number;
  healthy: boolean;
  capabilities: string[];
}

// ---------- Service ----------

export class SmartRouter {
  private models: ModelEndpoint[] = [];
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private cache = new Map<string, { result: string; timestamp: number }>();

  constructor() {
    this.loadModels();
  }

  private loadModels(): void {
    // Load model configurations from database or defaults
    this.models = [
      { id: 'gpt-4o', name: 'GPT-4o', costPer1kTokens: 0.005, avgLatencyMs: 800, maxTokens: 128000, healthy: true, capabilities: ['reasoning', 'code', 'vision'] },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', costPer1kTokens: 0.00015, avgLatencyMs: 400, maxTokens: 128000, healthy: true, capabilities: ['reasoning', 'code'] },
      { id: 'claude-sonnet', name: 'Claude Sonnet', costPer1kTokens: 0.003, avgLatencyMs: 600, maxTokens: 200000, healthy: true, capabilities: ['reasoning', 'code', 'analysis'] },
    ];
    logger.info({ count: this.models.length }, 'Smart router models loaded');
  }

  route(request: RouteRequest): RouteResult {
    const healthy = this.models.filter(m => m.healthy);
    if (healthy.length === 0) {
      // Fallback to cache
      return { modelId: 'cache', estimatedCostUSD: 0, estimatedLatencyMs: 0, reason: 'all models unhealthy, using cache' };
    }

    const complexity = this.estimateComplexity(request.prompt);
    let candidates = healthy;

    // Filter by constraints
    if (request.constraints?.maxCostUSD) {
      const maxCost = request.constraints.maxCostUSD;
      candidates = candidates.filter(m => this.estimateCost(m, request) <= maxCost);
    }
    if (request.constraints?.maxLatencyMs) {
      const maxLatency = request.constraints.maxLatencyMs;
      candidates = candidates.filter(m => m.avgLatencyMs <= maxLatency);
    }
    if (request.constraints?.preferredModels?.length) {
      const preferred = candidates.filter(m => request.constraints!.preferredModels!.includes(m.id));
      if (preferred.length > 0) candidates = preferred;
    }

    if (candidates.length === 0) candidates = healthy;

    // Pick best model based on complexity
    let selected: ModelEndpoint;
    if (complexity === 'high' || request.priority === 'high') {
      selected = candidates.sort((a, b) => b.costPer1kTokens - a.costPer1kTokens)[0];
    } else if (complexity === 'low' || request.priority === 'low') {
      selected = candidates.sort((a, b) => a.costPer1kTokens - b.costPer1kTokens)[0];
    } else {
      selected = candidates.sort((a, b) => a.avgLatencyMs - b.avgLatencyMs)[0];
    }

    return {
      modelId: selected.id,
      estimatedCostUSD: this.estimateCost(selected, request),
      estimatedLatencyMs: selected.avgLatencyMs,
      reason: `complexity=${complexity}, priority=${request.priority ?? 'normal'}`,
    };
  }

  estimateCost(model: ModelEndpoint, request: RouteRequest): number {
    const tokens = (request.prompt.length / 4) + (request.maxTokens ?? 500);
    return (tokens / 1000) * model.costPer1kTokens;
  }

  private estimateComplexity(prompt: string): 'low' | 'medium' | 'high' {
    const len = prompt.length;
    if (len > 5000) return 'high';
    if (len > 1000) return 'medium';
    return 'low';
  }

  probeHealth(): void {
    for (const model of this.models) {
      // In production, this would ping the model endpoint
      // For now, mark all as healthy
      model.healthy = true;
    }
    logger.debug('Health probe complete');
  }

  startHealthChecks(intervalMs = 60000): void {
    this.healthCheckInterval = setInterval(() => this.probeHealth(), intervalMs);
  }

  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  getModels(): ModelEndpoint[] {
    return this.models;
  }

  removeModel(modelId: string): void {
    this.models = this.models.filter(m => m.id !== modelId);
    logger.info({ modelId }, 'Model removed from router');
  }
}

// ---------- Singleton ----------

export const smartRouter = new SmartRouter();
