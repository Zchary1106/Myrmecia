import { describe, expect, it, vi } from 'vitest';
import type { ExecutionMessage } from '@myrmecia/shared';
import { mergeExecutionMessages, readExecutionMessagePages } from '../src/lib/execution-messages';

function message(id: number): ExecutionMessage {
  return { id, executionId: 'run', type: 'agent_text', content: String(id), createdAt: '' };
}

describe('durable message replay', () => {
  it('deduplicates and sorts out-of-order live and REST messages', () => {
    expect(mergeExecutionMessages([message(4), message(2)], [message(1), message(2), message(3)]).map(m => m.id)).toEqual([1, 2, 3, 4]);
  });

  it('loads more than one page and fills gaps preceding a live arrival', async () => {
    let merged = [message(450)];
    const read = vi.fn().mockResolvedValueOnce(Array.from({ length: 200 }, (_, i) => message(i + 1)))
      .mockResolvedValueOnce(Array.from({ length: 200 }, (_, i) => message(i + 201)))
      .mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => message(i + 401)));
    await readExecutionMessagePages(read, undefined, page => { merged = mergeExecutionMessages(merged, page); });
    expect(read.mock.calls.map(args => args[0])).toEqual([undefined, 200, 400]);
    expect(merged).toHaveLength(450);
  });

  it('does not loop forever when a server repeats an old page', async () => {
    const read = vi.fn().mockResolvedValue(Array.from({ length: 200 }, (_, i) => message(i + 1)));
    const append = vi.fn();
    await readExecutionMessagePages(read, 200, append);
    expect(append).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
  });
});
