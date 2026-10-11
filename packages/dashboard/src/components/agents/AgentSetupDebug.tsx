import { useEffect, useRef, useState } from 'react';
import type { ExecutionArtifact, ExecutionMessage, Task, TaskExecution, AgentConfigRunAttribution, TaskControlCapabilities, BudgetUsageSummary, AgentControlOperation } from '@myrmecia/shared';
import { api } from '../../lib/api';
import { useStore } from '../../stores/store';
import { MarkdownMessage } from '../common/MarkdownMessage';
import { ExecutionKnowledgeSources } from '../common/ExecutionKnowledgeSources';
import { readExecutionMessagePages } from '../../lib/execution-messages';
import { BudgetUsage } from './AgentBudgetEditor';
import { ExecutionWorkspacePanel } from '../session/ExecutionWorkspacePanel';

export function AgentSetupDebug({ taskId, agentName }: { taskId: string; agentName: string }) {
  const [selectedTaskId, setSelectedTaskId] = useState(taskId);
  const [attempts, setAttempts] = useState([taskId]);
  const [controls, setControls] = useState<TaskControlCapabilities>();
  const [usage, setUsage] = useState<BudgetUsageSummary[]>([]);
  const [busyAction, setBusyAction] = useState('');
  const [controlError, setControlError] = useState('');
  const [followup, setFollowup] = useState('');
  const rerunKey = useRef<string | undefined>(undefined);
  const messageKey = useRef<{ content: string; key: string } | undefined>(undefined);
  const selectedRef = useRef(selectedTaskId);
  selectedRef.current = selectedTaskId;
  useEffect(() => {
    let disposed = false;
    setSelectedTaskId(taskId); setAttempts([taskId]);
    api.tasks.debugHistory(taskId).then(ids => { if (!disposed && ids.length) setAttempts(ids); }).catch(() => {});
    return () => { disposed = true; };
  }, [taskId]);
  const [task, setTask] = useState<Task>();
  const [executions, setExecutions] = useState<TaskExecution[]>([]);
  const [messages, setMessages] = useState<Record<string, ExecutionMessage[]>>({});
  const [error, setError] = useState('');
  const [artifacts, setArtifacts] = useState<ExecutionArtifact[]>([]);
  const [artifactError, setArtifactError] = useState('');
  const [attribution, setAttribution] = useState<AgentConfigRunAttribution>();
  const streams = useStore(state => state.streamingResponses);
  const refreshRef = useRef<(() => Promise<void>) | undefined>(undefined);
  useEffect(() => {
    let disposed = false;
    let busy = false;
    setTask(undefined); setExecutions([]); setMessages({}); setArtifacts([]); setAttribution(undefined);
    setControls(undefined); setUsage([]); setControlError(''); setFollowup(''); rerunKey.current = undefined;
    const refresh = async () => {
      if (busy || disposed) return;
      busy = true;
      try {
        const [current, runs, artifactResult, capability, budget] = await Promise.all([api.tasks.get(selectedTaskId), api.executions.list({ taskId: selectedTaskId }),
          api.artifacts.workbench({ taskId: selectedTaskId }).then(items => ({ items, error: '' })).catch(() => ({
            items: undefined, error: '产物列表暂时不可用；可在 Artifacts 查看，不影响已有回复。',
          })), api.tasks.controls(selectedTaskId).catch(() => undefined), api.tasks.budget(selectedTaskId).catch(() => [])]);
        const history = await Promise.all(runs.map(async run => {
          const history: ExecutionMessage[] = [];
          await readExecutionMessagePages(cursor => api.executions.messages(run.id, cursor), undefined,
            page => history.push(...page));
          return [run.id, history] as const;
        }));
        const latestRun = runs[0];
        const config = latestRun ? await api.executions.agentConfig(latestRun.id).catch(() => undefined) : undefined;
        if (!disposed) {
          setTask(current); setExecutions(runs); setMessages(Object.fromEntries(history)); setError('');
          if (artifactResult.items) setArtifacts(artifactResult.items);
          setArtifactError(artifactResult.error);
          setAttribution(config);
          setControls(capability); setUsage(budget);
          api.tasks.debugHistory(taskId).then(ids => { if (!disposed && ids.length) setAttempts(ids); }).catch(() => {});
        }
      } catch {
        if (!disposed) setError('无法同步试运行状态，保留上次结果。请重试刷新，不要重复创建 Agent。');
      } finally { busy = false; }
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 1500);
    window.addEventListener('focus', refresh);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [selectedTaskId]);
  const perform = async (operation: AgentControlOperation) => {
    if (busyAction || !controls?.operations[operation].allowed) return;
    const target = selectedTaskId;
    if (['cancel', 'rerun', 'accept'].includes(operation)
      && !window.confirm(operation === 'cancel' ? '停止此任务？已发生的外部动作不能撤回。'
        : operation === 'rerun' ? '创建新的试运行任务？原任务与证据会保留。' : '确认本次交付符合你的要求，记录验收通过？')) return;
    setBusyAction(operation); setControlError('');
    try {
      if (operation === 'pause') await api.tasks.pause(target);
      else if (operation === 'resume') await api.tasks.resume(target);
      else if (operation === 'cancel') await api.tasks.cancel(target, true);
      else if (operation === 'accept' && controls.executionId) await api.executions.review(controls.executionId, 'accepted');
      else if (operation === 'rerun') {
        rerunKey.current ||= crypto.randomUUID();
        const next = await api.tasks.rerun(target, rerunKey.current);
        if (selectedRef.current !== target) return;
        setAttempts(current => [...new Set([...current, next.id])]); setSelectedTaskId(next.id);
      } else if (operation === 'followup') {
        const content = followup.trim();
        if (!content) return;
        if (messageKey.current?.content !== content) messageKey.current = { content, key: crypto.randomUUID() };
        if (task?.status === 'running' || task?.status === 'waiting_for_tool') {
          if (messageKey.current?.content !== content) messageKey.current = { content, key: crypto.randomUUID() };
          await api.executions.sendMessage(controls.executionId!, content, 'user_follow_up', 'follow_up', messageKey.current.key);
        } else {
          const next = await api.tasks.continue(target, content, messageKey.current.key);
          if (selectedRef.current !== target) return;
          setAttempts(current => [...new Set([...current, next.id])]); setSelectedTaskId(next.id);
        }
        setFollowup(''); messageKey.current = undefined;
      }
      if (selectedRef.current === target) await refreshRef.current?.();
    } catch (error) { if (selectedRef.current === target) setControlError(error instanceof Error ? error.message : '操作失败；请刷新持久化状态后再试。'); }
    finally { setBusyAction(''); }
  };
  const latest = executions[0];
  const live = executions.some(run => run.status === 'running');
  const accepted = task?.status === 'done' && latest?.runState?.acceptance === 'accepted';
  const status = !task ? '正在读取状态' : task.pauseControl ? task.pauseControl.state === 'requested' ? '正在暂停，等待安全边界' : '已暂停'
    : live ? '正在执行' : task.status === 'done' ? '执行结束'
    : task.status === 'failed' ? '执行失败' : task.status === 'cancelled' ? '已停止'
    : task.status === 'review' ? '等待质量验证' : '等待执行';
  const allMessages = executions.flatMap(run => (messages[run.id] || []).map(message => ({ run, message })));
  const replies = allMessages.filter(entry => entry.message.type === 'agent_text' && entry.message.content.trim());
  const tools = allMessages.filter(entry => ['tool_use', 'tool_result', 'progress', 'error'].includes(entry.message.type));
  const output = task?.output;
  return (
    <section aria-label="Agent inline debugger" className="mt-5 space-y-4 rounded-xl bg-background/70 p-4 text-app-primary">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">试运行 · {agentName}</h4>
        <span role="status" className="text-xs text-app-secondary">{status}</span>
      </header>
      <label className="block text-xs">试运行 / 追问记录<select aria-label="Debug task history" disabled={!!busyAction} value={selectedTaskId}
        onChange={event => setSelectedTaskId(event.target.value)} className="app-focus ml-2 rounded-lg bg-surface px-3 py-2">
        {attempts.map((id, index) => <option key={id} value={id}>第 {index + 1} 次 · {id}</option>)}
      </select></label>
      <div className="flex flex-wrap gap-2" aria-label="Debug controls">
        {(['pause', 'resume', 'cancel', 'rerun', 'accept'] as const).map(operation => <button type="button" key={operation}
          disabled={!!busyAction || !controls?.operations[operation].allowed}
          title={controls?.operations[operation].reason || '控制能力未读取，不能操作'}
          className="app-focus rounded-lg bg-surface px-3 py-2 text-xs disabled:opacity-40"
          onClick={() => void perform(operation)}>{({ pause: '暂停', resume: '恢复', cancel: '停止', rerun: '重新试运行', accept: '验收通过' })[operation]}</button>)}
        <button type="button" className="app-focus rounded-lg px-3 py-2 text-xs" onClick={() => void refreshRef.current?.()}>刷新状态</button>
      </div>
      <ExecutionWorkspacePanel key={selectedTaskId} taskId={selectedTaskId} />
      {!controls && <p className="text-xs text-app-muted">控制能力暂不可用；不会乐观报告暂停或验收成功。</p>}
      {task?.pauseControl && <p className="text-xs text-app-muted">{controls?.operations.resume.reason}</p>}
      {controlError && <p role="alert" className="text-xs text-red-500">{controlError}</p>}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div><dt className="text-app-muted">实际执行者</dt><dd>{latest?.runState?.agentName || latest?.agentDefId || task?.assigneeId || '尚未分配'}</dd></div>
        <div><dt className="text-app-muted">执行记录模型</dt><dd>{latest?.actualModelId || latest?.modelId || '尚无执行记录'}</dd></div>
        <div><dt className="text-app-muted">配置版本</dt><dd>{attribution?.source === 'revision'
          ? `v${attribution.sequence} · ${attribution.configHash?.slice(0, 12)}`
          : attribution?.source === 'phase1_snapshot' ? '第一阶段快照 · 无完整版本'
          : attribution?.source === 'legacy' ? 'Legacy · 历史配置未版本化' : '尚无版本记录'}</dd></div>
        <div><dt className="text-app-muted">Skill 版本</dt><dd>{attribution?.skillVersionId || latest?.skillVersionId || '内联指令 / 尚无记录'}</dd></div>
        <div><dt className="text-app-muted">任务</dt><dd className="[overflow-wrap:anywhere]">{selectedTaskId}</dd></div>
        <div><dt className="text-app-muted">验收</dt><dd>{accepted ? '已记录验收通过'
          : latest?.runState?.acceptance === 'rejected' ? '验收未通过'
          : '尚未验收；运行结束不代表通过'}</dd></div>
      </dl>
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
      <article aria-label="Test request" className="rounded-lg bg-surface px-3 py-2">
        <p className="mb-1 text-xs text-app-muted">你的测试指令</p>
        <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{task?.description || '正在读取…'}</p>
      </article>
      {replies.map(({ run, message }) => (
        <article key={`${run.id}:${message.id}`} aria-label="Test Agent reply">
          <p className="mb-1 text-xs text-app-muted">{run.runState?.agentName || run.agentDefId}</p>
          <MarkdownMessage executionId={run.id} content={output && run.id === latest?.id && output.startsWith(message.content) ? output : message.content} />
        </article>
      ))}
      {output && !replies.some(entry => entry.run.id === latest?.id && output.startsWith(entry.message.content)) && (
        <article aria-label="Test final output"><MarkdownMessage content={output} executionId={latest?.id} /></article>
      )}
      {executions.map(run => streams[run.id] && !(output && run.id === latest?.id && output.startsWith(streams[run.id]))
        && !replies.some(entry => entry.run.id === run.id && entry.message.content === streams[run.id]) && (
        <article key={run.id} aria-label="Test streamed reply">
          <p className="mb-1 text-xs text-app-muted">{run.status === 'running' ? '正在生成回复' : '已停止 · 部分回复'}</p>
          <MarkdownMessage content={streams[run.id]} executionId={run.id} />
        </article>
      ))}
      {task?.error && <p role="alert" className="whitespace-pre-wrap text-xs text-red-500 [overflow-wrap:anywhere]">{task.error}</p>}
      {latest && <ExecutionKnowledgeSources executionId={latest.id} />}
      <details><summary className="app-focus cursor-pointer text-xs">预算与用量</summary><div className="mt-3"><BudgetUsage usage={usage} /></div></details>
      <form aria-label="Debug follow-up" onSubmit={event => { event.preventDefault(); void perform('followup'); }} className="space-y-2">
        <label className="block text-xs">继续追问<textarea aria-label="Debug follow-up instruction" maxLength={8000} value={followup}
          onChange={event => setFollowup(event.target.value)} disabled={!!busyAction}
          className="app-focus mt-1 min-h-20 w-full rounded-lg bg-surface px-3 py-2" /></label>
        <p className="text-xs text-app-muted">{controls?.operations.followup.reason || '读取控制能力后才能发送'}</p>
        <button disabled={!!busyAction || !followup.trim() || !controls?.operations.followup.allowed}
          className="app-focus rounded-lg bg-surface px-3 py-2 text-xs disabled:opacity-40">发送追问</button>
      </form>
      {!output && !replies.length && !executions.some(run => streams[run.id]) && (
        <p className="text-sm text-app-muted">{live ? '等待第一条真实回复…' : '尚未记录可展示的回复。'}</p>
      )}
      {tools.length > 0 && <details aria-label="Test tool activity" className="rounded-lg bg-surface p-3 text-xs">
        <summary className="app-focus cursor-pointer text-app-secondary">工具与执行详情 · {tools.length} 条记录</summary>
        <div className="mt-3 space-y-3">
          {tools.map(({ run, message }) => <div key={`${run.id}:${message.id}`}>
            <p className="font-medium">{message.toolName || message.type}</p>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] text-app-secondary">{message.content}</pre>
          </div>)}
        </div>
      </details>}
      <details aria-label="Test artifacts" className="text-xs">
        <summary className="app-focus cursor-pointer font-medium">本次产物 · {artifacts.length} 个</summary>
        {artifactError ? <p className="mt-1 text-app-muted">{artifactError}</p>
          : artifacts.length ? <ul className="mt-2 space-y-1">
            {artifacts.map(artifact => <li key={artifact.id} className="[overflow-wrap:anywhere]">{artifact.name} · {artifact.kind} · {artifact.sizeBytes} bytes</li>)}
          </ul> : <p className="mt-1 text-app-muted">尚未记录文件产物；文字回复见上方。</p>}
        {artifacts.length > 0 && <button type="button" className="app-focus mt-2 rounded px-2 py-1 text-accent-light hover:bg-surface-hover" onClick={() => {
          useStore.getState().setSelectedTaskId(selectedTaskId); useStore.getState().setActiveView('artifacts');
        }}>到 Artifacts 查看 / 下载</button>}
      </details>
      <button type="button" className="app-focus rounded-lg px-3 py-2 text-xs text-accent-light hover:bg-surface-hover" onClick={() => {
        useStore.getState().setSelectedTaskId(selectedTaskId); useStore.getState().setActiveView('session');
      }}>打开完整会话</button>
    </section>
  );
}
