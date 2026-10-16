import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import type { Task } from '../types.js';
import { getDb } from '../db/database.js';
import { getExecution, listExecutions } from '../db/models/execution.js';
import { taskMayHaveSideEffects } from './retry-ownership.js';
import { dlpCheck } from '../security/dlp.js';
import { fencedRunWrite } from './run-coordinator.js';
import { runtimeV2Enabled } from './runtime-version.js';
import { agentSessionForTask, appendSessionEvent, listSessionEvents } from '../db/models/agent-session-event.js';
import { normalizeGatewayRequest, toGatewayRequest } from '../models/provider-driver.js';
import { defaultRuntimeCapabilities, type DevelopmentStageState } from '@myrmecia/shared';
import { deriveModelMessages } from './session-projector.js';

export interface AgentLoopCheckpoint {
  schemaVersion: 1;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  turn: number;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
  toolRuntimeMs: number;
  elapsedMs: number;
  finalOutput: string;
  boundary?: 'stable' | 'request_pending';
  journalCursor?: number;
  journalCheckpointId?: string;
  pendingRequestId?: string;
  ownerToken?: number;
  developmentStage?: DevelopmentStageState;
  skillSteps?: Array<{ name: string; status: 'done' | 'failed' | 'skipped'; output?: string; retries: number; validationOutput?: string }>;
}

export function loopFingerprint(input: {
  agentId: string; modelId: string; systemPrompt: string;
  input: string; tools: string[]; workdir?: string; skillChecksum?: string;
}): string {
  return createHash('sha256').update(JSON.stringify({ ...input, tools: [...input.tools].sort() })).digest('hex');
}

/** Only a stable, read-only TS-turn boundary can be resumed automatically. */
export function readLoopCheckpoint(task: Task, fingerprint: string, currentExecutionId: string): {
  executionId: string; snapshot: AgentLoopCheckpoint;
} | undefined {
  const row = getDb().get<any>(
    `SELECT * FROM agent_loop_checkpoints
      WHERE task_id = ? AND workspace_id = ? AND execution_id <> ?
      ORDER BY updated_at DESC LIMIT 1`,
    task.id, task.workspaceId || 'default', currentExecutionId,
  );
  const previous = row ? getExecution(row.execution_id)
    : listExecutions({ taskId: task.id, limit: 10 }).find(run => run.id !== currentExecutionId);
  const unavailable = (): undefined => {
    if (previous?.runState?.userPaused) {
      throw new Error('PAUSE_CHECKPOINT_INCOMPATIBLE: model, tools or context changed; explicit reconciliation required');
    }
    return undefined;
  };
  if (process.env.MYRMECIA_DURABLE_RESUME === 'false' || taskMayHaveSideEffects(task.id)) return unavailable();
  if (!row || !row.resumable || row.fingerprint !== fingerprint) return unavailable();
  const run = getExecution(row.execution_id);
  if (run?.status !== 'failed' || run.runState?.stopReason !== 'interrupted') return unavailable();
  try {
    const snapshot = JSON.parse(row.snapshot) as AgentLoopCheckpoint;
    if (snapshot.schemaVersion !== 1 || snapshot.boundary === 'request_pending' || !Array.isArray(snapshot.messages)
      || ![snapshot.turn, snapshot.inputTokens, snapshot.outputTokens, snapshot.toolCallCount, snapshot.toolRuntimeMs, snapshot.elapsedMs]
        .every(value => Number.isFinite(value) && value >= 0)) return unavailable();
    if (runtimeV2Enabled()) {
      // Never trust an independently mutable compatibility messages array on V2 recovery.
      if (!snapshot.journalCheckpointId || !snapshot.journalCursor) return unavailable();
      const event = listSessionEvents({ workspaceId: task.workspaceId || 'default', sessionId: agentSessionForTask(task),
        afterSequence: snapshot.journalCursor - 1, limit: 1 })[0];
      if (!event || event.eventId !== snapshot.journalCheckpointId || event.sequence !== snapshot.journalCursor
        || event.runId !== row.execution_id || event.payload.type !== 'context.checkpoint') return unavailable();
      const messages = toGatewayRequest({ modelId: 'checkpoint', messages: deriveModelMessages([event]) },
        defaultRuntimeCapabilities('host_loop')).messages;
      for (let index = 0; index < messages.length; index++) {
        const prior = snapshot.messages[index] as any;
        if (prior?.myrmeciaContextFacts && prior.role === messages[index].role
          && JSON.stringify(prior.content) === JSON.stringify(messages[index].content)) {
          (messages[index] as any).myrmeciaContextFacts = prior.myrmeciaContextFacts;
        }
      }
      snapshot.messages = messages;
      snapshot.skillSteps = structuredClone(event.payload.skillSteps);
      snapshot.developmentStage = structuredClone(event.payload.developmentStage);
    }
    return { executionId: row.execution_id, snapshot };
  } catch { return unavailable(); }
}

export function saveLoopCheckpoint(task: Task, executionId: string, fingerprint: string, snapshot: AgentLoopCheckpoint): void {
  const raw = JSON.stringify(snapshot);
  const checked = dlpCheck(raw, { taskId: task.id, workspaceId: task.workspaceId });
  // Sensitive or unrepresentable snapshots disable recovery, not live execution.
  if (checked.violations.some(violation => violation.action === 'block')) {
    sealLoopCheckpoint(executionId);
    return;
  }
  const serialized = checked.redactedContent || raw;
  try { JSON.parse(serialized); } catch { sealLoopCheckpoint(executionId); return; }
  // Bound storage independently of per-message output limits.
  if (Buffer.byteLength(serialized) > 2_000_000) {
    sealLoopCheckpoint(executionId);
    return;
  }
  fencedRunWrite(task.id, () => getDb().transaction(() => {
    const safeSnapshot = JSON.parse(serialized) as AgentLoopCheckpoint;
    if (runtimeV2Enabled() && snapshot.boundary !== 'request_pending') {
      const event = appendSessionEvent({ workspaceId: task.workspaceId || 'default', sessionId: agentSessionForTask(task),
        runId: executionId, eventKey: `checkpoint:${executionId}:${snapshot.turn}${snapshot.developmentStage ? `:stage-${snapshot.developmentStage.revision}` : ''}`,
        payload: { type: 'context.checkpoint', projectionVersion: 1,
          messages: normalizeGatewayRequest({ model: 'checkpoint', messages: safeSnapshot.messages }).messages,
          ...(safeSnapshot.developmentStage ? { developmentStage: safeSnapshot.developmentStage } : {}),
          ...(safeSnapshot.skillSteps ? { skillSteps: safeSnapshot.skillSteps } : {}) } });
      safeSnapshot.journalCursor = event.sequence;
      safeSnapshot.journalCheckpointId = event.eventId;
    }
    getDb().run(
      `INSERT INTO agent_loop_checkpoints (execution_id, task_id, workspace_id, fingerprint, snapshot, resumable, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(execution_id) DO UPDATE SET snapshot = excluded.snapshot, resumable = excluded.resumable, updated_at = excluded.updated_at`,
      executionId, task.id, task.workspaceId || 'default', fingerprint, JSON.stringify(safeSnapshot),
      snapshot.boundary === 'request_pending' ? 0 : 1, new Date().toISOString());
  }));
}

export function sealLoopCheckpoint(executionId: string): void {
  getDb().run('UPDATE agent_loop_checkpoints SET resumable = 0 WHERE execution_id = ?', executionId);
}
