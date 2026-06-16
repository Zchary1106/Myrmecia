import { describe, expect, it } from 'vitest';
import { compactMessages, estimateMessagesTokens } from '../src/agents/context-compactor.js';

type Msg = any;

function bigText(n: number): string {
  return 'x'.repeat(n);
}

describe('context compactor (auto-compact)', () => {
  it('is a no-op when context is small', () => {
    const messages: Msg[] = [
      { role: 'system', content: 'you are dev' },
      { role: 'user', content: 'do a thing' },
      { role: 'assistant', content: 'done' },
    ];
    const r = compactMessages(messages, 120_000);
    expect(r.compacted).toBe(false);
    expect(r.messages).toBe(messages);
  });

  it('compacts a long conversation and shrinks the token estimate', () => {
    const messages: Msg[] = [
      { role: 'system', content: 'you are dev' },
      { role: 'user', content: 'implement feature X' },
    ];
    // 20 turns of assistant tool_calls + large tool results
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'assistant', content: `step ${i}`, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'file_read', arguments: `{"path":"f${i}.ts"}` } }] });
      messages.push({ role: 'tool', tool_call_id: `c${i}`, content: bigText(8000) });
    }
    const before = estimateMessagesTokens(messages);
    const r = compactMessages(messages, 40_000, { keepRecent: 6, triggerRatio: 0.5 });
    expect(r.compacted).toBe(true);
    expect(r.after).toBeLessThan(before);
    // keeps the system prompt + the initial task
    expect((r.messages[0] as Msg).role).toBe('system');
    expect((r.messages[1] as Msg).role).toBe('user');
    expect((r.messages[1] as Msg).content).toContain('implement feature X');
    // inserts exactly one compaction summary
    const summaries = r.messages.filter((m: Msg) => typeof m.content === 'string' && m.content.includes('Auto-compacted'));
    expect(summaries.length).toBe(1);
  });

  it('never leaves an orphan tool result at the tail boundary', () => {
    const messages: Msg[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ];
    for (let i = 0; i < 15; i++) {
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 't', arguments: '{}' } }] });
      messages.push({ role: 'tool', tool_call_id: `c${i}`, content: bigText(6000) });
    }
    const r = compactMessages(messages, 30_000, { keepRecent: 5, triggerRatio: 0.4 });
    expect(r.compacted).toBe(true);
    // The message right after the summary must NOT be a bare tool result
    const summaryIdx = r.messages.findIndex((m: Msg) => typeof m.content === 'string' && m.content.includes('Auto-compacted'));
    const afterSummary = r.messages[summaryIdx + 1] as Msg;
    expect(afterSummary?.role).not.toBe('tool');
    // Every tool message in the result has a preceding assistant with tool_calls
    for (let i = 0; i < r.messages.length; i++) {
      if ((r.messages[i] as Msg).role === 'tool') {
        // find a preceding assistant tool_calls in the kept tail
        let j = i - 1;
        while (j >= 0 && (r.messages[j] as Msg).role === 'tool') j--;
        expect((r.messages[j] as Msg).role).toBe('assistant');
      }
    }
  });
});
