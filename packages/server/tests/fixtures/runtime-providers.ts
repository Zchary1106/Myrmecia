import type { CopilotClientLike, CopilotSessionLike } from '../../src/models/copilot-provider.js';

export interface FixtureCompletion {
  choices: Array<{
    message: { role: 'assistant'; content: string; tool_calls?: Array<{
      id: string; type: 'function'; function: { name: string; arguments: string };
    }> };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

export function fixtureCompletion(content: string, finishReason = 'stop', tools?: FixtureCompletion['choices'][number]['message']['tool_calls']): FixtureCompletion {
  return {
    choices: [{ message: { role: 'assistant', content, ...(tools ? { tool_calls: tools } : {}) }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  };
}

type ScriptStep = FixtureCompletion | Error | ((params: any, options: any) => FixtureCompletion | Promise<FixtureCompletion>);

/** Only the transport is scripted; callers must run a production loop/provider. */
export function createScriptedProvider(script: ScriptStep[]) {
  const pending = [...script];
  const requests: any[] = [];
  return {
    requests,
    remaining: () => pending.length,
    async completeForModel(_model: string, params: any, options: any = {}) {
      if (options.signal?.aborted) throw new Error('Request aborted');
      requests.push(structuredClone(params));
      const next = pending.shift();
      if (!next) throw new Error('FIXTURE_SCRIPT_EXHAUSTED');
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(params, options) : next;
    },
  };
}

export type CopilotScriptAction =
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  | { type: 'usage'; input: number; output: number }
  | { type: 'result'; text: string }
  | { type: 'error'; error: Error }
  | { type: 'wait' };

export function createScriptedCopilot(script: CopilotScriptAction[]) {
  type Config = Parameters<CopilotClientLike['createSession']>[0];
  let config: Config;
  const callbacks = new Map<string, (event: any) => void>();
  const observed = { requests: 0, aborts: 0, disconnects: 0, toolResults: [] as string[] };
  const session: CopilotSessionLike = {
    on(event, handler) { callbacks.set(event, handler); return () => { callbacks.delete(event); }; },
    async abort() { observed.aborts++; },
    async disconnect() { observed.disconnects++; },
    async sendAndWait() {
      observed.requests++;
      for (const [index, action] of script.entries()) {
        if (action.type === 'delta') callbacks.get('assistant.message_delta')?.({ data: { deltaContent: action.text } });
        if (action.type === 'usage') callbacks.get('assistant.usage')?.({ data: { inputTokens: action.input, outputTokens: action.output } });
        if (action.type === 'tool') {
          const tool = config.tools?.find(tool => tool.name === action.name);
          if (!tool) throw new Error(`Fixture tool missing: ${action.name}`);
          observed.toolResults.push(await tool.handler(action.input, { toolName: action.name, toolCallId: `sdk-${index}` }));
        }
        if (action.type === 'error') throw action.error;
        if (action.type === 'wait') return new Promise<never>(() => undefined);
        if (action.type === 'result') return { data: { content: action.text } };
      }
      throw new Error('FIXTURE_SCRIPT_EXHAUSTED');
    },
  };
  const client: CopilotClientLike = {
    async start() {}, async stop() { return []; },
    async createSession(value) { config = value; return session; },
  };
  return { client, session, observed, callbacks, config: () => config };
}
