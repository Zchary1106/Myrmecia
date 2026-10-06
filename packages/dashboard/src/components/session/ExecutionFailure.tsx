import type { ExecutionMessage, Task } from '@myrmecia/shared';
import { useEffect, useRef, useState } from 'react';
import { MarkdownMessage } from '../common/MarkdownMessage';
import { api } from '../../lib/api';

function failureCopy(error: string) {
  if (/tool_unavailable|AGENT_TOOL_UNAVAILABLE/i.test(error)) return {
    title: '资料来源不可用，结果尚不完整',
    body: '已保留能够提供的部分回答。请检查工具连接或登录状态，再基于现有资料继续。',
    models: false,
  };
  if (/AGENT_MAX_TURNS/i.test(error)) return {
    title: '达到执行轮数上限，任务未完成',
    body: '已保留本轮的部分结果。可以缩小目标或补充约束后继续，不会自动重复整轮执行。',
    models: false,
  };
  if (/TOOL_REPLAY_BLOCKED|RECOVERY_REQUIRES_REVIEW/i.test(error)) return {
    title: '需要核实上一轮的工具操作',
    body: '工具可能已经产生了实际变更。请先检查外部结果，再决定是否发起新的操作。',
    models: false,
  };
  if (/AGENT_MODEL_TRUNCATED|AGENT_EMPTY_OUTPUT/i.test(error)) return {
    title: '模型没有返回完整结果',
    body: '本轮未通过基础输出检查，可以调整输出预算或缩小任务后继续。',
    models: true,
  };
  if (/quota|billing|payment required/i.test(error)) return {
    title: '模型额度不足，任务已停止',
    body: '请检查模型账号的可用额度，或选择其他可用模型后再继续。',
    models: true,
  };
  if (/timeout|timed.out|超时/i.test(error)) return {
    title: '执行超时，任务未完成',
    body: '本轮未能在时间预算内生成最终回答。可以基于已收集资料继续，减少需要补充的查询。',
    models: false,
  };
  return { title: '任务执行失败', body: '本轮未完成。请查看错误详情，处理原因后再继续。', models: false };
}

function evidenceText(message: ExecutionMessage): string | undefined {
  if (message.type !== 'tool_result') return;
  try {
    const result = JSON.parse(message.content);
    if (result.kind === 'research_result' && result.status === 'done' && typeof result.output === 'string') return result.output;
    // Historical MCP results predate the explicit success envelope.
    if (result.source === 'xiaohongshu MCP' && Array.isArray(result.notes) && result.notes.length) return message.content;
  } catch { /* Truncated historical results are not presented as complete evidence. */ }
}

function EvidenceContent({ content }: { content: string }) {
  try {
    const parsed = JSON.parse(content);
    const notes = Array.isArray(parsed.notes) ? parsed.notes : Array.isArray(parsed) ? parsed : null;
    if (notes) return <ul className="space-y-2">
      {notes.slice(0, 12).map((note: any, index: number) => {
        const href = note.source_url || note.url;
        return <li key={index} className="rounded-lg border border-border p-2.5">
          {typeof href === 'string' && /^https?:\/\//i.test(href)
            ? <a href={href} target="_blank" rel="noopener noreferrer" className="app-focus text-accent-light">{String(note.title || href)}</a>
            : <span>{String(note.title || note.name || '来源记录')}</span>}
          {note.author && <p className="mt-1 text-app-muted">{String(note.author)}</p>}
        </li>;
      })}
    </ul>;
  } catch { /* Plain text research remains readable. */ }
  return <MarkdownMessage content={content} />;
}

export function ExecutionFailure({ task, errors, results, onModels, onContinue, onRetry, retrying = false }: {
  task: Task;
  errors: ExecutionMessage[];
  results: ExecutionMessage[];
  onModels: () => void;
  onContinue: () => void;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const [archived, setArchived] = useState<ExecutionMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [archiveError, setArchiveError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const requestGeneration = useRef(0);
  useEffect(() => () => { requestGeneration.current++; }, [task.id]);
  const loadArchived = async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setArchiveError('');
    try {
      const artifacts = await api.artifacts.workbench({ taskId: task.id, limit: 50 });
      const candidates = artifacts.filter(item => item.metadata?.researchEvidence === true
        || (item.metadata?.archivedFromPrompt === true && item.metadata?.toolName === 'mcp__xiaohongshu__search_feeds'))
        .filter(item => item.sizeBytes <= 128_000).slice(0, 6);
      const recovered: ExecutionMessage[] = [];
      for (const artifact of candidates) {
        if (generation !== requestGeneration.current) return;
        const blob = await api.artifacts.preview(artifact.id);
        if (blob.size > 128_000) continue;
        const output = await blob.text();
        recovered.push({
          id: -1, executionId: artifact.executionId, type: 'tool_result',
          content: artifact.metadata?.researchEvidence === true ? JSON.stringify({ kind: 'research_result', status: 'done', output }) : output,
          toolName: String(artifact.metadata?.toolName || ''), createdAt: artifact.createdAt,
        });
      }
      if (generation !== requestGeneration.current) return;
      setArchived(recovered);
      setLoaded(true);
    } catch {
      if (generation === requestGeneration.current) setArchiveError('归档资料暂时无法读取，请重试。');
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  };
  const stopped = task.status === 'failed';
  const copy = failureCopy(task.error || errors.at(-1)?.content || '');
  const seen = new Set<string>();
  const evidence = [...results, ...archived].flatMap(message => {
    const text = evidenceText(message);
    if (!text || seen.has(text)) return [];
    seen.add(text);
    return [{ text, tool: message.toolName, time: message.createdAt }];
  });
  return <article aria-label="Execution failure summary" className="max-w-[88%] rounded-xl border border-red-400/25 bg-red-400/[0.04] px-4 py-3 text-xs">
    <h3 className="font-semibold text-app-primary">{stopped ? copy.title : task.status === 'done' ? '任务已完成，以下为历史重试记录' : '此前执行遇到问题'}</h3>
    <p className="mt-1.5 leading-5 text-app-secondary">{stopped ? copy.body : '历史错误不代表当前执行状态，展开可查看详情。'}</p>
    {!loaded && <button type="button" onClick={() => void loadArchived()} disabled={loading} className="app-focus mt-2 text-accent-light disabled:opacity-50">
      {loading ? '读取归档资料…' : '查看完整归档资料'}
    </button>}
    {loaded && evidence.length === 0 && <p className="mt-2 text-app-muted">没有可恢复的成功查询资料。</p>}
    {archiveError && <p role="alert" className="mt-2 text-red-500">{archiveError}</p>}
    {evidence.length > 0 && <details className="mt-3 rounded-lg border border-border bg-surface p-3">
      <summary className="app-focus cursor-pointer font-medium text-app-primary">已收集资料 · {evidence.length} 份（非最终答案）</summary>
      <p className="my-2 text-app-muted">以下是工具返回的来源线索，内容及价格尚未独立核实，不能视为任务已完成。</p>
      <div className="max-h-96 space-y-4 overflow-y-auto">
        {evidence.map((item, index) => <section key={index}>
          <p className="mb-2 text-app-muted">{item.tool} · {item.time}</p>
          <EvidenceContent content={item.text} />
        </section>)}
      </div>
    </details>}
    <details className="mt-3 text-app-muted">
      <summary className="app-focus cursor-pointer">错误与重试详情</summary>
      <div className="mt-2 max-h-60 space-y-2 overflow-y-auto">
        {[...new Set([...errors.map(error => error.content), task.error].filter(Boolean))].map((error, index) =>
          <pre key={index} className="whitespace-pre-wrap break-words text-[11px]">{error}</pre>)}
      </div>
    </details>
    {stopped && <div className="mt-3 flex gap-4">
      {copy.models && <button type="button" onClick={onModels} className="app-focus text-accent-light">模型设置</button>}
      {onRetry && <button type="button" onClick={onRetry} disabled={retrying} className="app-focus text-accent-light disabled:opacity-50">{retrying ? '正在重试…' : '重试本次任务'}</button>}
      <button type="button" onClick={onContinue} className="app-focus text-accent-light">填写继续指令</button>
    </div>}
  </article>;
}
