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


/**
 * A prompt-facing token budget. The output reserve is never spent on input,
 * so callers can keep model replies predictable across providers.
 */
export interface ContextBudgetContract {
  maxInputTokens: number;
  reservedOutputTokens: number;
  fixedTokens?: number;
  recentWindowTokens?: number;
}

export type ContextFactKind =
  | 'goal'
  | 'constraint'
  | 'open_question'
  | 'failure_evidence'
  | 'summary'
  | 'tool_output';

export interface ContextBudgetFact {
  id: string;
  kind: ContextFactKind;
  content: string;
  tokenCount?: number;
  artifactId?: string;
  summaryVersion?: number;
}

export interface ContextArtifactReference {
  id: string;
  label: string;
  artifactId?: string;
  summaryVersion?: number;
  tokenCount: number;
}

export interface ContextBudgetPlan {
  availableTokens: number;
  usedTokens: number;
  protectedFacts: ContextBudgetFact[];
  summaries: ContextBudgetFact[];
  recentWindow: ContextBudgetFact[];
  references: ContextArtifactReference[];
  compactedToolOutputCount: number;
  hardBudgetExceeded: boolean;
}

const PROTECTED_CONTEXT_KINDS = new Set<ContextFactKind>([
  'goal',
  'constraint',
  'open_question',
  'failure_evidence',
]);

/**
 * Estimate deliberately conservatively. Providers tokenize differently, but
 * this keeps one enormous log from monopolising a prompt before compaction.
 */
export function estimateContextTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 3.5));
}

/**
 * Produces a bounded prompt plan without silently dropping task-critical
 * facts. Historical tool output is represented by an artifact/reference
 * instead of replaying its raw log into the next model request.
 */
export function buildContextBudgetPlan(
  contract: ContextBudgetContract,
  facts: ContextBudgetFact[],
): ContextBudgetPlan {
  const availableTokens = Math.max(
    0,
    contract.maxInputTokens - contract.reservedOutputTokens - (contract.fixedTokens ?? 0),
  );
  const toTokens = (fact: ContextBudgetFact) => fact.tokenCount ?? estimateContextTokens(fact.content);
  const protectedFacts = facts.filter((fact) => PROTECTED_CONTEXT_KINDS.has(fact.kind));
  const summaries = facts
    .filter((fact) => fact.kind === 'summary')
    .sort((a, b) => (a.summaryVersion ?? 0) - (b.summaryVersion ?? 0));

  let usedTokens = protectedFacts.reduce((total, fact) => total + toTokens(fact), 0);
  const hardBudgetExceeded = usedTokens > availableTokens;
  const recentWindow: ContextBudgetFact[] = [];
  const recentLimit = Math.max(0, contract.recentWindowTokens ?? availableTokens);

  for (const fact of [...facts].reverse()) {
    if (fact.kind === 'tool_output' || PROTECTED_CONTEXT_KINDS.has(fact.kind) || fact.kind === 'summary') {
      continue;
    }
    const tokens = toTokens(fact);
    if (usedTokens + tokens > availableTokens || recentWindow.reduce((total, item) => total + toTokens(item), 0) + tokens > recentLimit) {
      continue;
    }
    recentWindow.unshift(fact);
    usedTokens += tokens;
  }

  const selectedSummaries: ContextBudgetFact[] = [];
  for (const fact of [...summaries].reverse()) {
    const tokens = toTokens(fact);
    if (usedTokens + tokens > availableTokens) continue;
    selectedSummaries.unshift(fact);
    usedTokens += tokens;
  }

  const compactedToolOutput = facts.filter((fact) => fact.kind === 'tool_output');
  const references = compactedToolOutput.map((fact) => ({
    id: fact.id,
    label: fact.content.slice(0, 160),
    artifactId: fact.artifactId,
    summaryVersion: fact.summaryVersion,
    tokenCount: toTokens(fact),
  }));

  return {
    availableTokens,
    usedTokens,
    protectedFacts,
    summaries: selectedSummaries,
    recentWindow,
    references,
    compactedToolOutputCount: compactedToolOutput.length,
    hardBudgetExceeded,
  };
}
