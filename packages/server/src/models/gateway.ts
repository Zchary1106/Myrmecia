/**
 * Model Gateway — provider-agnostic chat client resolution + token streaming.
 *
 * Centralises construction of the (OpenAI-compatible) client so models can be
 * routed to different providers/base URLs/keys via config, and provides a
 * streaming helper that accumulates a normal completion object while emitting
 * incremental token deltas.
 *
 * Config:
 *  - AGENT_FACTORY_BASE_URL / AGENT_FACTORY_API_KEY  → the default provider
 *  - MODEL_PROVIDERS    JSON: { "<name>": { "baseURL": "...", "apiKeyEnv": "OPENAI_API_KEY" } }
 *  - MODEL_PROVIDER_MAP JSON: { "<modelId>": "<provider name>" }
 */

import OpenAI from 'openai';
import { logger } from '../lib/logger.js';
import { modelBaseURL, modelApiKey } from '../lib/brand-config.js';

export interface ProviderConfig {
  baseURL: string;
  apiKey: string;
}

export interface StreamAccumulation {
  choices: Array<{
    message: { role: 'assistant'; content: string | null; tool_calls?: any[] };
    finish_reason: string | null;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const DEFAULT_PROVIDER = 'default';

function defaultProviderConfig(): ProviderConfig {
  return {
    baseURL: modelBaseURL(),
    apiKey: modelApiKey(),
  };
}

function readProviders(): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = { [DEFAULT_PROVIDER]: defaultProviderConfig() };
  const raw = process.env.MODEL_PROVIDERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, { baseURL: string; apiKeyEnv?: string; apiKey?: string }>;
      for (const [name, cfg] of Object.entries(parsed)) {
        if (!cfg?.baseURL) continue;
        providers[name] = {
          baseURL: cfg.baseURL,
          apiKey: cfg.apiKey || (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] || '' : ''),
        };
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'invalid MODEL_PROVIDERS JSON');
    }
  }
  return providers;
}

function readModelMap(): Record<string, string> {
  const raw = process.env.MODEL_PROVIDER_MAP;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/** Resolve which provider a model belongs to (explicit map → prefix heuristic → default). */
export function resolveProviderName(
  modelId: string | undefined,
  providers: Record<string, ProviderConfig>,
  modelMap: Record<string, string>
): string {
  if (!modelId) return DEFAULT_PROVIDER;
  if (modelMap[modelId] && providers[modelMap[modelId]]) return modelMap[modelId];
  const lower = modelId.toLowerCase();
  if (providers.openai && (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3'))) return 'openai';
  if (providers.anthropic && lower.startsWith('claude')) return 'anthropic';
  if (providers.google && (lower.startsWith('gemini') || lower.startsWith('palm'))) return 'google';
  return DEFAULT_PROVIDER;
}

export class ModelGateway {
  private clients = new Map<string, OpenAI>();

  /** Get an OpenAI-compatible client for the given model (defaults to the platform gateway). */
  clientForModel(modelId?: string): OpenAI {
    const providers = readProviders();
    const provider = resolveProviderName(modelId, providers, readModelMap());
    const cfg = providers[provider] || providers[DEFAULT_PROVIDER];
    const cacheKey = `${provider}:${cfg.baseURL}`;
    let client = this.clients.get(cacheKey);
    if (!client) {
      client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
      this.clients.set(cacheKey, client);
    }
    return client;
  }

  /** Provider name a model would route to (for diagnostics). */
  providerFor(modelId?: string): string {
    return resolveProviderName(modelId, readProviders(), readModelMap());
  }

  reset(): void {
    this.clients.clear();
  }
}

/**
 * Accumulate an OpenAI streaming response into a normal completion shape while
 * invoking `onDelta` with each text fragment. Pure over the async iterable, so
 * it is unit-testable without a network call.
 */
export async function accumulateStream(
  stream: AsyncIterable<any>,
  onDelta?: (text: string) => void
): Promise<StreamAccumulation> {
  let content = '';
  let finishReason: string | null = null;
  const toolCalls: any[] = [];
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for await (const chunk of stream) {
    if (chunk?.usage) usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      content += delta.content;
      onDelta?.(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const cleanToolCalls = toolCalls.filter(Boolean);
  return {
    choices: [{
      message: { role: 'assistant', content: content || null, tool_calls: cleanToolCalls.length ? cleanToolCalls : undefined },
      finish_reason: finishReason,
    }],
    usage,
  };
}

/** Stream a chat completion, emitting token deltas; returns a normal completion object. */
export async function streamChatCompletion(
  client: OpenAI,
  params: any,
  onDelta?: (text: string) => void,
  signal?: AbortSignal
): Promise<StreamAccumulation> {
  const stream = await client.chat.completions.create(
    { ...params, stream: true, stream_options: { include_usage: true } },
    { signal }
  ) as any;
  return accumulateStream(stream, onDelta);
}

// ---------- Singleton ----------

let gateway: ModelGateway | null = null;

export function getModelGateway(): ModelGateway {
  if (!gateway) gateway = new ModelGateway();
  return gateway;
}

export function resetModelGateway(): void {
  gateway?.reset();
  gateway = null;
}
