import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type GraphWorkflowDTO, type GraphNodeDTO, type GraphEdgeDTO, type GraphNodeStateDTO } from '../lib/api';
import { useStore } from '../stores/store';
import { wsClient } from '../lib/ws';
import { cn } from '../lib/utils';

const NODE_W = 190;
const NODE_H = 70;
const nid = (p = 'n') => `${p}_${Math.random().toString(36).slice(2, 8)}`;

const statusColor: Record<GraphNodeStateDTO['status'] | 'idle', string> = {
  idle: 'border-border',
  pending: 'border-gray-500/40',
  running: 'border-blue-500 ring-2 ring-blue-500/30 animate-pulse',
  done: 'border-emerald-500',
  failed: 'border-red-500',
  skipped: 'border-yellow-500/50 opacity-60',
};

export function OrchestratePage() {
  const { agents } = useStore();
  const [workflows, setWorkflows] = useState<GraphWorkflowDTO[]>([]);
  const [wfId, setWfId] = useState<string | null>(null);
  const [name, setName] = useState('Untitled Orchestration');
  const [input, setInput] = useState('');
  const [nodes, setNodes] = useState<GraphNodeDTO[]>([]);
  const [edges, setEdges] = useState<GraphEdgeDTO[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [run, setRun] = useState<GraphWorkflowDTO | null>(null);
  const [error, setError] = useState('');
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const connectRef = useRef<string | null>(null);
  const nodesRef = useRef<GraphNodeDTO[]>([]);
  nodesRef.current = nodes;
  const wfIdRef = useRef<string | null>(null);
  useEffect(() => { wfIdRef.current = wfId; }, [wfId]);

  const loadList = useCallback(async () => {
    try { setWorkflows(await api.graphWorkflows.list()); } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { void loadList(); }, [loadList]);

  const loadWorkflow = useCallback(async (id: string) => {
    try {
      const wf = await api.graphWorkflows.get(id);
      setWfId(wf.id); setName(wf.name); setInput(wf.input || '');
      setNodes(layout(wf.graph.nodes)); setEdges(wf.graph.edges); setRun(wf);
      setSelected(null); setConnecting(null); connectRef.current = null;
    } catch (e: any) { setError(e.message); }
  }, []);

  // Live updates via WebSocket (replaces polling).
  useEffect(() => {
    wsClient.connect();
    wsClient.subscribe('graphs');

    const forCurrent = (e: any) => e?.payload?.workflowId && e.payload.workflowId === wfIdRef.current;
    const patchNode = (nodeId: string, status: GraphNodeStateDTO['status']) =>
      setRun(prev => {
        if (!prev?.runState || !nodeId) return prev;
        const nodes = { ...prev.runState.nodes, [nodeId]: { ...prev.runState.nodes[nodeId], status } };
        return { ...prev, runState: { ...prev.runState, nodes } };
      });
    const refetch = async () => {
      const id = wfIdRef.current;
      if (!id) return;
      try { setRun(await api.graphWorkflows.get(id)); } catch { /* ignore */ }
    };

    const onStarted = (e: any) => { if (forCurrent(e)) patchNode(e.payload.nodeId, 'running'); };
    const onDone = (e: any) => { if (forCurrent(e)) { patchNode(e.payload.nodeId, 'done'); void refetch(); } };
    const onFailed = (e: any) => { if (forCurrent(e)) { patchNode(e.payload.nodeId, 'failed'); void refetch(); } };
    const onSkipped = (e: any) => { if (forCurrent(e)) patchNode(e.payload.nodeId, 'skipped'); };
    const onRunStarted = (e: any) => { if (forCurrent(e)) setRun(prev => prev ? { ...prev, status: 'running' } : prev); };
    const onRunEnded = (e: any) => { if (forCurrent(e)) void refetch(); };

    wsClient.on('graph:node_started', onStarted);
    wsClient.on('graph:node_done', onDone);
    wsClient.on('graph:node_failed', onFailed);
    wsClient.on('graph:node_skipped', onSkipped);
    wsClient.on('graph:run_started', onRunStarted);
    wsClient.on('graph:run_done', onRunEnded);
    wsClient.on('graph:run_failed', onRunEnded);
    wsClient.on('graph:run_cancelled', onRunEnded);

    return () => {
      wsClient.off('graph:node_started', onStarted);
      wsClient.off('graph:node_done', onDone);
      wsClient.off('graph:node_failed', onFailed);
      wsClient.off('graph:node_skipped', onSkipped);
      wsClient.off('graph:run_started', onRunStarted);
      wsClient.off('graph:run_done', onRunEnded);
      wsClient.off('graph:run_failed', onRunEnded);
      wsClient.off('graph:run_cancelled', onRunEnded);
    };
  }, []);

  const nodeState = (id: string): GraphNodeStateDTO['status'] | 'idle' => run?.runState?.nodes[id]?.status ?? 'idle';

  // ---- canvas interactions ----
  const canvasPos = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const agentId = e.dataTransfer.getData('agentId');
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return;
    const p = canvasPos(e);
    const position = { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 };
    setNodes(prev => [...prev, { id: nid(), label: agent.name, agentId: agent.id, agentRole: agent.role, prompt: '', position }]);
  };

  const startDrag = (e: React.MouseEvent, id: string) => {
    const node = nodes.find(n => n.id === id);
    if (!node?.position) return;
    const p = canvasPos(e);
    drag.current = { id, dx: p.x - node.position.x, dy: p.y - node.position.y };
  };

  // Begin dragging a connection out of a node's output port.
  const startConnect = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    connectRef.current = id;
    setConnecting(id);
    setCursor(canvasPos(e));
  };

  const removeNode = (id: string) => {
    setNodes(prev => prev.filter(n => n.id !== id));
    setEdges(prev => prev.filter(e => e.source !== id && e.target !== id));
    setSelected(prev => (prev === id ? null : prev));
  };

  const removeEdge = (id: string) => setEdges(prev => prev.filter(e => e.id !== id));

  // Node move (drag.current) + connection drag (connectRef.current).
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (drag.current) {
        const p = canvasPos(e);
        const { id, dx, dy } = drag.current;
        setNodes(prev => prev.map(n => n.id === id ? { ...n, position: { x: p.x - dx, y: p.y - dy } } : n));
      } else if (connectRef.current) {
        setCursor(canvasPos(e));
      }
    };
    const up = (e: MouseEvent) => {
      const from = connectRef.current;
      if (from) {
        const p = canvasPos(e);
        const target = nodesRef.current.find(n =>
          n.id !== from && n.position &&
          p.x >= n.position.x && p.x <= n.position.x + NODE_W &&
          p.y >= n.position.y && p.y <= n.position.y + NODE_H);
        if (target) {
          setEdges(prev => prev.some(ed => ed.source === from && ed.target === target.id)
            ? prev
            : [...prev, { id: nid('e'), source: from, target: target.id }]);
        }
      }
      drag.current = null;
      connectRef.current = null;
      setConnecting(null);
      setCursor(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  // Delete the selected node with Delete / Backspace (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (selected) { e.preventDefault(); removeNode(selected); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  // ---- persistence / run ----
  const save = async () => {
    setError('');
    try {
      const graph = { nodes, edges };
      if (wfId) {
        const wf = await api.graphWorkflows.update(wfId, { name, input, graph });
        setRun(wf);
      } else {
        const wf = await api.graphWorkflows.create({ name, input, graph });
        setWfId(wf.id); setRun(wf);
      }
      await loadList();
    } catch (e: any) { setError(e.message); }
  };

  const doRun = async (replay = false) => {
    setError('');
    try {
      if (!wfId) { await save(); }
      const id = wfId || (await api.graphWorkflows.list()).find(w => w.name === name)?.id;
      if (!id) return;
      await api.graphWorkflows.update(id, { name, input, graph: { nodes, edges } });
      const wf = replay ? await api.graphWorkflows.replay(id, input) : await api.graphWorkflows.run(id, input);
      setWfId(id); setRun(wf);
    } catch (e: any) { setError(e.message); }
  };

  const cancel = async () => { if (wfId) { try { setRun(await api.graphWorkflows.cancel(wfId)); } catch (e: any) { setError(e.message); } } };

  const newWorkflow = () => {
    setWfId(null); setName('Untitled Orchestration'); setInput(''); setNodes([]); setEdges([]); setRun(null); setSelected(null); setConnecting(null); connectRef.current = null;
  };

  const selectedNode = nodes.find(n => n.id === selected) || null;
  const outPort = (n: GraphNodeDTO) => ({ x: (n.position?.x ?? 0) + NODE_W, y: (n.position?.y ?? 0) + NODE_H / 2 });
  const inPort = (n: GraphNodeDTO) => ({ x: (n.position?.x ?? 0), y: (n.position?.y ?? 0) + NODE_H / 2 });

  const statusBadge = useMemo(() => {
    const s = run?.status || 'draft';
    const cls: Record<string, string> = {
      draft: 'bg-gray-500/15 text-gray-300', running: 'bg-blue-500/15 text-blue-300',
      done: 'bg-emerald-500/15 text-emerald-300', failed: 'bg-red-500/15 text-red-300', cancelled: 'bg-yellow-500/15 text-yellow-300',
    };
    return <span className={cn('rounded-full px-2.5 py-1 text-xs font-semibold', cls[s])}>{s}</span>;
  }, [run?.status]);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-3">
        <select
          value={wfId || ''}
          onChange={e => e.target.value ? loadWorkflow(e.target.value) : newWorkflow()}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">＋ New orchestration</option>
          {workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <input value={name} onChange={e => setName(e.target.value)} className="w-56 rounded-lg border border-border bg-background px-2 py-1.5 text-sm" />
        <input value={input} onChange={e => setInput(e.target.value)} placeholder="Goal / initial input…" className="flex-1 min-w-48 rounded-lg border border-border bg-background px-2 py-1.5 text-sm" />
        {statusBadge}
        <button onClick={save} className="rounded-lg bg-surface-hover px-3 py-1.5 text-sm text-gray-200 hover:text-white">Save</button>
        <button onClick={() => doRun(false)} disabled={nodes.length === 0} className="rounded-lg bg-accent/20 px-3 py-1.5 text-sm font-semibold text-accent-light hover:bg-accent/30 disabled:opacity-40">▶ Run</button>
        <button onClick={() => doRun(true)} disabled={!wfId} className="rounded-lg bg-surface-hover px-3 py-1.5 text-sm text-gray-300 hover:text-white disabled:opacity-40">↻ Replay</button>
        {run?.status === 'running' && <button onClick={cancel} className="rounded-lg bg-red-500/15 px-3 py-1.5 text-sm text-red-300">Stop</button>}
      </div>

      {error && <div className="border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-sm text-red-300">{error}</div>}

      <div className="flex min-h-0 flex-1">
        {/* Palette */}
        <aside className="w-48 shrink-0 overflow-y-auto border-r border-border bg-surface p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Drag agents →</div>
          <div className="space-y-1.5">
            {agents.map(a => (
              <div
                key={a.id}
                draggable
                onDragStart={e => e.dataTransfer.setData('agentId', a.id)}
                className="flex cursor-grab items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-2 text-sm hover:border-accent/40 active:cursor-grabbing"
              >
                <span>{(a as any).emoji || '🤖'}</span>
                <div className="min-w-0">
                  <div className="truncate text-[12px] font-medium">{a.name}</div>
                  <div className="text-[10px] text-gray-500">{a.role}</div>
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* Canvas */}
        <div
          ref={canvasRef}
          onDrop={onDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => setSelected(null)}
          className="relative min-h-0 flex-1 overflow-auto bg-background"
          style={{ backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px)', backgroundSize: '22px 22px' }}
        >
          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-gray-600">
              从左侧把智能体拖到这里 · 从节点右侧圆点拖出连线 · 选中后按 Del 删除
            </div>
          )}

          <svg className="pointer-events-none absolute inset-0 h-full w-full">
            <defs>
              <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
                <path d="M0,0 L0,6 L9,3 z" fill="#6b7280" />
              </marker>
            </defs>
            {edges.map(e => {
              const s = nodes.find(n => n.id === e.source); const t = nodes.find(n => n.id === e.target);
              if (!s || !t) return null;
              const a = outPort(s); const b = inPort(t);
              return (
                <g key={e.id} style={{ pointerEvents: 'stroke', cursor: 'pointer' }} onClick={() => removeEdge(e.id)}>
                  <title>点击删除连线</title>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={16} />
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#6b7280" strokeWidth={2} markerEnd="url(#arrow)" className="transition-colors hover:stroke-red-400" />
                </g>
              );
            })}
            {connecting && cursor && (() => {
              const s = nodes.find(n => n.id === connecting);
              if (!s?.position) return null;
              const a = outPort(s);
              return <line x1={a.x} y1={a.y} x2={cursor.x} y2={cursor.y} stroke="#58a6ff" strokeWidth={2} strokeDasharray="5 4" markerEnd="url(#arrow)" />;
            })()}
          </svg>

          {nodes.map(n => {
            const st = nodeState(n.id);
            return (
              <div
                key={n.id}
                onMouseDown={e => { e.stopPropagation(); startDrag(e, n.id); }}
                onClick={e => { e.stopPropagation(); setSelected(n.id); }}
                className={cn(
                  'absolute flex cursor-move select-none flex-col rounded-xl border-2 bg-surface px-3 py-2 shadow-lg',
                  statusColor[st], selected === n.id && 'ring-2 ring-accent/40',
                  connecting === n.id && 'ring-2 ring-blue-400',
                )}
                style={{ left: n.position?.x ?? 0, top: n.position?.y ?? 0, width: NODE_W, height: NODE_H }}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate text-[12px] font-semibold">{n.label}</span>
                  <button
                    onMouseDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); removeNode(n.id); }}
                    title="删除节点 (Del)"
                    className="-mr-1 px-1 text-gray-500 hover:text-red-400"
                  >✕</button>
                </div>
                <div className="mt-0.5 truncate text-[10px] text-gray-500">{n.agentRole}{st !== 'idle' && ` · ${st}`}</div>

                {/* input port (drop target is the whole node) */}
                <span className="absolute -left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-gray-500 bg-background" />
                {/* output port — drag from here to connect */}
                <button
                  onMouseDown={e => startConnect(e, n.id)}
                  onClick={e => e.stopPropagation()}
                  title="从这里拖出连线"
                  className="absolute -right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-blue-400 bg-background hover:bg-blue-400"
                />
              </div>
            );
          })}
        </div>

        {/* Inspector */}
        <aside className="w-72 shrink-0 overflow-y-auto border-l border-border bg-surface p-4">
          {selectedNode ? (
            <div className="space-y-3">
              <div className="text-sm font-semibold">{selectedNode.label}</div>
              <div className="text-[11px] text-gray-500">role: {selectedNode.agentRole} · {nodeState(selectedNode.id)}</div>
              <div>
                <label className="text-[11px] text-gray-400">Prompt（可用 {'{input}'} 引用目标）</label>
                <textarea
                  value={selectedNode.prompt || ''}
                  onChange={e => setNodes(prev => prev.map(n => n.id === selectedNode.id ? { ...n, prompt: e.target.value } : n))}
                  rows={6}
                  className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-2 text-xs outline-none focus:border-accent"
                />
              </div>
              {run?.runState?.nodes[selectedNode.id]?.output && (
                <div>
                  <div className="text-[11px] text-gray-400">Output</div>
                  <div className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-2 text-[11px] text-gray-400">
                    {run.runState.nodes[selectedNode.id].output}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2 text-xs text-gray-500">
              <div className="font-semibold text-gray-300">How to orchestrate</div>
              <p>1. 从左侧拖拽智能体到画布</p>
              <p>2. 从节点<span className="text-blue-300">右侧圆点</span>按住拖出连线，松手落到目标节点（依赖/数据流）</p>
              <p>3. 选中节点按 <span className="text-gray-300">Del/Backspace</span> 或点 ✕ 删除；点连线可删除</p>
              <p>4. 填写 Goal，点击 Run；节点按依赖顺序执行，上游输出自动喂给下游。Save 保存 / Replay 重跑</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Give nodes that lack a position a simple grid layout. */
function layout(nodes: GraphNodeDTO[]): GraphNodeDTO[] {
  let i = 0;
  return nodes.map(n => {
    if (n.position) return n;
    const col = i % 4; const row = Math.floor(i / 4); i++;
    return { ...n, position: { x: 60 + col * 230, y: 60 + row * 130 } };
  });
}
