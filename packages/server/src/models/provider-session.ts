import { createHash } from 'node:crypto';
import type { Task, RuntimeRequest } from '../types.js';
import { getDb } from '../db/database.js';
import { agentSessionForTask } from '../db/models/agent-session-event.js';
import { taskMayHaveSideEffects } from '../agents/retry-ownership.js';
import { fencedRunWrite } from '../agents/run-coordinator.js';
import { getExecution } from '../db/models/execution.js';
import { updateAgentRun } from '../agents/run-state.js';

export interface ProviderSessionOptions {
  resumeSessionId?: string;
  onSessionReady?: (sessionId: string, resumed: boolean) => void;
}
/** Pending SDK work is not replayable. Continuity is independent from host checkpoints. */
export function prepareProviderSession(task: Task, runId: string, requestId: string, request: RuntimeRequest): {
  options: ProviderSessionOptions; settle: () => void;
} {
  const workspaceId = task.workspaceId || 'default';
  const agentId = task.assigneeId || getExecution(runId)!.agentDefId;
  const key = createHash('sha256').update(JSON.stringify({
    workspaceId, sessionId: agentSessionForTask(task), agentId, provider: 'copilot',
    modelId: request.modelId, tools: request.tools, tuning: request.tuning,
    system: request.messages.filter(message => message.role === 'system'),
  })).digest('hex');
  let sessionRef: string | undefined;
  const previous = getDb().get<any>('SELECT * FROM agent_provider_sessions WHERE workspace_id = ? AND session_key = ?', workspaceId, key);
  const resumeSessionId = previous?.status === 'stable' && !taskMayHaveSideEffects(task.id) ? previous.provider_session_id : undefined;
  return {
    options: {
      resumeSessionId,
      onSessionReady: (id, resumed) => {
        if (!/^[A-Za-z0-9._:-]{1,256}$/.test(id)) throw new Error('PROVIDER_SESSION_ID_INVALID');
        sessionRef = id;
        const phase = getExecution(runId)?.runState?.phase;
        if (phase) updateAgentRun(runId, phase, { providerContinuity: resumed ? 'resumed' : 'fresh' });
        fencedRunWrite(task.id, () => getDb().run(`INSERT INTO agent_provider_sessions
          (workspace_id, session_key, provider_session_id, request_id, task_id, status, mode)
          VALUES (?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT(workspace_id, session_key) DO UPDATE SET
          provider_session_id = excluded.provider_session_id, request_id = excluded.request_id, task_id = excluded.task_id,
          status = 'pending', mode = excluded.mode`,
          workspaceId, key, id, requestId, task.id, resumed ? 'resumed' : 'fresh'));
      },
    },
    settle: () => {
      if (!sessionRef || taskMayHaveSideEffects(task.id)) return;
      fencedRunWrite(task.id, () => getDb().run(`UPDATE agent_provider_sessions SET status = 'stable'
        WHERE workspace_id = ? AND session_key = ? AND provider_session_id = ? AND request_id = ?`,
        workspaceId, key, sessionRef, requestId));
    },
  };
}
