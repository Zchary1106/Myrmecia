import type { Task } from '../types.js';
import { upsertExecutionArtifact } from '../db/models/execution-artifact.js';
import { saveArtifactSnapshot } from '../artifacts/artifact-snapshot-store.js';
import type { ContextBudgetFact } from './context-compactor.js';

const MAX_INLINE_TOOL_OUTPUT_CHARS = 2_000;

function summarize(output: string): string {
  const head = output.slice(0, 700);
  const tail = output.length > 1_100 ? output.slice(-400) : '';
  return tail ? `${head}\n…\n${tail}` : head;
}

/** Structured search evidence must not become a broken head/tail JSON snippet.
 * This input has already passed the MCP read adapter and runtime DLP guard.
 * Keep only ordered, bounded source records; never forward credentials/media.
 */
function summarizeXiaohongshuSearch(output: string, artifactId: string): string | undefined {
  let data: any;
  try { data = JSON.parse(output); } catch { return undefined; }
  if (!data || data.source !== 'xiaohongshu MCP' || !Array.isArray(data.notes)) return undefined;
  const packet: {
    source: string; retrieved_at?: string; artifact_ref: string; notes: Array<Record<string, unknown>>;
    returned_note_count: number; omitted_note_count: number; notice: string;
  } = {
    source: 'xiaohongshu MCP',
    ...(typeof data.retrieved_at === 'string' && Number.isFinite(Date.parse(data.retrieved_at))
      ? { retrieved_at: data.retrieved_at.slice(0, 40) } : {}),
    artifact_ref: `artifact://${artifactId}`,
    notes: [],
    returned_note_count: data.notes.length,
    omitted_note_count: data.notes.length,
    notice: 'Ordered bounded source excerpt. Full sanitized response is archived. User-generated claims are not verified facts. Do not invent omitted notes.',
  };
  for (const original of data.notes.slice(0, 6)) {
    if (!original || typeof original.title !== 'string' || typeof original.source_url !== 'string'
      || !/^https:\/\/www\.xiaohongshu\.com\/explore\/[A-Za-z0-9_-]{1,100}$/.test(original.source_url)) break;
    const note = {
      title: original.title.slice(0, 240),
      ...(original.title.length > 240 ? { title_truncated: true } : {}),
      source_url: original.source_url,
      ...(typeof original.author === 'string' ? { author: original.author.slice(0, 80) } : {}),
      ...(typeof original.note_ref === 'string' && /^xhsref_[a-z-]{1,80}$/.test(original.note_ref)
        ? { note_ref: original.note_ref } : {}),
    };
    const candidate = { ...packet, notes: [...packet.notes, note],
      omitted_note_count: data.notes.length - packet.notes.length - 1 };
    if (JSON.stringify(candidate).length > MAX_INLINE_TOOL_OUTPUT_CHARS) break;
    packet.notes = candidate.notes;
    packet.omitted_note_count = candidate.omitted_note_count;
  }
  return JSON.stringify(packet);
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
  forceArchive?: boolean;
}): string {
  if (data.output.length <= MAX_INLINE_TOOL_OUTPUT_CHARS && !data.forceArchive) return data.output;
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
  saveArtifactSnapshot(artifact, Buffer.from(data.output));
  if (data.toolName === 'mcp__xiaohongshu__search_feeds') {
    const structured = summarizeXiaohongshuSearch(data.output, artifact.id);
    if (structured) return structured;
  }
  return [
    `[Large tool output archived as artifact ${artifact.id} (${artifact.sizeBytes} bytes).`,
    'Use the artifact reference for full evidence; key excerpts follow.]',
    summarize(data.output),
  ].join('\n');
}

/** Persist a compaction summary so recovery and review can retrieve the exact version. */
export function archiveContextSummary(data: {
  task: Task;
  executionId: string;
  version: number;
  summary: string;
  facts?: ContextBudgetFact[];
  readFiles?: string[];
  modifiedFiles?: string[];
}): string {
  const artifact = upsertExecutionArtifact({
    workspaceId: data.task.workspaceId,
    taskId: data.task.id,
    executionId: data.executionId,
    pipelineId: data.task.pipelineId,
    stageIndex: data.task.stageIndex,
    name: `Context summary v${data.version}`,
    kind: 'text',
    mimeType: 'text/markdown; charset=utf-8',
    source: 'result',
    relativePath: `__context_summaries__/v${data.version}.md`,
    content: data.summary,
    sizeBytes: Buffer.byteLength(data.summary),
    metadata: {
      summaryVersion: data.version, contextCompaction: true,
      ...(data.facts ? { contextFacts: data.facts } : {}),
      ...(data.readFiles ? { readFiles: data.readFiles } : {}),
      ...(data.modifiedFiles ? { modifiedFiles: data.modifiedFiles } : {}),
    },
  });
  saveArtifactSnapshot(artifact, Buffer.from(data.summary));
  return artifact.id;
}
