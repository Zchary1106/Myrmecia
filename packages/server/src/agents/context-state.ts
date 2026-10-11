import type OpenAI from 'openai';
import { injectedContextFacts, type ContextBudgetFact } from './context-compactor.js';
import type { Task } from '../types.js';
import { loadExecutionContext } from './execution-context.js';
import { listExecutionArtifacts } from '../db/models/execution-artifact.js';
import { archiveContextSummary } from './tool-output-artifact.js';
import { sanitizeAgentOutput } from '../security/dlp-runtime.js';
import { getDb } from '../db/database.js';

export interface CollectedContextState {
  facts: ContextBudgetFact[];
  readFiles: string[];
  modifiedFiles: string[];
}

/** Facts come from approved task context and observed messages, never from inferred tool instructions. */
export function collectContextFacts(task: Task, messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): CollectedContextState {
  const context = loadExecutionContext(task);
  const facts: ContextBudgetFact[] = [
    { id: 'task-goal', kind: 'goal', content: context.goal },
    ...context.constraints.map((content, index) => ({ id: `task-constraint-${index}`, kind: 'constraint' as const, content })),
  ];
  const prior = listExecutionArtifacts({ taskId: task.id, workspaceId: task.workspaceId || 'default', limit: 200 })
    .filter(artifact => artifact.metadata?.contextCompaction === true && Array.isArray(artifact.metadata?.contextFacts));
  for (const artifact of prior) {
    for (const fact of artifact.metadata!.contextFacts as ContextBudgetFact[]) {
      if (['goal', 'constraint', 'open_question', 'failure_evidence'].includes(fact.kind)
        && typeof fact.content === 'string') facts.push(fact);
    }
  }
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user' && typeof message.content === 'string') {
      facts.push(...(injectedContextFacts(message) || [{ id: `user-instruction-${index}`, kind: 'constraint' as const, content: message.content }]));
    }
  }
  // Requested calls do not prove files were touched; only completed governed executions do.
  const operations = getDb().all<{ tool_id: string; input_summary: string }>(
    "SELECT tool_id, input_summary FROM tool_executions WHERE task_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 200",
    task.id,
  );
  for (const operation of operations) {
    try {
      const input = JSON.parse(operation.input_summary || '{}');
      if (typeof input.path !== 'string') continue;
      if (operation.tool_id === 'file_read') readFiles.add(input.path);
      if (['file_write', 'file_edit', 'file_delete'].includes(operation.tool_id)) modifiedFiles.add(input.path);
    } catch { /* Truncated/redacted summaries do not prove a path. */ }
  }
  const unique = new Map<string, ContextBudgetFact>();
  for (const fact of facts) if (fact.content.trim()) unique.set(`${fact.kind}:${fact.content}`, fact);
  return { facts: [...unique.values()], readFiles: [...readFiles], modifiedFiles: [...modifiedFiles] };
}

/** Follow-ups can refresh contextUsage; sealed artifact versions cannot rewind. */
export function nextContextSummaryVersion(task: Task): number {
  const row = getDb().get<{ version: number | null }>(`
    SELECT MAX(CAST(json_extract(metadata, '$.summaryVersion') AS INTEGER)) AS version
    FROM execution_artifacts WHERE task_id=? AND workspace_id=?
      AND json_extract(metadata, '$.contextCompaction')=1
  `, task.id, task.workspaceId || 'default');
  return Math.max(row?.version || 0, loadExecutionContext(task).contextUsage?.summaryVersion || 0) + 1;
}

export function recordContextSummary(data: {
  task: Task; executionId: string; version: number; summary: string; facts?: ContextBudgetFact[];
}): string {
  const summary = sanitizeAgentOutput(data.summary, {
    taskId: data.task.id, workspaceId: data.task.workspaceId, executionId: data.executionId, purpose: 'context compaction summary',
  });
  const facts = (data.facts || []).map(fact => ({
    ...fact, content: sanitizeAgentOutput(fact.content, {
      taskId: data.task.id, workspaceId: data.task.workspaceId, executionId: data.executionId, purpose: 'protected context fact',
    }),
  }));
  const { readFiles, modifiedFiles } = collectContextFacts(data.task, []);
  return archiveContextSummary({ ...data, summary, facts, readFiles, modifiedFiles });
}
