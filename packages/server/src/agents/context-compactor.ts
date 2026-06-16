/**
 * In-loop context compaction ("auto-compact").
 *
 * Agent tool-calling loops re-send the whole conversation every turn, so a long
 * run grows token usage ~O(N²) and eventually trips the execution token budget
 * (or the model's context window). Before a model call we summarize the older
 * middle of the conversation while keeping the system prompt, the initial task,
 * and the most recent turns verbatim — bounding per-call context to ~O(1) and
 * total usage to ~O(N).
 *
 * The compaction cuts on clean turn boundaries so no assistant `tool_calls`
 * message is ever separated from its `tool` results (which the OpenAI API
 * rejects).
 */
import type OpenAI from 'openai';
import { estimateTokenCount } from './runtime-limits.js';

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const trunc = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);

function messageText(m: any): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

function serialize(m: any): string {
  let s = messageText(m);
  if (m.tool_calls) s += ' ' + JSON.stringify(m.tool_calls);
  if (m.role === 'tool') s += ' ' + String(m.content ?? '');
  return s;
}

export function estimateMessagesTokens(messages: Msg[]): number {
  let total = 0;
  for (const m of messages) total += estimateTokenCount(serialize(m)) + 4; // ~per-message overhead
  return total;
}

function summarizeMiddle(middle: Msg[]): string {
  const lines: string[] = [];
  for (const m of middle as any[]) {
    if (m.role === 'assistant') {
      const text = messageText(m).trim();
      if (text) lines.push('• ' + trunc(text, 240));
      for (const tc of m.tool_calls || []) {
        lines.push(`  ↳ ${tc.function?.name || 'tool'}(${trunc(String(tc.function?.arguments || ''), 80)})`);
      }
    } else if (m.role === 'tool') {
      lines.push(`    ⤷ result: ${trunc(String(m.content ?? ''), 160)}`);
    } else if (m.role === 'user') {
      lines.push('› ' + trunc(messageText(m), 160));
    }
  }
  let body = lines.join('\n');
  if (body.length > 4000) body = body.slice(0, 4000) + '\n…(truncated)';
  return `[Auto-compacted earlier context to fit the window. Summary of prior steps and tool results:]\n${body}`;
}

export interface CompactResult {
  messages: Msg[];
  compacted: boolean;
  before: number;
  after: number;
}

/**
 * Return a (possibly) compacted copy of `messages`. No-op unless the estimated
 * size exceeds `triggerRatio * maxContextTokens` and there is a compressible
 * middle section.
 */
export function compactMessages(
  messages: Msg[],
  maxContextTokens: number,
  opts: { keepRecent?: number; triggerRatio?: number } = {},
): CompactResult {
  const keepRecent = opts.keepRecent ?? 6;
  const trigger = (opts.triggerRatio ?? 0.5) * maxContextTokens;
  const before = estimateMessagesTokens(messages);
  if (before <= trigger || messages.length <= keepRecent + 3) {
    return { messages, compacted: false, before, after: before };
  }

  // head: leading system message(s) + the first user (the task).
  let headEnd = 0;
  while (headEnd < messages.length && (messages[headEnd] as any).role === 'system') headEnd++;
  if (headEnd < messages.length && (messages[headEnd] as any).role === 'user') headEnd++;
  const head = messages.slice(0, headEnd);

  // tail: the most recent messages, advanced past any leading orphan tool
  // results so we never start mid-turn.
  let tailStart = Math.max(headEnd, messages.length - keepRecent);
  while (tailStart < messages.length && (messages[tailStart] as any).role === 'tool') tailStart++;
  const middle = messages.slice(headEnd, tailStart);
  if (middle.length === 0) return { messages, compacted: false, before, after: before };
  const tail = messages.slice(tailStart);

  const summary = { role: 'user', content: summarizeMiddle(middle) } as Msg;
  const compacted = [...head, summary, ...tail];
  return { messages: compacted, compacted: true, before, after: estimateMessagesTokens(compacted) };
}
