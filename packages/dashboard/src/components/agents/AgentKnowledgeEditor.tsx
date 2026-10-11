import { useEffect, useRef, useState } from 'react';
import type { AgentKnowledgeCatalog, AgentKnowledgeSource } from '@myrmecia/shared';
import { api } from '../../lib/api';
import { knowledgeScopeLabels } from '../common/KnowledgeCitationLink';

export function AgentKnowledgeEditor({ agentId }: { agentId: string }) {
  const [catalog, setCatalog] = useState<AgentKnowledgeCatalog>();
  const [destination, setDestination] = useState('agent_private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const generation = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const current = ++generation.current;
    void api.agents.knowledge.list(agentId).then(items => {
      if (current === generation.current) setCatalog(items);
    }).catch(() => { if (current === generation.current) setError('无法读取知识配置，请刷新重试。'); });
    return () => { generation.current++; };
  }, [agentId]);
  async function action(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    const current = generation.current;
    try {
      await fn();
      const items = await api.agents.knowledge.list(agentId);
      if (current === generation.current) setCatalog(items);
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : '操作失败');
    } finally { lock.current = false; if (current === generation.current) setBusy(false); }
  }
  async function upload(file: File) {
    if (file.size === 0 || file.size > 5 * 1024 * 1024) throw new Error('文件必须非空且不超过 5 MB。');
    const teamId = destination.startsWith('team:') ? destination.slice(5) : undefined;
    if (teamId && !window.confirm('上传后该 Team 在本工作区的当前成员可在其 Team 任务中检索，是否共享？')) return;
    await api.agents.knowledge.upload(agentId, file, teamId ? 'team_shared' : 'agent_private', teamId);
    setNotice('已保存来源。Agent 私有绑定属于工作配置；已发布的 Agent 需显式发布新版后用于新任务。');
  }
  function sourceRow(source: AgentKnowledgeSource, unbound = false) {
    return <li key={source.sourceId} className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-background/60 p-3">
      <div className="min-w-0">
        <p className="break-words text-sm">{source.title}</p>
        <p className="mt-1 text-xs text-app-muted">{knowledgeScopeLabels[source.scope]} · {source.passageCount} 段 · v{source.version}
          {' · '}{Math.ceil(source.sizeBytes / 1024)} KB · {source.sourceHash.slice(0, 12)}</p>
      </div>
      <div className="flex gap-2 text-xs">
        {unbound ? <button type="button" disabled={busy} className="app-focus rounded px-2 py-1"
          onClick={() => void action(async () => {
            if (source.scope === 'team_shared' && !window.confirm('重新绑定后 Team 成员可检索，是否继续？')) return;
            await api.agents.knowledge.bind(agentId, source.sourceId);
          })}>重新绑定</button> :
          <button type="button" disabled={busy} className="app-focus rounded px-2 py-1"
            onClick={() => void action(async () => {
              if (!window.confirm('解除绑定后，依赖此绑定的旧引用和运行将不可用，且不会自动换用同名文件。是否继续？')) return;
              await api.agents.knowledge.unbind(agentId, source.bindingId);
            })}>解除绑定</button>}
        <button type="button" disabled={busy} className="app-focus rounded px-2 py-1 text-red-500"
          onClick={() => void action(async () => {
            if (!window.confirm('将此来源标记删除并撤销绑定？文件保留用于本地恢复，但旧引用将不可用。')) return;
            await api.agents.knowledge.remove(agentId, source.sourceId);
          })}>删除来源</button>
      </div>
    </li>;
  }
  return <section aria-label="Agent knowledge sources" className="space-y-4 rounded-xl border border-border bg-surface/40 p-4">
    <div><h3 className="text-sm font-semibold">知识来源与访问范围</h3>
      <p className="mt-1 text-xs text-app-muted">Agent 私有 / Team 显式共享 / 会话临时分别隔离。来源不会自动进入工作区公共检索或长期记忆。</p></div>
    {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
    {notice && <p role="status" className="text-xs text-app-secondary">{notice}</p>}
    <div className="flex flex-wrap gap-2">
      <select aria-label="知识上传范围" value={destination} disabled={busy} className="app-focus rounded-lg border border-border bg-background px-3 py-2 text-sm"
        onChange={event => setDestination(event.target.value)}>
        <option value="agent_private">仅当前 Agent</option>
        {catalog?.teams.map(team => <option key={team.id} value={`team:${team.id}`}>Team 共享 · {team.name}</option>)}
      </select>
      <input ref={fileInput} aria-label="选择知识文件" type="file" accept=".txt,.md,.markdown,.pdf,.docx" className="hidden" disabled={busy}
        onChange={event => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (file) void action(() => upload(file));
        }} />
      <button type="button" disabled={busy} className="app-focus rounded-lg bg-accent/10 px-3 py-2 text-sm"
        onClick={() => fileInput.current?.click()}>{busy ? '处理中…' : '上传知识文件'}</button>
      <button type="button" disabled={busy} className="app-focus rounded-lg px-3 py-2 text-xs"
        onClick={() => void action(async () => {})}>刷新</button>
    </div>
    <p className="text-xs text-app-muted">TXT / Markdown / PDF / DOCX，单文件最大 5 MB，每个 Agent 或 Team 最多 20 个绑定。提取文本受 DLP 检查；来源文件保存在服务端，未加密。</p>
    <div><h4 className="mb-2 text-xs font-medium">Agent 私有来源</h4>
      <ul className="space-y-2">{catalog?.agentPrivate.map(source => sourceRow(source))}</ul>
      {catalog && !catalog.agentPrivate.length && <p className="text-xs text-app-muted">尚未绑定私有知识。</p>}
    </div>
    {catalog?.teams.map(team => <div key={team.id}>
      <h4 className="mb-2 text-xs font-medium">Team 共享 · {team.name}</h4>
      <ul className="space-y-2">{team.sources.map(source => sourceRow(source))}</ul>
      {!team.sources.length && <p className="text-xs text-app-muted">尚未共享来源；仅此 Team 的任务成员可检索。</p>}
    </div>)}
    {!!catalog?.unbound.length && <details>
      <summary className="app-focus cursor-pointer text-xs text-app-secondary">已解除绑定的来源 · {catalog.unbound.length}</summary>
      <ul className="mt-2 space-y-2">{catalog.unbound.map(source => sourceRow(source, true))}</ul>
    </details>}
    <p className="text-xs text-app-muted">会话临时文件仍从聊天输入框添加，只随当前会话及授权的后续任务使用。运行中新增文件需下一次显式任务才能检索。</p>
  </section>;
}
