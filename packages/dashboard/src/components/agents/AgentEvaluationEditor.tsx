import { useEffect, useRef, useState } from 'react';
import type { AgentConfigHistory, AgentEvaluationCase, AgentEvaluationSuite, AgentEvaluationSuiteInput, AgentEvaluationRun, CompletionCriterion } from '@myrmecia/shared';
import { api, ApiError } from '../../lib/api';
import { AgentEvaluationResults } from './AgentEvaluationResults';

const inputClass = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';
const newCase = (): AgentEvaluationCase => ({ id: crypto.randomUUID(), name: '新用例', prompt: '',
  checks: [{ id: crypto.randomUUID(), label: '期望包含', required: true, verifier: 'output_contains', text: '' }] });
const defaultSuite = (): AgentEvaluationSuiteInput => ({ name: 'Agent 回归测试', cases: [newCase()] });
const labels: Record<CompletionCriterion['verifier'], string> = {
  output_contains: '包含文本', output_not_contains: '不包含文本', output_json_schema: 'JSON Schema',
  artifact: '必需产物', test_command: '工作区测试命令', human_review: '人工质量标准', external: '外部检查（未配置）',
};
function changeRule(check: CompletionCriterion, verifier: CompletionCriterion['verifier']): CompletionCriterion {
  const base = { id: check.id, label: labels[verifier], required: check.required };
  if (verifier === 'artifact') return { ...base, verifier, relativePath: 'result.md' };
  if (verifier === 'test_command') return { ...base, verifier, command: 'pnpm test', timeoutMs: 60_000 };
  if (verifier === 'output_json_schema') return { ...base, verifier, schema: { type: 'object', properties: {}, additionalProperties: false } };
  if (verifier === 'human_review') return { ...base, verifier, rubric: '' };
  if (verifier === 'external') return { ...base, verifier, verifierId: '' };
  return { ...base, verifier, text: '' };
}

function RuleEditor({ check, onChange }: { check: CompletionCriterion; onChange: (value: CompletionCriterion) => void }) {
  const [schemaText, setSchemaText] = useState(check.verifier === 'output_json_schema' ? JSON.stringify(check.schema, null, 2) : '');
  const [schemaError, setSchemaError] = useState('');
  return <div className="space-y-2 rounded-lg bg-background/50 p-2">
    <div className="flex flex-wrap gap-2">
      <select aria-label="检查类型" className={inputClass + ' flex-1'} value={check.verifier}
        onChange={event => {
          const next = changeRule(check, event.target.value as CompletionCriterion['verifier']);
          onChange(next); setSchemaError('');
          if (next.verifier === 'output_json_schema') setSchemaText(JSON.stringify(next.schema, null, 2));
        }}>
        {Object.entries(labels).filter(([id]) => id !== 'external').map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={check.required}
        onChange={event => onChange({ ...check, required: event.target.checked })} />必须</label>
    </div>
    <input aria-label="检查名称" value={check.label} maxLength={200} className={inputClass}
      onChange={event => onChange({ ...check, label: event.target.value })} />
    {(check.verifier === 'output_contains' || check.verifier === 'output_not_contains') &&
      <textarea aria-label="期望文本" value={check.text} maxLength={2000} rows={2} className={inputClass}
        onChange={event => onChange({ ...check, text: event.target.value })} />}
    {check.verifier === 'artifact' && <input aria-label="产物相对路径" value={check.relativePath} maxLength={500}
      className={inputClass} onChange={event => onChange({ ...check, relativePath: event.target.value })} />}
    {check.verifier === 'test_command' && <><input aria-label="测试命令" value={check.command} maxLength={500} className={inputClass}
      placeholder="pnpm --filter @app/server test / python -m pytest / go test ./... / cargo test"
      onChange={event => onChange({ ...check, command: event.target.value })} />
    <p className="text-xs text-amber-600">只接受有界的测试、构建、lint/typecheck 命令，不允许任意 Shell、安装或部署。会执行项目代码，有副作用；任务目录不等同操作系统隔离，运行前需确认。</p></>}
    {check.verifier === 'human_review' && <textarea aria-label="人工审查标准" value={check.rubric} maxLength={2000}
      rows={2} className={inputClass} onChange={event => onChange({ ...check, rubric: event.target.value })} />}
    {check.verifier === 'output_json_schema' && <><textarea aria-label="JSON Schema" value={schemaText} maxLength={16000}
      rows={5} className={inputClass + ' font-mono'} onChange={event => {
        setSchemaText(event.target.value);
        try {
          const schema = JSON.parse(event.target.value);
          onChange({ ...check, schema }); setSchemaError('');
        } catch { onChange({ ...check, schema: {} }); setSchemaError('JSON 无效，保存前请修正。'); }
      }} />
      <p className="text-xs text-app-muted">支持有界结构、类型、必填字段、长度与数值范围；不支持正则、引用或远程 Schema。</p>
      {schemaError && <p role="alert" className="text-xs text-red-600">{schemaError}</p>}</>}
  </div>;
}

export function AgentEvaluationEditor({ agentId }: { agentId: string }) {
  const [suites, setSuites] = useState<AgentEvaluationSuite[]>([]);
  const [suiteId, setSuiteId] = useState<string>(() => crypto.randomUUID());
  const [draft, setDraft] = useState<AgentEvaluationSuiteInput>(defaultSuite);
  const [saved, setSaved] = useState<AgentEvaluationSuite>();
  const [selected, setSelected] = useState<string[]>([]);
  const [config, setConfig] = useState<AgentConfigHistory>();
  const [versionId, setVersionId] = useState('');
  const [history, setHistory] = useState<AgentEvaluationRun[]>([]);
  const [run, setRun] = useState<AgentEvaluationRun>();
  const [compareId, setCompareId] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const acting = useRef(false);
  const request = useRef<{ key: string; suiteId: string; data: { selectedCaseIds: string[]; expectedSuiteRevision: number; configVersionId: string } } | undefined>(undefined);
  const dirty = !saved || JSON.stringify({ name: saved.name, cases: saved.cases }) !== JSON.stringify(draft);
  useEffect(() => {
    let disposed = false;
    void Promise.all([api.agents.evaluations.suites(agentId), api.agents.versions.list(agentId), api.agents.evaluations.history(agentId)])
      .then(([items, versions, runs]) => {
        if (disposed) return;
        setSuites(items); setConfig(versions); setVersionId(versions.activeVersionId || versions.versions[0]?.id || ''); setHistory(runs); setHasMore(runs.length === 30);
        if (items[0]) selectSuite(items[0]);
        if (runs[0]) {
          setRun(runs[0]);
          void api.agents.evaluations.get(agentId, runs[0].id).then(current => {
            if (!disposed) setRun(current);
          }).catch(() => { if (!disposed) setError('无法读取完整检查记录；选择测试历史可重试。'); });
        }
      }).catch(() => { if (!disposed) setError('无法读取测试套件，请重试。'); });
    return () => { disposed = true; };
  }, [agentId]);
  // Poll only reads persisted status/evidence, never runs the next case.
  useEffect(() => {
    if (!run || !run.results.some(result => result.taskId && ['pending', 'running'].includes(result.status))) return;
    let disposed = false, reading = false;
    const refresh = async () => {
      if (reading) return; reading = true;
      try {
        const current = await api.agents.evaluations.get(agentId, run.id);
        if (!disposed) { setRun(current); setHistory(items => items.map(item => item.id === current.id ? current : item)); }
      } catch { if (!disposed) setError('状态同步失败，保留已有记录；刷新不会重新运行。'); }
      finally { reading = false; }
    };
    const timer = setInterval(() => void refresh(), 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [agentId, run?.id, run?.results.map(result => result.status).join(',')]);
  function selectSuite(suite: AgentEvaluationSuite) {
    setSuiteId(suite.id); setSaved(suite); setDraft({ name: suite.name, cases: suite.cases });
    setSelected(suite.cases.map(item => item.id)); setError('');
  }
  async function action(fn: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true); setError('');
    try { await fn(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败，请重试'); }
    finally { acting.current = false; setBusy(false); }
  }
  async function save() {
    const current = await api.agents.evaluations.save(agentId, suiteId, { ...draft, expectedRevision: saved?.revision || 0 });
    selectSuite(current);
    setSuites(items => [current, ...items.filter(item => item.id !== current.id)]);
  }
  function remember(current: AgentEvaluationRun) {
    setRun(current); setHistory(items => [current, ...items.filter(item => item.id !== current.id)]);
  }
  async function start(retry = false) {
    if (!retry) {
      if (!saved || dirty || !versionId || !selected.length) return;
      if (!window.confirm(`将使用选中的 Agent 配置版本运行 ${selected.length} 条用例（逐条确认推进），可能消耗模型额度和调用工具。含测试命令的用例会执行工作区脚本。是否继续？`)) return;
      request.current = { key: crypto.randomUUID(), suiteId: saved.id, data: { selectedCaseIds: selected,
        expectedSuiteRevision: saved.revision, configVersionId: versionId } };
    }
    if (!request.current) return;
    setUncertain(true);
    try {
      const current = await api.agents.evaluations.start(agentId, request.current.suiteId, request.current.data, request.current.key);
      remember(current); setUncertain(false); request.current = undefined;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) {
        setUncertain(false); request.current = undefined;
      }
      throw cause;
    }
  }
  const updateCase = (id: string, change: Partial<AgentEvaluationCase>) => setDraft(value => ({
    ...value, cases: value.cases.map(item => item.id === id ? { ...item, ...change } : item),
  }));
  return <section aria-label="Agent evaluation suites" className="space-y-4 rounded-xl border border-border bg-surface/40 p-4">
    <div><h3 className="text-sm font-semibold">测试用例与版本对比</h3>
      <p className="mt-1 text-xs text-app-muted">保存可复用检查，锁定 Agent 版本。最多 20 条用例，每条 20 项检查；语义质量需人工审查。</p></div>
    <button type="button" disabled={busy || uncertain} className="app-focus rounded-lg px-2 py-1 text-xs text-app-secondary"
      onClick={() => void action(async () => {
        const [versions, items, runs] = await Promise.all([api.agents.versions.list(agentId),
          api.agents.evaluations.suites(agentId), api.agents.evaluations.history(agentId)]);
        setConfig(versions); setSuites(items); setHistory(runs); setHasMore(runs.length === 30);
        if (!versionId) setVersionId(versions.activeVersionId || versions.versions[0]?.id || '');
        if (run) setRun(await api.agents.evaluations.get(agentId, run.id));
      })}>刷新版本与测试历史</button>
    {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
    <fieldset disabled={busy || uncertain} className="space-y-3">
      <div className="flex gap-2"><select aria-label="选择测试套件" className={inputClass} value={saved?.id || ''}
        onChange={event => { const item = suites.find(item => item.id === event.target.value); if (item) selectSuite(item); }}>
        <option value="">新测试套件</option>{suites.map(item => <option key={item.id} value={item.id}>{item.name} · r{item.revision}</option>)}
      </select><button type="button" className="app-focus shrink-0 rounded-lg px-3 text-sm" onClick={() => {
        setSuiteId(crypto.randomUUID()); setSaved(undefined); setDraft(defaultSuite()); setSelected([]);
      }}>新建</button></div>
      <input aria-label="套件名称" className={inputClass} value={draft.name} maxLength={120}
        onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} />
      {draft.cases.map((test, index) => <details key={test.id} open={index === 0} className="rounded-lg border border-border p-3">
        <summary className="app-focus cursor-pointer text-sm">{test.name || `用例 ${index + 1}`} · {test.checks.length} 项检查</summary>
        <div className="mt-3 space-y-2">
          <input aria-label={`用例 ${index + 1} 名称`} value={test.name} maxLength={120} className={inputClass}
            onChange={event => updateCase(test.id, { name: event.target.value })} />
          <textarea aria-label={`用例 ${index + 1} 指令`} value={test.prompt} maxLength={8000} rows={3} className={inputClass}
            onChange={event => updateCase(test.id, { prompt: event.target.value })} />
          {test.checks.map(check => <div key={check.id}><RuleEditor check={check} onChange={next =>
            updateCase(test.id, { checks: test.checks.map(item => item.id === check.id ? next : item) })} />
            <button type="button" disabled={test.checks.length <= 1} className="app-focus px-2 py-1 text-xs text-app-muted disabled:opacity-40"
              onClick={() => updateCase(test.id, { checks: test.checks.filter(item => item.id !== check.id) })}>移除检查</button>
          </div>)}
          <div className="flex gap-2 text-xs">
            <button type="button" disabled={test.checks.length >= 20} className="app-focus rounded-lg px-2 py-1 disabled:opacity-40"
              onClick={() => updateCase(test.id, { checks: [...test.checks, newCase().checks[0]] })}>添加检查</button>
            <button type="button" disabled={draft.cases.length <= 1} className="app-focus rounded-lg px-2 py-1 disabled:opacity-40"
              onClick={() => setDraft(value => ({ ...value, cases: value.cases.filter(item => item.id !== test.id) }))}>移除用例</button>
          </div>
        </div>
      </details>)}
      <div className="flex gap-2"><button type="button" disabled={draft.cases.length >= 20} className="app-focus rounded-lg px-3 py-2 text-sm"
        onClick={() => setDraft(value => ({ ...value, cases: [...value.cases, newCase()] }))}>添加用例</button>
        <button type="button" className="app-focus rounded-lg bg-accent/10 px-3 py-2 text-sm" onClick={() => void action(save)}>保存套件</button>
      </div>
      {saved && !dirty && <>
        <select aria-label="测试配置版本" value={versionId} className={inputClass} onChange={event => setVersionId(event.target.value)}>
          <option value="">选择已保存配置版本</option>{config?.versions.map(version =>
            <option key={version.id} value={version.id}>Agent v{version.sequence} · {version.snapshot.config.model || '自动路由'}</option>)}
        </select>
        <div className="flex flex-wrap gap-3 text-xs">{saved.cases.map(test => <label key={test.id} className="flex items-center gap-1">
          <input type="checkbox" checked={selected.includes(test.id)} onChange={event => setSelected(ids => event.target.checked ?
            saved.cases.filter(item => item.id === test.id || ids.includes(item.id)).map(item => item.id) : ids.filter(id => id !== test.id))} />{test.name}
        </label>)}</div>
        <button type="button" disabled={!versionId || !selected.length} className="app-focus rounded-lg bg-accent/10 px-3 py-2 text-sm disabled:opacity-40"
          onClick={() => void action(() => start())}>运行选中用例</button>
      </>}
      {dirty && <p className="text-xs text-app-muted">先保存用例，再选择版本运行；编辑不会改变历史测试。</p>}
    </fieldset>
    {uncertain && <div className="space-y-2 text-xs"><p>提交响应未确认，编辑已暂时锁定。请用同一请求恢复，不会创建重复任务或启动下一条。</p>
      <button disabled={busy} onClick={() => void action(() => start(true))} className="app-focus rounded-lg bg-surface px-3 py-2">恢复本次提交</button></div>}
    {!!history.length && <div className="grid gap-2 md:grid-cols-2">
      <select aria-label="测试历史" className={inputClass} value={run?.id || ''} disabled={busy}
        onChange={event => void action(async () => remember(await api.agents.evaluations.get(agentId, event.target.value)))}>
        {history.map(item => <option key={item.id} value={item.id}>{item.suiteSnapshot.name} · Agent v{item.configSequence} · {item.createdAt}</option>)}
      </select>
      <select aria-label="对比测试" className={inputClass} value={compareId} onChange={event => setCompareId(event.target.value)}>
        <option value="">不对比</option>{history.filter(item => item.id !== run?.id).map(item =>
          <option key={item.id} value={item.id}>{item.suiteSnapshot.name} · Agent v{item.configSequence} · {item.createdAt}</option>)}
      </select>
    </div>}
    {hasMore && <button type="button" disabled={busy} className="app-focus rounded-lg px-3 py-2 text-xs"
      onClick={() => void action(async () => {
        const items = await api.agents.evaluations.history(agentId, history.length);
        setHasMore(items.length === 30);
        setHistory(previous => [...previous, ...items.filter(item => !previous.some(prior => prior.id === item.id))]);
      })}>加载更早的测试</button>}
    {run && <AgentEvaluationResults run={run} compare={history.find(item => item.id === compareId)} busy={busy}
      onNext={caseId => void action(async () => {
        if (!window.confirm('运行下一条选中用例？将消耗模型额度，并可能调用其配置的工具。')) return;
        remember(await api.agents.evaluations.next(agentId, run.id, caseId));
      })} />}
  </section>;
}
