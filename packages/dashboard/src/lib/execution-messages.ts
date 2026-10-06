import type { ExecutionMessage } from '@myrmecia/shared';

export function mergeExecutionMessages(existing: ExecutionMessage[], incoming: ExecutionMessage[]): ExecutionMessage[] {
  return [...new Map([...existing, ...incoming].map(message => [message.id, message])).values()]
    .sort((a, b) => a.id - b.id);
}

/** The REST cursor is independent of live WS messages: live arrivals can skip gaps. */
export async function readExecutionMessagePages(
  read: (afterId?: number) => Promise<ExecutionMessage[]>,
  cursor: number | undefined,
  append: (messages: ExecutionMessage[], cursor: number) => void,
): Promise<void> {
  for (;;) {
    const page = await read(cursor);
    if (!page.length) return;
    const nextCursor = Math.max(...page.map(message => message.id));
    if (!Number.isSafeInteger(nextCursor) || nextCursor <= (cursor ?? 0)) return;
    append(page, nextCursor);
    cursor = nextCursor;
    if (page.length < 200) return;
  }
}
