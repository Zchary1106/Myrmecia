/**
 * GitHub Copilot SDK adapter.
 *
 * Authentication intentionally relies only on the local Copilot CLI/SDK login.
 * This adapter never accepts, reads, serializes, or returns a GitHub token.
 * Keep this module server-side: it must not be imported by the Dashboard.
 */

import { CopilotClient, RuntimeConnection, type ModelInfo } from '@github/copilot-sdk';
import { logger } from '../lib/logger.js';
import type { StreamAccumulation } from './gateway.js';
import type { ProviderSessionOptions } from './provider-session.js';
import { AgentRunStopped } from '../agents/run-state.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { attachFailedRequestUsage } from './failed-request-usage.js';

export interface CopilotContextBudget {
  limits: { maxExecutionTokens: number };
  inputTokens: number;
  outputTokens: number;
}

export interface CopilotToolCall {
  id: string;
  function: { name: string; arguments: string };
  /** Internal cancellation only; never serialized into model arguments. */
  signal?: AbortSignal;
}

export interface CopilotProviderOptions {
  /** Optional server-local Copilot home. Defaults to the CLI's normal home. */
  baseDirectory?: string;
  /** Optional server-local CLI/runtime path. Never sent to clients. */
  cliPath?: string;
}

export interface CopilotSessionLike {
  readonly sessionId?: string;
  sendAndWait(options: { prompt: string }, timeout?: number): Promise<{ data: { content: string } } | undefined>;
  disconnect(): Promise<void>;
  abort(): Promise<void>;
  on(
    event: 'assistant.message_delta' | 'assistant.usage',
    handler: (event: {
      data: {
        deltaContent?: string;
        inputTokens?: number;
        outputTokens?: number;
        model?: string;
        cost?: number;
        copilotUsage?: { totalNanoAiu: number };
      };
    }) => void,
  ): () => void;
}

export interface CopilotClientLike {
  resumeSession?(sessionId: string, config: Parameters<CopilotClientLike['createSession']>[0] & {
    continuePendingWork: false; suppressResumeEvent: true;
  }): Promise<CopilotSessionLike>;
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  listModels?(): Promise<ModelInfo[]>;
  getAuthStatus?(): Promise<{ isAuthenticated: boolean; authType?: string; host?: string; login?: string; statusMessage?: string }>;
  createSession(config: {
    model: string;
    systemMessage: { mode: 'append'; content: string };
    availableTools: string[];
    streaming: boolean;
    tools?: Array<{
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
      defer: 'never';
      skipPermission?: boolean;
      handler: (args: unknown, invocation: { toolCallId: string; toolName: string }) => Promise<string>;
    }>;
  }): Promise<CopilotSessionLike>;
}

export type CopilotClientFactory = (options: {
  mode: 'empty';
  baseDirectory?: string;
  useLoggedInUser: true;
  logLevel: 'error';
  cliPath?: string;
}) => CopilotClientLike;

function createCopilotClient({ cliPath, ...options }: Parameters<CopilotClientFactory>[0]): CopilotClientLike {
  return new CopilotClient({
    ...options,
    ...(cliPath ? { connection: RuntimeConnection.forStdio({ path: cliPath }) } : {}),
  }) as unknown as CopilotClientLike;
}

function textFromMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => typeof part === 'string' ? part : String((part as any)?.text || '')).join('');
  }
  return '';
}

function formatPrompt(messages: Array<{ role: string; content?: unknown }>): { system: string; prompt: string } {
  const system = messages
    .filter(message => message.role === 'system')
    .map(message => textFromMessageContent(message.content))
    .filter(Boolean)
    .join('\n\n');

  const prompt = messages
    .filter(message => message.role !== 'system')
    .map(message => {
      const content = textFromMessageContent(message.content);
      return message.role === 'user' ? content : `[${message.role}]\n${content}`;
    })
    .filter(Boolean)
    .join('\n\n');

  return { system, prompt };
}

async function disconnectBounded(session: CopilotSessionLike): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      session.disconnect().then(() => true).catch(() => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * Adapter for Copilot's session API. It deliberately runs in SDK `empty` mode
 * and only allows explicitly supplied custom tools, so Copilot CLI built-in
 * tools cannot gain access to the server's filesystem, shell, MCP connections,
 * or Dashboard. Custom tools are always executed by the TS agent loop.
 *
 * The SDK does not return OpenAI function-call continuations. It instead
 * invokes supplied custom tool handlers and resumes its own session. The
 * handler bridge below keeps validation, sandboxing, audit, and execution in
 * the TS loop rather than delegating tools to Copilot.
 */
export class CopilotProvider {
  private client: CopilotClientLike | undefined;
  private startPromise: Promise<void> | undefined;
  private sessionResumeSupported = false;

  supportsSessionResume(): boolean { return this.sessionResumeSupported; }

  constructor(
    private readonly options: CopilotProviderOptions = {},
    private readonly clientFactory: CopilotClientFactory = createCopilotClient,
  ) {}

  supportsTools(): boolean {
    return true;
  }

  async listModels(): Promise<ModelInfo[]> {
    const client = await this.getClient();
    if (!client.listModels) {
      throw new Error('The installed GitHub Copilot SDK does not support model discovery.');
    }
    return client.listModels();
  }

  async getAuthStatus(): Promise<{ isAuthenticated: boolean; authType?: string; host?: string; login?: string; statusMessage?: string }> {
    const client = await this.getClient();
    if (!client.getAuthStatus) return { isAuthenticated: false, statusMessage: 'The installed Copilot SDK does not expose authentication status.' };
    return client.getAuthStatus();
  }

  async complete(
    params: {
      model: string;
      messages: Array<{ role: string; content?: unknown }>;
      tools?: unknown[];
    },
    options?: {
      onDelta?: (text: string) => void;
      onToolCall?: (toolCall: CopilotToolCall) => Promise<string>;
      signal?: AbortSignal;
      timeoutMs?: number;
      idleTimeoutMs?: number;
      providerSession?: ProviderSessionOptions;
      contextBudget?: CopilotContextBudget;
    },
  ): Promise<StreamAccumulation> {
    if (params.tools?.length && !options?.onToolCall) {
      throw new Error('GitHub Copilot provider requires a server-side tool handler for OpenAI function tools.');
    }
    if (options?.signal?.aborted) throw new Error('Request aborted');

    const { system, prompt } = formatPrompt(params.messages);
    // Shared SDK transports deliver callbacks in their creation context, not
    // necessarily this request's workspace/run lease. Restore the original
    // caller context; never clear/bypass a fence to accommodate the transport.
    const inRequestContext = AsyncLocalStorage.snapshot();
    const controller = new AbortController();
    const wallClockMs = Math.max(1, options?.timeoutMs ?? (params.tools?.length ? 600_000 : 120_000));
    const idleMs = Math.max(1, Math.min(options?.idleTimeoutMs ?? 180_000, wallClockMs));
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectStopped!: (error: Error) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
    // A rejection can precede sendAndWait while session startup is pending.
    void stopped.catch(() => undefined);
    const stop = (error: Error) => {
      if (controller.signal.aborted) return;
      controller.abort();
      rejectStopped(error);
    };
    const touch = () => {
      if (controller.signal.aborted) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop(new Error(`EXECUTION_IDLE_TIMEOUT: no model or tool progress for ${idleMs}ms`)), idleMs);
    };
    const tools = this.toCopilotTools(params.tools, options?.onToolCall ? call => inRequestContext(async () => {
      if (controller.signal.aborted) throw new Error('Request aborted');
      touch();
      try { return await options.onToolCall!({ ...call, signal: controller.signal }); }
      catch (error) {
        // SDK tools normally return errors to the model. A terminal host stop
        // must instead stop the inner loop and retain its original reason.
        if (error instanceof AgentRunStopped) stop(error);
        throw error;
      }
      finally { touch(); }
    }) : undefined);
    const abort = () => stop(new Error('Request aborted'));
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) abort();
    touch();
    wallTimer = setTimeout(() => stop(new Error(`EXECUTION_WALL_TIMEOUT: execution budget of ${wallClockMs}ms exhausted`)), wallClockMs);
    let session!: CopilotSessionLike;
    try {
      if (controller.signal.aborted) throw new Error('Request aborted');
      const client = await Promise.race([this.getClient(), stopped]);
      this.sessionResumeSupported = typeof client.resumeSession === 'function';
      const sessionConfig: Parameters<CopilotClientLike['createSession']>[0] = {
        model: params.model,
        // Only registered custom tools are allowed; built-ins stay unavailable.
        availableTools: tools.length ? ['custom:*'] : [],
        systemMessage: { mode: 'append', content: system },
        streaming: true,
        ...(tools.length ? { tools } : {}),
      };
      const resumeId = options?.providerSession?.resumeSessionId;
      const resumed = Boolean(resumeId && client.resumeSession);
      const creating = resumed
        ? client.resumeSession!(resumeId!, { ...sessionConfig, continuePendingWork: false, suppressResumeEvent: true })
        : client.createSession(sessionConfig);
      // Session creation may finish after our caller has cancelled or timed out.
      void creating.then(late => {
        if (controller.signal.aborted) {
          void late.abort().catch(() => undefined);
          void late.disconnect().catch(() => undefined);
        }
      }).catch(() => undefined);
      session = await Promise.race([creating, stopped]);
      if (session.sessionId) options?.providerSession?.onSessionReady?.(session.sessionId, resumed);
    } catch (err) {
      stop(err instanceof Error ? err : new Error(String(err)));
      if (idleTimer) clearTimeout(idleTimer);
      if (wallTimer) clearTimeout(wallTimer);
      options?.signal?.removeEventListener('abort', abort);
      if (session) {
        void session.abort().catch(() => undefined);
        await disconnectBounded(session);
      }
      throw err;
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let inputTokensObserved = false;
    let outputTokensObserved = false;
    let aiUnitsObserved = false;
    let actualModelId: string | undefined;
    let aiUnits = 0;
    let billingMultiplier: number | undefined;
    const unsubscribeDelta = session.on('assistant.message_delta', event => inRequestContext(() => {
      if (controller.signal.aborted) return;
      if (event.data.deltaContent) {
        touch();
        options?.onDelta?.(event.data.deltaContent);
      }
    }));
    const unsubscribeUsage = session.on('assistant.usage', event => inRequestContext(() => {
      if (controller.signal.aborted) return;
      touch();
      if (typeof event.data.inputTokens === 'number' && Number.isFinite(event.data.inputTokens) && event.data.inputTokens >= 0) {
        inputTokens += event.data.inputTokens;
        inputTokensObserved = true;
      }
      if (typeof event.data.outputTokens === 'number' && Number.isFinite(event.data.outputTokens) && event.data.outputTokens >= 0) {
        outputTokens += event.data.outputTokens;
        outputTokensObserved = true;
      }
      actualModelId = event.data.model || actualModelId;
      if (typeof event.data.cost === 'number') billingMultiplier = event.data.cost;
      if (typeof event.data.copilotUsage?.totalNanoAiu === 'number') {
        aiUnits += event.data.copilotUsage.totalNanoAiu / 1_000_000_000;
        aiUnitsObserved = true;
      }
      const budget = options?.contextBudget;
      if (budget && budget.inputTokens + budget.outputTokens + inputTokens + outputTokens > budget.limits.maxExecutionTokens) {
        stop(new AgentRunStopped('token_budget',
          `COPILOT_TOKEN_BUDGET: observed SDK usage exceeded execution allowance (${budget.inputTokens + budget.outputTokens + inputTokens + outputTokens}/${budget.limits.maxExecutionTokens})`));
      }
    }));
    const abortSession = () => { void session.abort().catch(() => undefined); };
    controller.signal.addEventListener('abort', abortSession, { once: true });

    let result: StreamAccumulation | undefined;
    try {
      if (options?.signal?.aborted) abort();
      if (controller.signal.aborted) throw new Error('Request aborted');
      touch();
      const response = await Promise.race([
        session.sendAndWait({ prompt }, wallClockMs),
        stopped,
      ]);
      if (!response) throw new Error('No response from GitHub Copilot');
      result = {
        choices: [{
          message: { role: 'assistant', content: response.data.content || null },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          provider: 'copilot',
          actual_model_id: actualModelId,
          ai_units: aiUnits,
          billing_multiplier: billingMultiplier,
          cost_type: 'subscription',
          cost_usd: null,
          input_tokens_observed: inputTokensObserved,
          output_tokens_observed: outputTokensObserved,
          ai_units_observed: aiUnitsObserved,
        },
      };
      return result;
    } catch (err) {
      if (err && typeof err === 'object') attachFailedRequestUsage(err, {
        prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens,
        provider: 'copilot', actual_model_id: actualModelId,
        ai_units: aiUnits, billing_multiplier: billingMultiplier,
        cost_type: 'subscription', cost_usd: null,
        input_tokens_observed: inputTokensObserved, output_tokens_observed: outputTokensObserved,
        ai_units_observed: aiUnitsObserved,
      });
      stop(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (wallTimer) clearTimeout(wallTimer);
      controller.signal.removeEventListener('abort', abortSession);
      // Prevent late callbacks from publishing output or starting more tools.
      if (!controller.signal.aborted) controller.abort();
      options?.signal?.removeEventListener('abort', abort);
      unsubscribeDelta?.();
      unsubscribeUsage();
      if (!(await disconnectBounded(session))) {
        if (result) result.usage.session_cleanup_confirmed = false;
        logger.warn('Copilot session cleanup was not confirmed; its continuity reference remains pending');
      }
    }
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.startPromise = undefined;
    if (!client) return;
    try {
      const errors = await client.stop();
      if (errors.length) {
        logger.warn({ errors: errors.map(error => error.message) }, 'Copilot SDK stopped with errors');
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'failed to stop Copilot SDK');
    }
  }

  private async getClient(): Promise<CopilotClientLike> {
    if (!this.client) {
      this.client = this.clientFactory({
        mode: 'empty',
        baseDirectory: this.options.baseDirectory,
        useLoggedInUser: true,
        logLevel: 'error',
        cliPath: this.options.cliPath,
      });
    }
    if (!this.startPromise) this.startPromise = this.client.start();
    await this.startPromise;
    return this.client;
  }

  private toCopilotTools(
    tools: unknown[] | undefined,
    onToolCall: ((toolCall: CopilotToolCall) => Promise<string>) | undefined,
  ): NonNullable<Parameters<CopilotClientLike['createSession']>[0]['tools']> {
    if (!tools?.length || !onToolCall) return [];
    return tools.flatMap((tool: any) => {
      const definition = tool?.type === 'function' ? tool.function : undefined;
      if (!definition?.name || typeof definition.name !== 'string') return [];
      return [{
        name: definition.name,
        description: typeof definition.description === 'string' ? definition.description : undefined,
        parameters: definition.parameters && typeof definition.parameters === 'object' ? definition.parameters : undefined,
        // The SDK's tool-search built-in remains denied in empty mode, so
        // server-approved tools must be eagerly visible to the model.
        defer: 'never' as const,
        // Myrmecia already enforces registry permissions, argument schemas,
        // workspace confinement, guardian checks and audit logging. Letting
        // the SDK ask for another permission leaves headless custom-tool
        // requests pending and returns "Permission denied" to the model.
        skipPermission: true,
        handler: async (args: unknown, invocation: { toolCallId: string; toolName: string }) => onToolCall({
          id: invocation.toolCallId,
          function: {
            name: invocation.toolName,
            arguments: JSON.stringify(args ?? {}),
          },
        }),
      }];
    });
  }
}
