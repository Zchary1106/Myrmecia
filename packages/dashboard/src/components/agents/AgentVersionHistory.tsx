import { useEffect, useState } from 'react';
import type { AgentConfigHistory, AgentConfigVersion, AgentSetupPreflight } from '@myrmecia/shared';
import { api } from '../../lib/api';

const fieldLabels: Record<string, string> = {
  name: '名称', role: '角色', emoji: '图标', description: '职责简介', whenToUse: '调用条件',
  capabilities: '能力', triggers: '触发条件', systemInstructions: '系统指令', contract: '职责契约',
  config: '模型与运行限制', allowedTools: '工具范围', disallowedTools: '禁用工具', skill: 'Skill', domain: '领域与知识引用', knowledge: 'Agent 私有知识绑定',
};
function summary(version: AgentConfigVersion) {
  const value = version.snapshot;
  return `${value.config.model || '路由选择'} · ${value.skill?.versionId || (value.skill ? '文件 Skill' : '内联指令')} · ${value.allowedTools.length} 个声明工具`;
}

export function AgentVersionHistory({ agentId }: { agentId: string }) {
  const [history, setHistory] = useState<AgentConfigHistory>();
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<{ id: string; hash: string; preflight: AgentSetupPreflight }>();
  useEffect(() => {
    let stopped = false;
    setHistory(undefined); setSelectedId(''); setChecked(undefined); setError(''); setNotice('');
    void api.agents.versions.list(agentId).then(value => { if (!stopped) setHistory(value); })
      .catch(err => { if (!stopped) setError(err.message || '版本读取失败'); });
    return () => { stopped = true; };
  }, [agentId]);
  const selected = history?.versions.find(version => version.id === selectedId);
  const active = history?.versions.find(version => version.id === history.activeVersionId);
  const reload = async () => {
    setBusy(true); setChecked(undefined); setError('');
    try { setHistory(await api.agents.versions.list(agentId)); }
    catch (err) { setError(err instanceof Error ? err.message : '版本读取失败'); }
    finally { setBusy(false); }
  };
  const preflight = async (id: string) => {
    if (!history) return;
    setBusy(true); setError(''); setChecked(undefined);
    try {
      const result = await api.agents.versions.preflight(agentId, id);
      setChecked({ id, hash: history.workingConfigHash, preflight: result });
    } catch (err) { setError(err instanceof Error ? err.message : '预检失败'); }
    finally { setBusy(false); }
  };
  const activate = async (version?: AgentConfigVersion) => {
    if (!history || !checked || checked.id !== (version?.id || 'working') || !checked.preflight.canTest) return;
    const detail = version ? `将后续任务切换到 v${version.sequence}（${summary(version)}）。` : '发布当前工作配置，供后续任务使用。';
    if (!window.confirm(`${detail}\n排队、运行、暂停的任务保留原快照。回滚不会恢复已撤销权限或删除的知识。继续？`)) return;
    setBusy(true); setError('');
    try {
      const expected = { expectedCurrentVersionId: history.activeVersionId, expectedConfigHash: history.workingConfigHash };
      const result = version ? await api.agents.versions.rollback(agentId, version.id, expected)
        : await api.agents.versions.publish(agentId, expected);
      setHistory(await api.agents.versions.list(agentId)); setChecked(undefined);
      setNotice(`已${version ? '切换' : '发布'} v${result.sequence}；仅影响后续任务。`);
    } catch (err) { setError(err instanceof Error ? err.message : '发布失败，请刷新版本后重试'); }
    finally { setBusy(false); }
  };
  return <section aria-label="Agent 配置版本" className="space-y-3 rounded-xl border border-border bg-surface p-4">
    <header className="flex flex-wrap justify-between gap-2">
      <h3 className="text-sm font-semibold">配置版本与回滚</h3>
      <button type="button" disabled={busy} onClick={() => void reload()} className="app-focus rounded px-2 py-1 text-xs text-accent-light">刷新版本</button>
    </header>
    <p className="text-xs text-app-muted">编辑的是工作副本；发布后的配置固定到新任务。运行结束不等于验收通过。</p>
    {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
    {notice && <p role="status" className="text-xs text-app-secondary">{notice}</p>}
    {!history ? <p className="text-xs text-app-muted">尚未读取版本，或配置依赖不可用。</p> : <>
      <p className="text-xs">后续任务：{active ? `已发布 v${active.sequence} · ${summary(active)}` : '未发布 · 使用当前配置（历史任务不补造版本）'}</p>
      <p className="text-xs text-app-muted">工作副本变化：{history.workingChanges.map(key => fieldLabels[key] || (key === 'unpublished' ? '首次发布' : key === 'unavailable' ? '当前配置依赖不可用' : key)).join('、') || '与已发布版本相同'}</p>
      {history.workingError && <p className="text-xs text-amber-600">工作副本不可发布：{history.workingError}。仍可检查和恢复可用历史版本。</p>}
      <div className="flex flex-wrap gap-2">
        <button disabled={busy} onClick={() => void preflight('working')} className="app-focus rounded-lg bg-background px-3 py-2 text-xs">检查工作配置</button>
        <button disabled={busy || !!history.workingError || checked?.id !== 'working' || !checked.preflight.canTest || checked.hash !== history.workingConfigHash}
          onClick={() => void activate()} className="app-focus rounded-lg bg-accent px-3 py-2 text-xs text-white disabled:opacity-40">发布工作配置</button>
      </div>
      <div className="space-y-2">
        {history.versions.map(version => <button key={version.id} disabled={busy} onClick={() => {
          setSelectedId(version.id); setChecked(undefined);
        }} className={`app-focus block w-full rounded-lg border px-3 py-2 text-left text-xs ${version.id === selectedId ? 'border-accent' : 'border-border'}`}>
          <span className="font-medium">v{version.sequence}{version.id === history.activeVersionId ? ' · 当前发布' : ''}</span>
          <span className="ml-2 text-app-muted">{version.origin === 'task_snapshot' ? '任务固定快照' : '发布快照'} · {summary(version)}</span>
        </button>)}
        {!history.versions.length && <p className="text-xs text-app-muted">尚无配置版本。旧任务显示为 legacy，不会伪造历史。</p>}
      </div>
      {selected && <div className="space-y-3 rounded-lg bg-background p-3 text-xs">
        <p className="font-medium">查看 v{selected.sequence} · 与当前发布版本对比</p>
        <p className="break-all text-app-muted">SHA-256：{selected.configHash}</p>
        <dl className="grid gap-2 md:grid-cols-2">
          <div><dt className="text-app-muted">模型</dt><dd>{selected.snapshot.config.model || '自动路由（实际模型以执行记录为准）'}</dd></div>
          <div><dt className="text-app-muted">运行限制</dt><dd>{selected.snapshot.config.maxTurns || '默认'} 轮 · {selected.snapshot.config.timeout || '默认'} 秒 · 并发 {selected.snapshot.config.maxConcurrent || 1}</dd></div>
          <div><dt className="text-app-muted">Skill</dt><dd>{selected.snapshot.skill?.versionId || selected.snapshot.skill?.sourcePath || '内联指令'}</dd></div>
          <div><dt className="text-app-muted">知识引用</dt><dd>{selected.snapshot.domain ? `${selected.snapshot.domain.id} · ${selected.snapshot.domain.knowledgeIds.length} 个引用` : '未绑定领域知识'}</dd></div>
          <div><dt className="text-app-muted">私有知识</dt><dd>{selected.snapshot.knowledge?.length || 0} 个固定绑定 · Team / 会话来源以运行记录为准</dd></div>
        </dl>
        <p>变化字段：{active ? Object.keys(selected.snapshot).filter(key =>
          JSON.stringify((selected.snapshot as any)[key]) !== JSON.stringify((active.snapshot as any)[key]))
          .map(key => fieldLabels[key] || key).join('、') || '无' : '尚无已发布版本可对比'}</p>
        <details><summary className="app-focus cursor-pointer text-app-secondary">查看职责与指令</summary>
          <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{selected.snapshot.description}</p>
          <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{selected.snapshot.systemInstructions || '未填写独立系统指令'}</p>
          <p className="mt-2">负责：{selected.snapshot.contract?.responsibility.owns.join('、') || '未配置'}</p>
          <p className="mt-1">不负责：{selected.snapshot.contract?.responsibility.doesNotOwn.join('、') || '未配置'}</p>
        </details>
        <div className="flex gap-2">
          <button disabled={busy} onClick={() => void preflight(selected.id)} className="app-focus rounded-lg bg-surface px-3 py-2">检查此版本</button>
          <button disabled={busy || selected.id === history.activeVersionId || checked?.id !== selected.id || !checked.preflight.canTest}
            onClick={() => void activate(selected)} className="app-focus rounded-lg bg-surface px-3 py-2 disabled:opacity-40">回滚到此版本</button>
        </div>
      </div>}
      {checked && <div className="text-xs">
        <p>{checked.preflight.canTest ? '当前能力允许试运行；不代表真实调用或质量验收通过。' : '存在阻塞项，暂不能切换。'}</p>
        <ul className="mt-2 space-y-1">{checked.preflight.checks.map(check => <li key={check.id} className="text-app-muted">{check.label}：{check.message}</li>)}</ul>
      </div>}
    </>}
  </section>;
}
