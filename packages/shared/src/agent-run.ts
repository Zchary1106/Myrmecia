/** Execution progress is not evidence that the user's goal has been accepted. */
export type AgentRunPhase =
  | 'starting' | 'deciding' | 'acting' | 'observing' | 'validating'
  | 'waiting_for_user' | 'waiting_for_tool'
  | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export type AgentStopReason =
  | 'completed' | 'needs_input' | 'max_turns' | 'token_budget' | 'cost_budget'
  | 'deadline' | 'tool_unavailable' | 'model_truncated' | 'empty_output'
  | 'cancelled' | 'interrupted' | 'failed';

export interface AgentOutputValidation {
  status: 'passed' | 'failed';
  scope: 'output'; // This is not a quality gate, test pass, or user acceptance.
  checks: { name: string; passed: boolean; message?: string }[];
}

export interface AgentRunState {
  schemaVersion: 1;
  phase: AgentRunPhase;
  turn: number;
  toolCallCount: number;
  runtime?: string;
  agentName?: string;
  deadlineAt?: string;
  stopReason?: AgentStopReason;
  validation?: AgentOutputValidation;
  acceptance: 'pending' | 'accepted' | 'rejected';
  acceptanceNote?: string;
  acceptedAt?: string;
  resumedFromExecutionId?: string;
  updatedAt: string;
  /** Actual request timing, not fabricated reasoning/progress. */
  modelRequest?: {
    modelId: string;
    startedAt: string;
    deadlineAt: string;
    firstOutputAt?: string;
  };
}

export function isQualityStep(task: { title: string; parentTaskId?: string | null }): boolean {
  return Boolean(task.parentTaskId && /^(Test|Review|Fix):\s/.test(task.title));
}

export function canAcceptAgentOutput(
  execution: { status: string; runState?: AgentRunState },
  task: { status: string; title: string; parentTaskId?: string | null },
  sessionStatus = task.status,
): boolean {
  return task.status === 'done' && sessionStatus === 'done' && !isQualityStep(task)
    && execution.status === 'done' && execution.runState?.phase === 'completed'
    && execution.runState.stopReason === 'completed' && execution.runState.validation?.status === 'passed';
}

export type ToolFailureCode =
  | 'LOGIN_REQUIRED' | 'NOT_CONNECTED' | 'QUEUE_TIMEOUT' | 'EXECUTION_TIMEOUT'
  | 'PERMISSION_DENIED' | 'CANCELLED' | 'INVALID_INPUT' | 'TOOL_FAILED';

export interface ToolFailure {
  code: ToolFailureCode;
  message: string;
  retryable: boolean;
  /** A timeout does not prove a write operation did not happen. */
  outcomeUnknown: boolean;
}

export const AGENT_RUN_PHASE_LABELS: Record<AgentRunPhase, string> = {
  starting: '准备执行', deciding: '规划下一步', acting: '调用工具',
  observing: '分析工具结果', validating: '检查输出',
  waiting_for_user: '等待补充信息', waiting_for_tool: '等待工具',
  completed: '执行已结束', failed: '执行失败', cancelled: '已取消',
  interrupted: '执行中断',
};

export const AGENT_STOP_REASON_LABELS: Record<AgentStopReason, string> = {
  completed: '正常结束', needs_input: '需要补充信息', max_turns: '达到轮数上限',
  token_budget: 'Token 预算耗尽', deadline: '执行超时',
  cost_budget: '费用预算耗尽',
  tool_unavailable: '工具不可用', model_truncated: '模型输出被截断',
  empty_output: '没有有效输出', cancelled: '用户取消',
  interrupted: '执行中断', failed: '执行失败',
};

export function isWaitingForAgentInput(
  task: { id: string; status: string },
  executions: { taskId: string; status: string; runState?: AgentRunState }[],
): boolean {
  return task.status === 'review'
    && !executions.some(run => run.taskId === task.id && run.status === 'running')
    && executions.some(run => run.taskId === task.id && run.runState?.phase === 'waiting_for_user' && run.runState.stopReason === 'needs_input');
}
