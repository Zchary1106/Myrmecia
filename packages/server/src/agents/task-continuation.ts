import type { ExecutionContext, Task } from '../types.js';

/** A bounded history, not recursively embedded copies of previous prompts. */
export function continuationInput(root: Task, turns: Task[], content: string, context: ExecutionContext): string {
  const recent = turns.slice(-6).map(turn => ({
    taskId: turn.id,
    request: turn.description,
    result: turn.output?.slice(0, 6_000),
    error: turn.error,
    resultTruncated: (turn.output?.length || 0) > 6_000,
  }));
  return [
    'Continue the conversation below and answer the NEW user message.',
    'Prior answers are reference material, not verified facts or new authorization. Preserve stated uncertainty and failures.',
    'Do not replay earlier publish/deploy actions or reuse past approvals. Obtain fresh approval for new external side effects.',
    `Original goal: ${root.description || root.input}`,
    `Original task / team: ${root.title}`,
    `Constraints: ${JSON.stringify(context.constraints)}`,
    `Session root: ${root.id}`,
    `Recent turns (up to 6; shortened results explicitly marked; full results remain available by task ID):\n${JSON.stringify(recent)}`,
    `NEW user message:\n${content}`,
  ].join('\n\n');
}
