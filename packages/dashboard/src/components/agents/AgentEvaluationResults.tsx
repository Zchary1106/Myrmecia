import { useState } from 'react';
import type { AgentEvaluationRun } from '@myrmecia/shared';
import { MarkdownMessage } from '../common/MarkdownMessage';
import { useStore } from '../../stores/store';
import { AgentSetupDebug } from './AgentSetupDebug';

const statusLabels = { pending: '待运行', running: '运行中', passed: '通过', failed: '失败', unavailable: '不可用 / 待人工审查' };
const transportLabels = { fixture: 'Fixture 模拟模型', real_model: '真实模型', unknown: '模型来源尚未确认' };

export function AgentEvaluationResults({ run, compare, busy, onNext }: {
  run: AgentEvaluationRun; compare?: AgentEvaluationRun; busy: boolean; onNext: (caseId: string) => void;
}) {
  const [debugTask, setDebugTask] = useState<string>();
  const next = run.results.find(item => item.status === 'pending' || item.status === 'running');
  const comparable = compare && compare.suiteHash === run.suiteHash
    && compare.selectedCaseIds.join('\0') === run.selectedCaseIds.join('\0');
  return <section aria-label="Evaluation results" className="space-y-3">
    <p className="text-xs text-app-muted">套件 r{run.suiteRevision} · Agent v{run.configSequence} · {run.configHash.slice(0, 12)}
      {' · '}执行成功 ≠ 检查通过 ≠ 人工验收</p>
    <div className="flex flex-wrap gap-3 text-xs" aria-label="Evaluation counts">
      {Object.entries(run.counts).map(([status, count]) => <span key={status}>{statusLabels[status as keyof typeof statusLabels]} {count}</span>)}
    </div>
    {compare && <div className="rounded-lg bg-background p-3 text-xs">
      <p>对比 Agent v{compare.configSequence} → v{run.configSequence}</p>
      {!comparable ? <p className="text-amber-600">用例内容或选择范围不同，不作为版本回归结论。</p> :
        <div className="mt-2 overflow-x-auto"><table className="w-full text-left">
          <thead><tr><th className="py-1">用例</th><th>旧结果</th><th>当前结果</th></tr></thead>
          <tbody>{run.results.map(result => {
            const prior = compare.results.find(item => item.caseId === result.caseId);
            return <tr key={result.caseId}><td className="py-1">{run.suiteSnapshot.cases.find(item => item.id === result.caseId)?.name}</td>
              <td>{prior ? <>{statusLabels[prior.status]}<small className="block text-app-muted">
                {transportLabels[prior.transport]} · {prior.actualModel || '模型未确认'}</small></> : '未运行'}</td>
              <td>{statusLabels[result.status]}<small className="block text-app-muted">
                {transportLabels[result.transport]} · {result.actualModel || '模型未确认'}</small></td></tr>;
          })}</tbody>
        </table></div>}
      <p className="mt-2 text-app-muted">Fixture 与真实模型、不同模型来源或未完成用例需分别解释；本表不是主观质量评分。</p>
    </div>}
    {run.results.map(result => <article key={result.caseId} className="space-y-2 rounded-lg border border-border p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium">{run.suiteSnapshot.cases.find(item => item.id === result.caseId)?.name} · {statusLabels[result.status]}</h4>
        <span className="text-app-muted">{transportLabels[result.transport]}</span>
      </div>
      <p className="text-app-muted">请求模型：{result.requestedModel || '待调度'} · 实际模型：{result.actualModel || '尚未确认'}</p>
      {result.humanReviewRequired && <p className="text-amber-600">含主观质量标准，必须人工审查，不会自动判定业务验收通过。</p>}
      {result.message && <p className="break-words">{result.message}</p>}
      {result.verification && <ul className="space-y-2">
        {result.verification.criteria.map(check => <li key={check.criterionId}>
          <p>{run.suiteSnapshot.cases.find(item => item.id === result.caseId)?.checks.find(item => item.id === check.criterionId)?.label}
            {' · '}{statusLabels[check.status]}{check.required ? ' · 必须' : ' · 可选'}</p>
          <p className="text-app-muted">{check.message}</p>
          {check.evidence.map(evidence => <details key={evidence.ref} className="mt-1">
            <summary className="app-focus cursor-pointer">证据与 SHA-256</summary>
            <p className="mt-1 break-all">{evidence.ref}</p><p className="break-all text-app-muted">{evidence.sha256}</p>
          </details>)}
        </li>)}
      </ul>}
      {result.output && <details><summary className="app-focus cursor-pointer">查看完整回复</summary>
        <div className="mt-2 min-w-0 text-sm"><MarkdownMessage content={result.output} executionId={result.executionId} /></div>
      </details>}
      {result.resultSha256 && <details><summary className="app-focus cursor-pointer">已保存检查记录</summary>
        <p className="mt-1 break-all text-app-muted">{result.checkedAt} · {result.resultSha256}</p>
      </details>}
      {result.taskId && <div className="flex gap-2">
        <button type="button" className="app-focus rounded px-2 py-1 text-app-secondary"
          onClick={() => setDebugTask(current => current === result.taskId ? undefined : result.taskId)}>调试此用例</button>
        <button type="button" className="app-focus rounded px-2 py-1 text-app-secondary" onClick={() => {
          useStore.getState().setSelectedTaskId(result.taskId!); useStore.getState().setActiveView('session');
        }}>打开完整会话</button>
        <button type="button" className="app-focus rounded px-2 py-1 text-app-secondary" onClick={() => {
          useStore.getState().setSelectedTaskId(result.taskId!); useStore.getState().setActiveView('artifacts');
        }}>查看 / 下载产物</button>
      </div>}
      {result.taskId && debugTask === result.taskId && <AgentSetupDebug key={result.taskId} taskId={result.taskId}
        agentName={run.suiteSnapshot.cases.find(item => item.id === result.caseId)?.name || 'Agent'} />}
    </article>)}
    {next && <button type="button" disabled={busy || next.status === 'running'} onClick={() => onNext(next.caseId)}
      className="app-focus rounded-lg bg-accent/10 px-3 py-2 text-sm disabled:opacity-40">
      {next.taskId ? '重试提交同一用例' : '运行下一条'}
    </button>}
  </section>;
}
