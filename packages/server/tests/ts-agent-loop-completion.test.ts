import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TsAgentLoop } from '../src/agents/ts-agent-loop.js';
import { closeDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createTask } from '../src/db/models/task.js';
import { createExecution, listExecutions, getExecution, listExecutionMessages } from '../src/db/models/execution.js';
import { createRunTrace, createTraceSpan } from '../src/db/models/trace.js';
import { llmCache } from '../src/cache/llm-cache.js';
import { syncBuiltinModels } from '../src/models/model-registry.js';
import { syncBuiltinTools } from '../src/tools/tool-registry.js';
import { ExecutionMiddlewareChain } from '../src/agents/execution-middleware.js';
import { getRuntimeLimits } from '../src/agents/runtime-limits.js';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as toolExecutions from '../src/tools/tool-execution.js';
import { getDb } from '../src/db/database.js';

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
  it('bypasses code-writing structured steps and skill matching for an explicit verification request', async () => {
    const skill = { skill: { id: 'dev' }, version: { id: 'dev_v1', content: `---
executor: step-driven
steps:
  - name: implement
    instruction: "Rewrite the system"
    tools: [file_write]
    maxTurns: 3
---
Implement the full system.` }, source: 'skillPath' } as NonNullable<Parameters<TsAgentLoop['execute']>[7]>;
    model.complete.mockImplementation(async (_id, params) => {
      expect(JSON.stringify(params.messages)).toContain('Host development verification protocol');
      return response('Review findings, no implementation changes.');
    });
    await expect(run('Only review the complete system', skill)).resolves.toMatchObject({
      output: 'Review findings, no implementation changes.', stopReason: 'completed',
    });
    expect(model.matchSkill).not.toHaveBeenCalled();
    expect(model.complete).toHaveBeenCalledOnce();
  });

  it('returns development warnings to native SDK callbacks and stops varying reads within the first model request', async () => {
    syncBuiltinTools();
    const root = mkdtempSync(join(tmpdir(), 'myrmecia-native-exploration-'));
    writeFileSync(join(root, 'app.ts'), 'export const task = true;\n'.repeat(80));
    const agent = createAgent({ id: 'exploration-receipt-agent', name: 'Fixture', role: 'dev',
      allowedTools: ['file_read'], config: { maxTurns: 1 } });
    const task = createTask({ title: 'Fix the board filter', description: '', input: 'Fix the board filter', mode: 'direct',
      workdir: root, workspacePath: root });
    const execution = createExecution({ taskId: task.id, agentDefId: agent.id });
    const trace = createRunTrace({ taskId: task.id, executionId: execution.id, agentId: agent.id });
    const span = createTraceSpan({ traceId: trace.id, type: 'agent.start', name: 'fixture' });
    const outputs: string[] = [];
    model.complete.mockImplementation(async (_id, _params, options) => {
      for (let index = 0; index < 13; index++) {
        outputs.push(await options.onToolCall({ id: `read-${index}`, function: { name: 'file_read',
          arguments: JSON.stringify({ path: 'app.ts', offset: index * 64, maxChars: 64 }) } }));
      }
      return response('must not be reached');
    });
    await expect(new TsAgentLoop().execute(agent, task, new AbortController(), execution.id, trace.id, span.id,
      { toolUseCount: 0, latestInputTokens: 0, cumulativeOutputTokens: 0, recentActivities: [] }, undefined,
      new ExecutionMiddlewareChain(agent, task, execution.id, getRuntimeLimits())))
      .rejects.toThrow('DEVELOPMENT_EXPLORATION_LIMIT');
    expect(model.complete).toHaveBeenCalledOnce();
    expect(outputs).toHaveLength(12);
    expect(JSON.parse(outputs[5])).toMatchObject({
      kind: 'workspace_file_page', offset: 320, sha256: expect.any(String),
      hostDevelopmentGuidance: expect.stringContaining('6/12'),
    });
    const receipts = listExecutionMessages(execution.id).filter(message => message.type === 'tool_result');
    expect(receipts).toHaveLength(13);
    expect(receipts[5].content).not.toContain('hostDevelopmentGuidance');
    expect(receipts.at(-1)?.content).toContain('DEVELOPMENT_EXPLORATION_LIMIT');
  });

  it('does not let native SDK writes bypass the system design gate', async () => {
    syncBuiltinTools();
    const root = mkdtempSync(join(tmpdir(), 'myrmecia-native-design-'));
    const agent = createAgent({ id: 'design-receipt-agent', name: 'Fixture', role: 'dev',
      allowedTools: ['file_write'], config: { maxTurns: 1 } });
    const task = createTask({ title: 'Build a complete system', description: '', input: 'Build a complete system', mode: 'direct',
      workdir: root, workspacePath: root });
    const execution = createExecution({ taskId: task.id, agentDefId: agent.id });
    const trace = createRunTrace({ taskId: task.id, executionId: execution.id, agentId: agent.id });
    const span = createTraceSpan({ traceId: trace.id, type: 'agent.start', name: 'fixture' });
    model.complete.mockImplementation(async (_id, _params, options) => {
      for (let index = 0; index < 3; index++) {
        await options.onToolCall({ id: `write-${index}`, function: { name: 'file_write',
          arguments: JSON.stringify({ path: 'app.ts', content: `export const task = ${index};` }) } });
      }
      return response('must not be reached');
    });
    await expect(new TsAgentLoop().execute(agent, task, new AbortController(), execution.id, trace.id, span.id,
      { toolUseCount: 0, latestInputTokens: 0, cumulativeOutputTokens: 0, recentActivities: [] }, undefined,
      new ExecutionMiddlewareChain(agent, task, execution.id, getRuntimeLimits())))
      .rejects.toThrow('DEVELOPMENT_STAGE_SCOPE');
    expect(existsSync(join(root, 'app.ts'))).toBe(false);
    expect(listExecutionMessages(execution.id).filter(message => message.type === 'tool_result')).toHaveLength(3);
  });

  it('records a pre-dispatch tool exception and releases its unspent reservation', async () => {
    syncBuiltinTools();
    const root = mkdtempSync(join(tmpdir(), 'myrmecia-early-tool-failure-'));
    writeFileSync(join(root, 'note.md'), 'original');
    const agent = createAgent({ id: 'early-tool-agent', name: 'Fixture', role: 'dev',
      allowedTools: ['file_read'], config: { maxTurns: 1 } });
    const task = createTask({ title: 'Read fixture', description: '', input: 'Read fixture', mode: 'direct',
      workdir: root, workspacePath: root });
    const execution = createExecution({ taskId: task.id, agentDefId: agent.id });
    const trace = createRunTrace({ taskId: task.id, executionId: execution.id, agentId: agent.id });
    const span = createTraceSpan({ traceId: trace.id, type: 'agent.start', name: 'fixture' });
    vi.spyOn(toolExecutions, 'createToolExecution').mockImplementation(() => { throw new Error('FIXTURE_PRE_DISPATCH_GATE'); });
    model.complete.mockImplementation(async (_id, _params, options) => {
      await options.onToolCall({ id: 'early', function: { name: 'file_read', arguments: '{"path":"note.md"}' } });
      return response('must not finish');
    });
    await expect(new TsAgentLoop().execute(agent, task, new AbortController(), execution.id, trace.id, span.id,
      { toolUseCount: 0, latestInputTokens: 0, cumulativeOutputTokens: 0, recentActivities: [] }, undefined,
      new ExecutionMiddlewareChain(agent, task, execution.id, getRuntimeLimits())))
      .rejects.toThrow('FIXTURE_PRE_DISPATCH_GATE');
    expect(listExecutionMessages(execution.id).filter(m => ['tool_use', 'tool_result'].includes(m.type)))
      .toHaveLength(2);
    expect(getDb().get('SELECT status FROM agent_budget_reservations WHERE reservation_key=?', `${execution.id}:tool:early`))
      .toEqual({ status: 'released' });
    expect(readFileSync(join(root, 'note.md'), 'utf8')).toBe('original');
  });
  it('records refused tool call/result pairs and stops the inner loop without changing an unread file', async () => {
    syncBuiltinTools();
    const root = mkdtempSync(join(tmpdir(), 'myrmecia-refused-receipts-'));
    writeFileSync(join(root, 'note.md'), 'before');
    const agent = createAgent({ id: 'refusal-receipt-agent', name: 'Fixture', role: 'dev',
      allowedTools: ['file_read', 'apply_patch'], config: { maxTurns: 1 } });
    const task = createTask({ title: 'Repair code', description: '', input: 'Repair code', mode: 'direct',
      workdir: root, workspacePath: root });
    const execution = createExecution({ taskId: task.id, agentDefId: agent.id });
    const trace = createRunTrace({ taskId: task.id, executionId: execution.id, agentId: agent.id });
    const span = createTraceSpan({ traceId: trace.id, type: 'agent.start', name: 'fixture' });
    model.complete.mockImplementation(async (_id, _params, options) => {
      for (let index = 0; index < 3; index++) {
        await options.onToolCall({ id: `refused-${index}`, function: { name: 'apply_patch',
          arguments: JSON.stringify({ path: 'note.md', old_str: 'before', new_str: `v${index}` }) } });
      }
      return response('must not be reached');
    });
    await expect(new TsAgentLoop().execute(agent, task, new AbortController(), execution.id, trace.id, span.id,
      { toolUseCount: 0, latestInputTokens: 0, cumulativeOutputTokens: 0, recentActivities: [] }, undefined,
      new ExecutionMiddlewareChain(agent, task, execution.id, getRuntimeLimits())))
      .rejects.toMatchObject({ reason: 'tool_unavailable' });
    const messages = listExecutionMessages(execution.id);
    expect(messages.filter(message => message.type === 'tool_use')).toHaveLength(3);
    expect(messages.filter(message => message.type === 'tool_result')).toHaveLength(3);
    expect(messages.find(message => message.type === 'tool_result')?.content).toContain('file_read');
    expect(readFileSync(join(root, 'note.md'), 'utf8')).toBe('before');
  });
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
