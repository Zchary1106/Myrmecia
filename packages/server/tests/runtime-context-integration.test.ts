import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import { buildRequestContext, estimateMessagesTokens } from '../src/agents/context-compactor.js';
import { collectContextFacts, recordContextSummary } from '../src/agents/context-state.js';
import { persistExecutionContext } from '../src/agents/execution-context.js';
import { closeDb } from '../src/db/database.js';
import { createTask } from '../src/db/models/task.js';
import { createExecution } from '../src/db/models/execution.js';
import { createToolExecution, completeToolExecution } from '../src/tools/tool-execution.js';
import { resolveAgentRuntimeLimits } from '../src/agents/runtime-limits.js';
import { createAgent } from '../src/db/models/agent.js';
import { syncBuiltinTools } from '../src/tools/tool-registry.js';

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
const budget = { maxContextTokens: 3000, remainingExecutionTokens: 8000, reservedOutputTokens: 200, toolSchemaTokens: 100 };
const original = { DB_PATH: process.env.DB_PATH, MYRMECIA_RUNTIME_V2: process.env.MYRMECIA_RUNTIME_V2 };
beforeEach(() => { process.env.DB_PATH = ':memory:'; process.env.MYRMECIA_RUNTIME_V2 = 'true'; });
afterEach(() => {
  closeDb(); vi.restoreAllMocks();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('layered context at actual request boundaries', () => {
  it('preserves user constraints, an open question and failure evidence across a 50-turn history', () => {
    const messages: Message[] = [{ role: 'system', content: 'Respect tool/data boundaries.' }, { role: 'user', content: 'Build the requested feature.' }];
    for (let turn = 0; turn < 50; turn++) {
      if (turn === 2) messages.push({ role: 'user', content: 'Do not change public API. Which provider supports resume?' });
      messages.push({ role: 'assistant', content: `Step ${turn}: inspected existing evidence. ${'record '.repeat(35)}`,
        tool_calls: [{ id: `read-${turn}`, type: 'function', function: { name: 'file_read', arguments: '{}' } }] });
      messages.push({ role: 'tool', tool_call_id: `read-${turn}`,
        content: turn === 4 ? 'Error: test command exited 1; missing response evidence.'
          : `Read evidence ${turn}. ${'data '.repeat(35)}` });
    }
    const first = buildRequestContext(messages, budget);
    expect(first.compacted).toBe(true);
    const text = JSON.stringify(first.messages);
    expect(text).toContain('Do not change public API');
    expect(text).toContain('Which provider supports resume?');
    expect(text).toContain('test command exited 1');
    expect(first.messages.filter(message => message.role === 'user').some(message => String(message.content).includes('test command exited'))).toBe(false);
    expect(first.after + budget.reservedOutputTokens + budget.toolSchemaTokens).toBeLessThanOrEqual(budget.maxContextTokens);
    expect(buildRequestContext(messages, budget).messages).toEqual(first.messages);
    const second = buildRequestContext([...first.messages, { role: 'assistant', content: 'Later progress.' }], {
      ...budget, protectedFacts: first.contextFacts.filter(fact => ['goal', 'constraint', 'open_question', 'failure_evidence'].includes(fact.kind)),
    });
    expect(JSON.stringify(second.messages)).toContain('test command exited 1');
    expect(JSON.stringify(second.messages)).toContain('Do not change public API');
  });

  it('keeps tool-call/results paired when the recent cutoff falls inside a tool group', () => {
    const messages: Message[] = [{ role: 'system', content: 'system' }, { role: 'user', content: 'goal' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'read', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'read', arguments: '{}' } },
      ] }, { role: 'tool', tool_call_id: 'a', content: 'A' }, { role: 'tool', tool_call_id: 'b', content: 'B' },
      { role: 'assistant', content: 'result' }];
    const result = buildRequestContext(messages, { ...budget, keepRecent: 3 });
    expect(result.messages).toEqual(messages);
    expect(estimateMessagesTokens(result.messages)).toBe(result.after);
  });

  it('stops rather than silently dropping an oversized user constraint', () => {
    const messages: Message[] = [{ role: 'system', content: 'system' }, { role: 'user', content: 'goal' }];
    expect(() => buildRequestContext(messages, {
      ...budget, maxContextTokens: 1000,
      protectedFacts: [{ id: 'constraint', kind: 'constraint', content: 'Constraint '.repeat(1000) }],
    })).toThrow('CONTEXT_BUDGET_EXCEEDED');
  });

  it('counts tool schemas, output reserve and remaining cumulative budget independently', () => {
    const messages: Message[] = [{ role: 'user', content: 'hello' }];
    expect(() => buildRequestContext(messages, {
      maxContextTokens: 10000, remainingExecutionTokens: 500, reservedOutputTokens: 300, toolSchemaTokens: 250,
    })).toThrow('CONTEXT_BUDGET_EXCEEDED');
    const result = buildRequestContext(messages, {
      maxContextTokens: 1000, remainingExecutionTokens: 10000, reservedOutputTokens: 200, toolSchemaTokens: 100,
    });
    expect(result.maxInputTokens).toBe(700);
  });

  it('persists fact provenance with summary versions and restores missing protected evidence', () => {
    const task = createTask({ title: 'goal', description: 'Approved goal', input: 'Inspect.', mode: 'direct' });
    const execution = createExecution({ taskId: task.id, agentDefId: 'fixture' });
    persistExecutionContext(task, { constraints: ['Preserve existing edits.'] });
    recordContextSummary({ task, executionId: execution.id, version: 1, summary: '[Auto-compacted] Evidence summary.',
      facts: [{ id: 'failure', kind: 'failure_evidence', content: 'Error: deterministic verifier exited 1' }] });
    const state = collectContextFacts(task, [{ role: 'user', content: 'Next request.' }]);
    expect(state.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'goal', content: 'Approved goal' }),
      expect.objectContaining({ kind: 'constraint', content: 'Preserve existing edits.' }),
      expect.objectContaining({ kind: 'failure_evidence', content: 'Error: deterministic verifier exited 1' }),
    ]));
  });

  it('does not claim a requested or failed file write modified a file', () => {
    syncBuiltinTools();
    const task = createTask({ title: 'goal', description: '', input: 'Inspect.', mode: 'direct' });
    const requested: Message[] = [{ role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function',
      function: { name: 'file_write', arguments: '{"path":"not-written.txt"}' } }] }];
    expect(collectContextFacts(task, requested).modifiedFiles).toEqual([]);
    const failed = createToolExecution({ taskId: task.id, toolId: 'file_write', input: { path: 'not-written.txt' } });
    completeToolExecution(failed.id, { status: 'failed', output: 'denied', error: 'denied', durationMs: 1 });
    expect(collectContextFacts(task, requested).modifiedFiles).toEqual([]);
    const op = createToolExecution({ taskId: task.id, toolId: 'file_write', input: { path: 'written.txt' } });
    completeToolExecution(op.id, { status: 'done', output: 'wrote', durationMs: 1 });
    expect(collectContextFacts(task, requested).modifiedFiles).toEqual(['written.txt']);
  });

  it('does not use the requested context window as the whole-task token allowance', () => {
    const agent = createAgent({ id: 'budget-agent', name: 'Budget', role: 'dev' });
    const limits = resolveAgentRuntimeLimits(agent, undefined, 4096);
    expect(limits.maxContextTokens).toBe(4096);
    expect(limits.maxExecutionTokens).toBeGreaterThan(4096);
  });
});
