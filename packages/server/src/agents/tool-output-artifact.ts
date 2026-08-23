import type { Task } from '../types.js';
import { upsertExecutionArtifact } from '../db/models/execution-artifact.js';

const MAX_INLINE_TOOL_OUTPUT_CHARS = 2_000;

function summarize(output: string): string {
  const head = output.slice(0, 700);
  const tail = output.length > 1_100 ? output.slice(-400) : '';
  return tail ? `${head}\n…\n${tail}` : head;
}

/**
 * Store large tool output as durable evidence and return only a bounded prompt
 * reference. This prevents a single log from silently consuming the next
 * model call's context while keeping the full evidence reviewable.
 */
export function archiveLongToolOutput(data: {
  task: Task;
  executionId: string;
  toolExecutionId: string;
  toolName: string;
  output: string;
}): string {
  if (data.output.length <= MAX_INLINE_TOOL_OUTPUT_CHARS) return data.output;
  const artifact = upsertExecutionArtifact({
    workspaceId: data.task.workspaceId,
    taskId: data.task.id,
    executionId: data.executionId,
    pipelineId: data.task.pipelineId,
    stageIndex: data.task.stageIndex,
    name: `${data.toolName} output`,
    kind: 'text',
    mimeType: 'text/plain; charset=utf-8',
    source: 'result',
    relativePath: `__tool_outputs__/${data.toolExecutionId}.log`,
    content: data.output,
    sizeBytes: Buffer.byteLength(data.output),
    metadata: { toolName: data.toolName, archivedFromPrompt: true },
  });
  return [
    `[Large tool output archived as artifact ${artifact.id} (${artifact.sizeBytes} bytes).`,
    'Use the artifact reference for full evidence; key excerpts follow.]',
    summarize(data.output),
  ].join('\n');
}
