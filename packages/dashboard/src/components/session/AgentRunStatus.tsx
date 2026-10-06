import { useEffect, useState } from 'react';
import { AGENT_RUN_PHASE_LABELS, AGENT_STOP_REASON_LABELS, canAcceptAgentOutput, isQualityStep, type Task, type TaskExecution } from '@myrmecia/shared';
import { api } from '../../lib/api';
import { useStore } from '../../stores/store';

export function AgentRunStatus({ execution, agentName, task, sessionStatus = task.status, sessionError, onRevise }: {
  execution: TaskExecution; agentName: string;
  task: Pick<Task, 'status' | 'title' | 'parentTaskId'>;
  sessionStatus?: string; sessionError?: string; onRevise?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const state = execution.runState;
  const [now, setNow] = useState(Date.now);
  const request = execution.status === 'running' ? state?.modelRequest : undefined;
  useEffect(() => {
    if (!request || request.firstOutputAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [request?.startedAt, request?.firstOutputAt]);
  if (!state) return null; // A historical run has no inferred validation/acceptance.
  const internal = isQualityStep(task);
  const blocked = ['failed', 'cancelled'].includes(task.status) || ['failed', 'cancelled'].includes(sessionStatus);
  const waiting = request && !request.firstOutputAt;
  const elapsed = request ? Math.max(0, Math.floor((now - Date.parse(request.startedAt)) / 1000)) : 0;
  const label = blocked ? '整体任务未完成'
    : internal ? '质量检查子步骤'
    : waiting ? '等待模型首条输出'
    : request ? '正在生成回复'
    : task.status === 'review' && state.stopReason === 'completed' ? '等待质量验证'
    : AGENT_RUN_PHASE_LABELS[state.phase];
  const review = async (decision: 'accepted' | 'rejected') => {
    setBusy(true); setError('');
    try {
      useStore.getState().upsertExecution(await api.executions.review(execution.id, decision));
      if (decision === 'rejected') onRevise?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存验收结果失败');
    } finally { setBusy(false); }
  };
  return (
    <section aria-label="Agent 执行状态" className="rounded-xl border border-border bg-surface/50 px-4 py-3 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-app-secondary">
        <span className="font-semibold text-app-primary">{agentName}</span>
        <span>{label}</span>
        {state.turn > 0 && <span>第 {state.turn} 轮</span>}
        {!blocked && !internal && state.stopReason && <span>{AGENT_STOP_REASON_LABELS[state.stopReason]}</span>}
        {state.resumedFromExecutionId && <span>已从检查点恢复</span>}
        {state.phase === 'waiting_for_tool' && state.deadlineAt && <span>
          等待截止 {new Date(state.deadlineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>}
      </div>
      {waiting && <p className="mt-2 text-app-muted" role="status">
        {request.modelId} · 已等待 {Number.isFinite(elapsed) ? elapsed : 0} 秒
        {elapsed >= 30 && '。模型暂未返回正文，这不是任务完成进度。'}
        {now >= Date.parse(request.deadlineAt)
          ? ' 请求时限已到，等待后端取消结果。'
          : ` · 请求截止 ${new Date(request.deadlineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`}
      </p>}
      {blocked && <p className="mt-2 text-red-500" role="alert">
        {sessionError || '任务失败或已取消，不能把此步骤的输出验收为成功。'}
      </p>}
      {internal && <p className="mt-2 text-app-muted">这是内部质量检查，不是可验收的最终产物。</p>}
      {state.validation && <p className="mt-2 text-app-muted">
        {state.validation.status === 'passed' ? '基础输出检查通过，不代表质量验收通过。' : '基础输出检查未通过。'}
        {!blocked && !internal && (state.acceptance === 'pending' ? ' 尚未验收。' : state.acceptance === 'accepted' ? ' 你已接受此结果。' : ' 你已要求修改此结果。')}
      </p>}
      {state.acceptance === 'pending' && canAcceptAgentOutput(execution, task, sessionStatus) && <div className="mt-2 flex gap-2">
          <button type="button" disabled={busy} onClick={() => void review('accepted')} className="app-focus rounded-lg border border-border px-3 py-1.5 text-app-primary hover:bg-surface-hover disabled:opacity-50">接受结果</button>
          <button type="button" disabled={busy} onClick={() => void review('rejected')} className="app-focus rounded-lg px-3 py-1.5 text-app-secondary hover:bg-surface-hover disabled:opacity-50">需要修改</button>
        </div>}
      {error && <p role="alert" className="mt-2 text-red-400">{error}</p>}
    </section>
  );
}
