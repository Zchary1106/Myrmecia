/**
 * Model Gateway — provider-agnostic chat client resolution + token streaming.
 *
 * Centralises provider construction so models can be routed between
 * OpenAI-compatible endpoints and the local GitHub Copilot CLI/SDK login.
 *
 * Config:
 *  - AGENT_FACTORY_BASE_URL / AGENT_FACTORY_API_KEY  → the default provider
 *  - MODEL_PROVIDERS    JSON: OpenAI `{ baseURL, apiKeyEnv }` entries and/or
 *                         Copilot `{ type: "copilot", baseDirectory?, cliPath? }`
 *  - MODEL_PROVIDER_MAP JSON: { "<modelId>": "<provider name>" }
 *
 * The Copilot entry only selects the server-side SDK adapter. It never carries
 * a GitHub token; the SDK uses the already signed-in local Copilot CLI/SDK user.
 */

import OpenAI from 'openai';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../lib/logger.js';
import { modelBaseURL, modelApiKey } from '../lib/brand-config.js';
import { CopilotProvider, type CopilotToolCall } from './copilot-provider.js';
import type { ModelInfo } from '@github/copilot-sdk';

export interface OpenAIProviderConfig {
  type: 'openai';
  baseURL: string;
  apiKey: string;
}

export interface CopilotProviderConfig {
  type: 'copilot';
  baseDirectory?: string;
  cliPath?: string;
}

export type ProviderConfig = OpenAIProviderConfig | CopilotProviderConfig;

export interface StreamAccumulation {
  choices: Array<{
    message: { role: 'assistant'; content: string | null; tool_calls?: any[] };
    finish_reason: string | null;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const DEFAULT_PROVIDER = 'default';

function copilotProviderConfig(raw?: { baseDirectory?: string; cliPath?: string }): CopilotProviderConfig {
  return {
    type: 'copilot',
    // SDK `empty` mode requires an explicit home. This is the same local
    // Copilot home the CLI uses by default; passing its path is not token
    // inspection and credentials never enter this process.
    baseDirectory: raw?.baseDirectory || process.env.COPILOT_SDK_HOME || join(homedir(), '.copilot'),
    cliPath: raw?.cliPath,
  };
}

function isCopilotSelected(): boolean {
  return process.env.MYRMECIA_MODEL_PROVIDER?.trim().toLowerCase() === 'copilot';
}

function defaultProviderConfig(): OpenAIProviderConfig {
  return {
    type: 'openai',
    baseURL: modelBaseURL(),
    apiKey: modelApiKey(),
  };
}

export function readProviders(): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = { [DEFAULT_PROVIDER]: defaultProviderConfig() };
  const raw = process.env.MODEL_PROVIDERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, {
        type?: string; baseURL?: string; apiKeyEnv?: string; apiKey?: string; baseDirectory?: string; cliPath?: string;
      }>;
      for (const [name, cfg] of Object.entries(parsed)) {
        if (cfg?.type === 'copilot') {
          // Do not accept apiKey/apiKeyEnv for this provider: authentication is
          // exclusively delegated to the signed-in local CLI/SDK credential store.
          if (cfg.apiKey || cfg.apiKeyEnv) {
            logger.warn({ provider: name }, 'ignoring token configuration for Copilot provider; use local Copilot CLI/SDK sign-in');
          }
          providers[name] = copilotProviderConfig(cfg);
        } else if (cfg?.baseURL) {
          providers[name] = {
            type: 'openai',
            baseURL: cfg.baseURL,
            apiKey: cfg.apiKey || (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] || '' : ''),
          };
        }
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'invalid MODEL_PROVIDERS JSON');
    }
  }
  // Contract: this server-only switch selects the locally signed-in Copilot
  // adapter without requiring Dashboard configuration or token material.
  if (isCopilotSelected() && !providers.copilot) {
    providers.copilot = copilotProviderConfig();
  }
  return providers;
}

export function readModelMap(): Record<string, string> {
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
  if (isCopilotSelected() && providers.copilot?.type === 'copilot') return 'copilot';
  if (modelMap[modelId] && providers[modelMap[modelId]]) return modelMap[modelId];
  const lower = modelId.toLowerCase();
  if (providers.openai?.type === 'openai' && (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3'))) return 'openai';
  if (providers.anthropic?.type === 'openai' && lower.startsWith('claude')) return 'anthropic';
  if (providers.google?.type === 'openai' && (lower.startsWith('gemini') || lower.startsWith('palm'))) return 'google';
  return DEFAULT_PROVIDER;
}

export class ModelGateway {
  private clients = new Map<string, OpenAI>();
  private copilotProviders = new Map<string, CopilotProvider>();

  /** Get an OpenAI-compatible client for the given model (defaults to the platform gateway). */
  clientForModel(modelId?: string): OpenAI {
    const providers = readProviders();
    const provider = resolveProviderName(modelId, providers, readModelMap());
    const cfg = providers[provider] || providers[DEFAULT_PROVIDER];
    if (cfg.type !== 'openai') {
      throw new Error(`Provider "${provider}" is not OpenAI-compatible; use completeForModel() instead.`);
    }
    const cacheKey = `${provider}:${cfg.baseURL}`;
    let client = this.clients.get(cacheKey);
    if (!client) {
      // Generous retries (exponential backoff is built into the SDK for 408/409/
      // 429/5xx) to ride out the gateway's intermittent 502 "upstream_error".
      client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, maxRetries: 5, timeout: 120_000 });
      this.clients.set(cacheKey, client);
    }
    return client;
  }

  /** Provider name a model would route to (for diagnostics). */
  providerFor(modelId?: string): string {
    return resolveProviderName(modelId, readProviders(), readModelMap());
  }

  supportsTools(modelId?: string): boolean {
    void modelId;
    return true;
  }

  async listProviderModels(providerName: string): Promise<ModelInfo[]> {
    const providers = readProviders();
    const cfg = providers[providerName];
    if (!cfg) throw new Error(`Provider "${providerName}" is not configured.`);
    if (cfg.type !== 'copilot') {
      throw new Error(`Provider "${providerName}" does not support authenticated model discovery.`);
    }
    return this.copilotProviderFor(providerName, cfg).listModels();
  }

  /**
   * Return a normalized OpenAI-like completion from the selected provider.
   * Copilot streaming emits text deltas but does not expose OpenAI usage fields.
   */
  async completeForModel(
    modelId: string,
    params: any,
    options?: {
      onDelta?: (text: string) => void;
      onToolCall?: (toolCall: CopilotToolCall) => Promise<string>;
      signal?: AbortSignal;
    },
  ): Promise<StreamAccumulation | any> {
    const providers = readProviders();
    const provider = resolveProviderName(modelId, providers, readModelMap());
    const cfg = providers[provider] || providers[DEFAULT_PROVIDER];
    if (cfg.type === 'copilot') {
      const adapter = this.copilotProviderFor(provider, cfg);
      return adapter.complete(params, options);
    }

    const client = this.clientForModel(modelId);
    return options?.onDelta
      ? streamChatCompletion(client, params, options.onDelta, options.signal)
      : client.chat.completions.create(params, { signal: options?.signal });
  }

  async shutdown(): Promise<void> {
    this.clients.clear();
    const providers = [...this.copilotProviders.values()];
    this.copilotProviders.clear();
    await Promise.all(providers.map(provider => provider.stop()));
  }

  reset(): void {
    this.clients.clear();
    this.copilotProviders.clear();
  }

  private copilotProviderFor(provider: string, cfg: CopilotProviderConfig): CopilotProvider {
    let adapter = this.copilotProviders.get(provider);
    if (!adapter) {
      adapter = new CopilotProvider({ baseDirectory: cfg.baseDirectory, cliPath: cfg.cliPath });
      this.copilotProviders.set(provider, adapter);
    }
    return adapter;
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

/** Stop the local Copilot SDK runtime, if one was started. */
export async function shutdownModelGateway(): Promise<void> {
  const current = gateway;
  gateway = null;
  await current?.shutdown();
}
