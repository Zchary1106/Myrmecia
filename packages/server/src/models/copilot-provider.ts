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

export interface CopilotToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface CopilotProviderOptions {
  /** Optional server-local Copilot home. Defaults to the CLI's normal home. */
  baseDirectory?: string;
  /** Optional server-local CLI/runtime path. Never sent to clients. */
  cliPath?: string;
}

export interface CopilotSessionLike {
  sendAndWait(options: { prompt: string }, timeout?: number): Promise<{ data: { content: string } } | undefined>;
  disconnect(): Promise<void>;
  abort(): Promise<void>;
  on(event: 'assistant.message_delta', handler: (event: { data: { deltaContent: string } }) => void): () => void;
}

export interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  listModels?(): Promise<ModelInfo[]>;
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
    },
  ): Promise<StreamAccumulation> {
    if (params.tools?.length && !options?.onToolCall) {
      throw new Error('GitHub Copilot provider requires a server-side tool handler for OpenAI function tools.');
    }
    if (options?.signal?.aborted) throw new Error('Request aborted');

    const client = await this.getClient();
    const { system, prompt } = formatPrompt(params.messages);
    const tools = this.toCopilotTools(params.tools, options?.onToolCall);
    const session = await client.createSession({
      model: params.model,
      // `empty` mode requires an explicit allow-list. Only registered custom
      // tools are allowed; built-in Copilot tools stay unavailable.
      availableTools: tools.length ? ['custom:*'] : [],
      systemMessage: { mode: 'append', content: system },
      streaming: Boolean(options?.onDelta),
      ...(tools.length ? { tools } : {}),
    });

    const unsubscribe = options?.onDelta
      ? session.on('assistant.message_delta', event => {
          if (event.data.deltaContent) options.onDelta!(event.data.deltaContent);
        })
      : undefined;
    const abort = () => { void session.abort().catch(() => undefined); };
    options?.signal?.addEventListener('abort', abort, { once: true });

    try {
      const response = await session.sendAndWait(
        { prompt },
        options?.timeoutMs ?? 120_000,
      );
      if (!response) throw new Error('No response from GitHub Copilot');
      return {
        choices: [{
          message: { role: 'assistant', content: response.data.content || null },
          finish_reason: 'stop',
        }],
        // The SDK's final message event does not provide OpenAI usage fields.
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    } finally {
      options?.signal?.removeEventListener('abort', abort);
      unsubscribe?.();
      await session.disconnect().catch(err => {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'failed to disconnect Copilot session');
      });
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
