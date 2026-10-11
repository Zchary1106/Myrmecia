import { useEffect, useState } from 'react';
import type { AgentBudgetLimits, AgentBudgetState, BudgetUsageSummary } from '@myrmecia/shared';
import { api } from '../../lib/api';

export function BudgetUsage({ usage }: { usage: BudgetUsageSummary[] }) {
  return <div className="space-y-3 text-xs" aria-label="Budget usage">
    {!usage.length && <p className="text-app-muted">尚无预算记账；不表示免费或已验证用量。</p>}
    {usage.map(item => <div key={`${item.scope}:${item.scopeId}`} className="rounded-lg bg-surface p-3">
      <p>{item.scope} · {item.period === 'utc_day' ? `UTC 日 ${item.periodStart?.slice(0, 10)}（至 ${item.periodEnd}）` : '累计生命周期 · 不随刷新或恢复重置'}</p>
      <dl className="mt-2 grid grid-cols-3 gap-2">
        <div><dt>已观察 Tokens</dt><dd>{item.observed.tokens}</dd></div>
        <div><dt>预留 Tokens</dt><dd>{item.reserved.tokens}</dd></div>
        <div><dt>剩余 Tokens</dt><dd>{item.remaining.tokens ?? '未设上限'}</dd></div>
        <div><dt>已派发工具</dt><dd>{item.observed.toolCalls}</dd></div>
        <div><dt>预留工具</dt><dd>{item.reserved.toolCalls}</dd></div>
        <div><dt>剩余工具</dt><dd>{item.remaining.toolCalls ?? '未设上限'}</dd></div>
      </dl>
      <p className="mt-2">{item.unknownCost > 0 ? `费用尚未完整确认 · 已记录部分 $${item.observed.costUSD.toFixed(4)}`
        : `${item.estimatedCost ? '估算费用' : '已记录费用'} $${item.observed.costUSD.toFixed(4)}`}
        {' · '}预留 ${item.reserved.costUSD.toFixed(4)}
        {' · '}剩余额度 {item.remaining.costUSD === null ? '未设上限' : item.unknownCost > 0 ? '不可确认（硬美元上限不允许继续派发）' : `$${item.remaining.costUSD.toFixed(4)}`}</p>
      {(item.unknownCost > 0 || item.unknownTokens > 0) && <p className="mt-1 text-amber-500">未知费用 {item.unknownCost} 次 · 未确认 Tokens {item.unknownTokens} 次。订阅不等于零成本；未确认用量保留预留。</p>}
    </div>)}
  </div>;
}
const defaults: AgentBudgetLimits = { maxTurns: 50, timeoutSeconds: 300, maxConcurrent: 1, period: 'lifetime' };
export function AgentBudgetEditor({ agentId }: { agentId: string }) {
  const [state, setState] = useState<AgentBudgetState>();
  const [form, setForm] = useState<AgentBudgetLimits>(defaults);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  useEffect(() => {
    let disposed = false;
    setState(undefined); setError(''); setNeedsReload(false);
    api.agents.budget.get(agentId).then(value => { if (!disposed) { setState(value); setForm(value.limits || defaults); } })
      .catch(() => { if (!disposed) setError('预算读取失败，尚不能保存。'); });
    return () => { disposed = true; };
  }, [agentId]);
  const save = async () => {
    if (!state || busy) return;
    setBusy(true); setError('');
    try { const next = await api.agents.budget.save(agentId, state.revision, form); setState(next); }
    catch (error) {
      setError(error instanceof Error ? error.message : '保存失败，请重新读取版本后再试。');
      if (error instanceof Error && /changed|CONFLICT|reload/i.test(error.message)) setNeedsReload(true);
    }
    finally { setBusy(false); }
  };
  return <section aria-label="Agent budget editor" className="space-y-3 rounded-xl bg-background/70 p-4">
    <h4 className="font-semibold">执行限额与预算</h4>
    <p className="text-xs text-app-muted">服务端执行上限；全局与工作区更严格的限制优先。配置修改不重置用量，不修改已有任务快照。已发布 Agent 的运行配置变更需重新发布；Agent 总预算立即生效。</p>
    <div className="grid grid-cols-2 gap-3 text-xs">
      {([{ key: 'maxTurns', label: '最大轮数', min: 1, max: 200 }, { key: 'timeoutSeconds', label: '超时（秒）', min: 10, max: 3600 },
        { key: 'maxConcurrent', label: '最大并发', min: 1, max: 8 }, { key: 'maxTokens', label: 'Token 配额', min: 1, max: 1e9 },
        { key: 'maxToolCalls', label: '工具调用配额', min: 1, max: 1e6 }, { key: 'maxCostUSD', label: '美元硬上限', min: 0.0001, max: 1e6 }] as const).map(field =>
        <label key={field.key}>{field.label}<input aria-label={field.label} type="number" min={field.min} max={field.max}
          step={field.key === 'maxCostUSD' ? 'any' : 1} value={form[field.key] ?? ''} disabled={busy}
          className="app-focus mt-1 w-full rounded-lg bg-surface px-3 py-2"
          onChange={event => setForm(current => ({ ...current, [field.key]: event.target.value === '' ? undefined : Number(event.target.value) }))} /></label>)}
      <label>配额周期<select aria-label="配额周期" value={form.period} disabled={busy}
        className="app-focus mt-1 w-full rounded-lg bg-surface px-3 py-2"
        onChange={event => setForm(current => ({ ...current, period: event.target.value as AgentBudgetLimits['period'] }))}>
        <option value="lifetime">累计生命周期</option><option value="utc_day">UTC 自然日</option>
      </select></label>
    </div>
    <p className="text-xs text-app-muted">留空的可选配额不设额外上限。未知价格/订阅模型不能在硬美元上限下派发；Provider 自带循环不能保证这些限制时会明确拒绝。</p>
    <p className="text-xs text-app-muted">美元限额按已配置价格估算并预留，不是服务商最终账单保证；Token 输入计量也包含估算。</p>
    {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
    <button type="button" disabled={!state || busy || needsReload} onClick={() => void save()} className="app-focus rounded-lg bg-surface px-3 py-2 text-xs disabled:opacity-40">{busy ? '保存中…' : `保存预算 · r${state?.revision ?? '—'}`}</button>
    <button type="button" disabled={busy} onClick={() => {
      if (needsReload && !window.confirm('重新读取预算会替换尚未保存的表单，继续？')) return;
      const replaceForm = needsReload;
      setBusy(true);
      api.agents.budget.get(agentId).then(next => {
        if (replaceForm) {
          setState(next); setForm(next.limits || defaults); setNeedsReload(false); setError('');
        } else {
          // Refresh usage without discarding edits or adopting a newer revision
          // that would let stale form values overwrite another operator's edit.
          setState(current => current ? { ...current, usage: next.usage } : next);
          if (state && next.revision !== state.revision) {
            setNeedsReload(true); setError('预算版本已变更；已保留表单，请重新读取预算后再保存。');
          }
        }
      })
        .catch(() => setError('重新读取失败；保留未保存的表单。')).finally(() => setBusy(false));
    }} className="app-focus ml-2 rounded-lg px-3 py-2 text-xs">{needsReload ? '重新读取预算' : '刷新用量'}</button>
    {state && <BudgetUsage usage={state.usage} />}
  </section>;
}
