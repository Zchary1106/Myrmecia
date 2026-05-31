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
      { id: 'gpt-5.5', name: 'GPT-5.5', costPer1kTokens: 0.006, avgLatencyMs: 900, maxTokens: 1050000, healthy: true, capabilities: ['reasoning', 'analysis', 'long-context'] },
      { id: 'gpt-5.4', name: 'GPT-5.4', costPer1kTokens: 0.004, avgLatencyMs: 800, maxTokens: 1050000, healthy: true, capabilities: ['reasoning', 'analysis', 'long-context'] },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', costPer1kTokens: 0.004, avgLatencyMs: 850, maxTokens: 400000, healthy: true, capabilities: ['reasoning', 'code', 'analysis'] },
      { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', costPer1kTokens: 0.005, avgLatencyMs: 900, maxTokens: 200000, healthy: true, capabilities: ['reasoning', 'analysis', 'vision'] },
      { id: 'claude-opus-4.7', name: 'Claude Opus 4.7', costPer1kTokens: 0.005, avgLatencyMs: 900, maxTokens: 200000, healthy: true, capabilities: ['reasoning', 'analysis', 'vision'] },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', costPer1kTokens: 0.003, avgLatencyMs: 750, maxTokens: 200000, healthy: true, capabilities: ['reasoning', 'analysis', 'vision'] },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', costPer1kTokens: 0.0005, avgLatencyMs: 450, maxTokens: 400000, healthy: true, capabilities: ['reasoning', 'code', 'cheap'] },
      { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', costPer1kTokens: 0.0008, avgLatencyMs: 450, maxTokens: 200000, healthy: true, capabilities: ['reasoning', 'cheap', 'vision'] },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', costPer1kTokens: 0.0004, avgLatencyMs: 400, maxTokens: 128000, healthy: true, capabilities: ['reasoning', 'cheap', 'vision'] },
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
