import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TsAgentLoop } from '../src/agents/ts-agent-loop.js';
import { closeDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createTask } from '../src/db/models/task.js';
import { createExecution, listExecutions, getExecution } from '../src/db/models/execution.js';
import { createRunTrace, createTraceSpan } from '../src/db/models/trace.js';
import { llmCache } from '../src/cache/llm-cache.js';
import { syncBuiltinModels } from '../src/models/model-registry.js';

const model = vi.hoisted(() => ({ complete: vi.fn(), matchSkill: vi.fn(async () => ({ skillId: null, confidence: 0 })) }));
vi.mock('../src/models/gateway.js', () => ({
  getModelGateway: () => ({ completeForModel: model.complete, supportsTools: () => true, providerFor: () => 'openai' }),
}));
vi.mock('../src/skills/skill-matcher.js', () => ({ matchSkillForTask: model.matchSkill }));

beforeEach(() => { process.env.DB_PATH = ':memory:'; model.complete.mockReset(); model.matchSkill.mockClear(); llmCache.clear(); syncBuiltinModels(); });
afterEach(() => { closeDb(); delete process.env.DB_PATH; vi.restoreAllMocks(); });
async function run(input = 'fixture', runtimeSkill?: Parameters<TsAgentLoop['execute']>[7]) {
  const agent = createAgent({ id: `loop-fixture-${crypto.randomUUID()}`, name: 'Fixture', role: 'dev', config: { maxTurns: 1 } });
  const task = createTask({ title: input, description: '', input, mode: 'direct' });
  const execution = createExecution({ taskId: task.id, agentDefId: agent.id });
  const trace = createRunTrace({ taskId: task.id, executionId: execution.id, agentId: agent.id });
  const span = createTraceSpan({ traceId: trace.id, type: 'agent.start', name: 'fixture' });
  return new TsAgentLoop().execute(agent, task, new AbortController(), execution.id, trace.id, span.id,
    { toolUseCount: 0, latestInputTokens: 0, cumulativeOutputTokens: 0, recentActivities: [] }, runtimeSkill);
}
const response = (content: string, finish_reason = 'stop', tool_calls?: unknown[]) => ({
  choices: [{ message: { role: 'assistant', content, tool_calls }, finish_reason }],
  usage: { prompt_tokens: 10, completion_tokens: 10 },
});

describe('real TS loop termination paths', () => {
  it('uses one bounded tool-free model request for greetings even with a default developer skill', async () => {
    model.complete.mockImplementation(async (_id, params, options) => {
      expect(params.tools).toBeUndefined();
      expect(options.timeoutMs).toBeLessThanOrEqual(60_000);
      expect(options.idleTimeoutMs).toBeLessThanOrEqual(30_000);
      const execution = listExecutions()[0];
      expect(execution.runState?.modelRequest).toMatchObject({ modelId: expect.any(String), startedAt: expect.any(String) });
      options.onDelta?.('Hello!');
      expect(getExecution(execution.id)?.runState?.modelRequest?.firstOutputAt).toEqual(expect.any(String));
      return response('Hello!');
    });
    const skill = { skill: { id: 'dev' }, version: { id: 'dev_v1', content: '# Developer\nRespond to the user.' }, source: 'skillPath' } as NonNullable<Parameters<TsAgentLoop['execute']>[7]>;
    await expect(run('hello', skill)).resolves.toMatchObject({ output: 'Hello!', stopReason: 'completed' });
    expect(model.complete).toHaveBeenCalledTimes(1);
    expect(model.matchSkill).not.toHaveBeenCalled();
    expect(listExecutions()[0].runState?.modelRequest).toBeUndefined();
  });
  it('clears persisted waiting state when the provider times out', async () => {
    model.complete.mockRejectedValue(new Error('EXECUTION_WALL_TIMEOUT: fixture'));
    await expect(run('hello')).rejects.toThrow('EXECUTION_WALL_TIMEOUT');
    expect(listExecutions()[0].runState?.modelRequest).toBeUndefined();
  });
  it('fails instead of returning success when the last turn still requests tools', async () => {
    model.complete.mockResolvedValue(response('I will keep working', 'tool_calls', [
      { id: 'unsupported', type: 'function', function: { name: 'not_allowed', arguments: '{}' } },
    ]));
    await expect(run()).rejects.toMatchObject({ reason: 'max_turns', partialOutput: 'I will keep working' });
  });
  it('does not accept truncated or empty model responses', async () => {
    model.complete.mockResolvedValue(response('incomplete', 'length'));
    await expect(run()).rejects.toMatchObject({ reason: 'model_truncated' });
    model.complete.mockResolvedValue(response(''));
    await expect(run()).rejects.toMatchObject({ reason: 'empty_output' });
  });
  it('returns an explicit input request as a readable question', async () => {
    model.complete.mockResolvedValue(response('{"kind":"myrmecia.request_input","question":"请提供文件"}'));
    await expect(run()).resolves.toMatchObject({ output: '请提供文件', stopReason: 'needs_input' });
  });
  it('returns normal Markdown without control-protocol formatting', async () => {
    model.complete.mockResolvedValue(response('## Result\n\nVerified fixture.'));
    await expect(run()).resolves.toMatchObject({ output: '## Result\n\nVerified fixture.', stopReason: 'completed' });
  });
});
