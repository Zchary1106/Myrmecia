import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type {
  ArtifactContract,
  ArtifactDeclaration,
  ArtifactKind,
  ArtifactRequirement,
  TeamTemplateVersion,
  WorkflowEdgeKind,
  WorkflowNodeKind,
} from '@myrmecia/shared';
import {
  api,
  type GraphEdgeDTO,
  type GraphNodeDTO,
  type GraphNodeStateDTO,
  type GraphWorkflowDTO,
  type TeamDTO,
} from '../lib/api';
import { useStore } from '../stores/store';
import { wsClient } from '../lib/ws';
import { cn } from '../lib/utils';

const NODE_W = 208;
const NODE_H = 84;
const CANVAS_W = 1800;
const CANVAS_H = 1100;
const nid = (prefix = 'n') => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

const nodeKinds: Array<{ kind: WorkflowNodeKind; label: string; icon: string; description: string }> = [
  { kind: 'agent', label: 'Agent', icon: '◎', description: 'Execute a specialist agent' },
  { kind: 'gate', label: 'Schema Gate', icon: '◇', description: 'Validate artifact output' },
  { kind: 'human-approval', label: 'Human Gate', icon: '◆', description: 'Pause for operator approval' },
  { kind: 'publisher', label: 'Publisher', icon: '↗', description: 'Deliver approved artifacts' },
];

const artifactKinds: ArtifactKind[] = ['text', 'markdown', 'json', 'code', 'image', 'video', 'audio', 'document', 'report', 'archive', 'other'];

const statusColor: Record<GraphNodeStateDTO['status'] | 'idle', string> = {
  idle: 'border-border',
  pending: 'border-gray-500/40',
  ready: 'border-cyan-500/70',
  running: 'border-blue-500 ring-2 ring-blue-500/30',
  retrying: 'border-orange-400 ring-2 ring-orange-400/20',
  waiting_approval: 'border-violet-400 ring-2 ring-violet-400/25',
  blocked: 'border-orange-500',
  done: 'border-emerald-500',
  failed: 'border-red-500',
  skipped: 'border-yellow-500/50 opacity-70',
  cancelled: 'border-gray-600 opacity-60',
};

const statusDot: Record<GraphNodeStateDTO['status'] | 'idle', string> = {
  idle: 'bg-gray-600', pending: 'bg-gray-500', ready: 'bg-cyan-400', running: 'bg-blue-400 animate-pulse',
  retrying: 'bg-orange-400 animate-pulse', waiting_approval: 'bg-violet-400 animate-pulse', blocked: 'bg-orange-500',
  done: 'bg-emerald-400', failed: 'bg-red-400', skipped: 'bg-yellow-500', cancelled: 'bg-gray-600',
};

const edgeColor: Record<WorkflowEdgeKind, string> = {
  data: '#58a6ff', control: '#8b949e', approval: '#a78bfa',
};

export function canControlWorkflowNode(status: GraphNodeStateDTO['status'] | 'idle') {
  return {
    approve: status === 'waiting_approval' || status === 'blocked',
    reject: status === 'waiting_approval' || status === 'blocked',
    retry: ['failed', 'blocked', 'waiting_approval', 'skipped'].includes(status),
  };
}

function emptyNode(kind: WorkflowNodeKind, position: { x: number; y: number }): GraphNodeDTO {
  const definition = nodeKinds.find(item => item.kind === kind)!;
  return {
    id: nid(),
    label: definition.label,
    kind,
    prompt: '',
    inputArtifacts: [],
    outputArtifacts: kind === 'human-approval' ? [] : [{ name: 'result', kind: 'markdown', required: true }],
    requiredSkills: [],
    qualityGate: kind === 'gate' ? { outputSchema: '{\n  "type": "object"\n}', approvalRequired: false } : undefined,
    retryPolicy: { maxAttempts: 1, backoffMs: 1000, onExhausted: 'fail' },
    position,
  };
}

export function OrchestratePage() {
  const { agents, loadAgents } = useStore();
  const [workflows, setWorkflows] = useState<GraphWorkflowDTO[]>([]);
  const [teams, setTeams] = useState<TeamDTO[]>([]);
  const [teamId, setTeamId] = useState('');
  const [versions, setVersions] = useState<TeamTemplateVersion[]>([]);
  const [publishedVersion, setPublishedVersion] = useState<TeamTemplateVersion | null>(null);
  const [changeNote, setChangeNote] = useState('');
  const [wfId, setWfId] = useState<string | null>(null);
  const [name, setName] = useState('Untitled Team Workflow');
  const [input, setInput] = useState('');
  const [nodes, setNodes] = useState<GraphNodeDTO[]>([]);
  const [edges, setEdges] = useState<GraphEdgeDTO[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [run, setRun] = useState<GraphWorkflowDTO | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const connectRef = useRef<string | null>(null);
  const nodesRef = useRef<GraphNodeDTO[]>([]);
  const wfIdRef = useRef<string | null>(null);
  nodesRef.current = nodes;
  wfIdRef.current = wfId;

  const graph = useMemo(() => ({ schemaVersion: '1.0' as const, nodes, edges }), [nodes, edges]);
  const selectedNode = useMemo(() => nodes.find(node => node.id === selectedNodeId) || null, [nodes, selectedNodeId]);
  const selectedEdge = useMemo(() => edges.find(edge => edge.id === selectedEdgeId) || null, [edges, selectedEdgeId]);
  const artifacts = useMemo(() => Object.values(run?.runState?.artifacts || {}), [run?.runState?.artifacts]);
  const selectedArtifact = useMemo(
    () => artifacts.find(artifact => artifact.id === selectedArtifactId) || artifacts.find(artifact => artifact.producer.nodeId === selectedNodeId) || artifacts[0] || null,
    [artifacts, selectedArtifactId, selectedNodeId],
  );

  const loadList = useCallback(async () => {
    try {
      const [nextWorkflows, nextTeams] = await Promise.all([api.graphWorkflows.list(), api.teams.list()]);
      setWorkflows(nextWorkflows);
      setTeams(nextTeams);
      setTeamId(current => current || nextTeams[0]?.id || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadVersions = useCallback(async (id: string) => {
    if (!id) { setVersions([]); setPublishedVersion(null); return; }
    try {
      const result = await api.teams.versions(id);
      setVersions(result.versions);
      setPublishedVersion(result.published);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!agents.length) void loadAgents();
    void loadList();
  }, [agents.length, loadAgents, loadList]);

  useEffect(() => { void loadVersions(teamId); }, [teamId, loadVersions]);

  const loadWorkflow = useCallback(async (id: string) => {
    try {
      const workflow = await api.graphWorkflows.get(id);
      setWfId(workflow.id);
      setName(workflow.name);
      setInput(workflow.input || '');
      setNodes(layout(workflow.graph.nodes));
      setEdges(workflow.graph.edges);
      setRun(workflow);
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setSelectedArtifactId(null);
      setConnecting(null);
      connectRef.current = null;
      setNotice(`Loaded ${workflow.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshRun = useCallback(async () => {
    const id = wfIdRef.current;
    if (!id) return;
    try { setRun(await api.graphWorkflows.get(id)); } catch { /* websocket refresh is best effort */ }
  }, []);

  useEffect(() => {
    wsClient.connect();
    wsClient.subscribe('graphs');
    wsClient.subscribe('artifacts');

    const forCurrent = (event: any) => event?.payload?.workflowId === wfIdRef.current;
    const patchNode = (nodeId: string, status: GraphNodeStateDTO['status']) => setRun(previous => {
      if (!previous?.runState || !nodeId) return previous;
      return {
        ...previous,
        runState: {
          ...previous.runState,
          nodes: { ...previous.runState.nodes, [nodeId]: { ...previous.runState.nodes[nodeId], status } },
        },
      };
    });
    const handlers: Array<[string, (event: any) => void]> = [
      ['graph:node_started', event => { if (forCurrent(event)) patchNode(event.payload.nodeId, 'running'); }],
      ['graph:node_retrying', event => { if (forCurrent(event)) patchNode(event.payload.nodeId, 'retrying'); }],
      ['graph:node_waiting_approval', event => { if (forCurrent(event)) { patchNode(event.payload.nodeId, 'waiting_approval'); void refreshRun(); } }],
      ['graph:node_done', event => { if (forCurrent(event)) { patchNode(event.payload.nodeId, 'done'); void refreshRun(); } }],
      ['graph:node_approved', event => { if (forCurrent(event)) void refreshRun(); }],
      ['graph:node_gate_passed', event => { if (forCurrent(event)) void refreshRun(); }],
      ['graph:node_failed', event => { if (forCurrent(event)) { patchNode(event.payload.nodeId, 'failed'); void refreshRun(); } }],
      ['graph:node_skipped', event => { if (forCurrent(event)) patchNode(event.payload.nodeId, 'skipped'); }],
      ['graph:run_started', event => { if (forCurrent(event)) setRun(previous => previous ? { ...previous, status: 'running' } : previous); }],
      ['graph:run_done', event => { if (forCurrent(event)) void refreshRun(); }],
      ['graph:run_failed', event => { if (forCurrent(event)) void refreshRun(); }],
      ['graph:run_cancelled', event => { if (forCurrent(event)) void refreshRun(); }],
      ['artifact:published', event => { if (forCurrent(event)) void refreshRun(); }],
    ];
    handlers.forEach(([type, handler]) => wsClient.on(type, handler));
    return () => handlers.forEach(([type, handler]) => wsClient.off(type, handler));
  }, [refreshRun]);

  const nodeState = (id: string): GraphNodeStateDTO['status'] | 'idle' => run?.runState?.nodes[id]?.status || 'idle';
  const updateNode = (id: string, patch: Partial<GraphNodeDTO>) => setNodes(previous => previous.map(node => node.id === id ? { ...node, ...patch } : node));
  const updateEdge = (id: string, patch: Partial<GraphEdgeDTO>) => setEdges(previous => previous.map(edge => edge.id === id ? { ...edge, ...patch } : edge));

  const canvasPos = (event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 80, y: 80 };
  };

  const addNode = (kind: WorkflowNodeKind, position = { x: 90 + nodes.length * 22, y: 90 + nodes.length * 18 }) => {
    const node = emptyNode(kind, position);
    setNodes(previous => [...previous, node]);
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    setInspectorOpen(true);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const positionAt = canvasPos(event);
    const position = { x: Math.max(20, positionAt.x - NODE_W / 2), y: Math.max(20, positionAt.y - NODE_H / 2) };
    const agentId = event.dataTransfer.getData('agentId');
    const agent = agents.find(item => item.id === agentId);
    if (agent) {
      const node: GraphNodeDTO = {
        ...emptyNode('agent', position),
        label: agent.name,
        agentId: agent.id,
        agentRole: agent.role,
      };
      setNodes(previous => [...previous, node]);
      setSelectedNodeId(node.id);
      setSelectedEdgeId(null);
      setInspectorOpen(true);
      return;
    }
    const kind = event.dataTransfer.getData('nodeKind') as WorkflowNodeKind;
    if (nodeKinds.some(item => item.kind === kind)) addNode(kind, position);
  };

  const startDrag = (event: ReactMouseEvent, id: string) => {
    const node = nodes.find(item => item.id === id);
    if (!node?.position) return;
    const position = canvasPos(event);
    drag.current = { id, dx: position.x - node.position.x, dy: position.y - node.position.y };
  };

  const startConnect = (event: ReactMouseEvent, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    connectRef.current = id;
    setConnecting(id);
    setCursor(canvasPos(event));
  };

  const removeNode = (id: string) => {
    setNodes(previous => previous.filter(node => node.id !== id));
    setEdges(previous => previous.filter(edge => edge.source !== id && edge.target !== id));
    setSelectedNodeId(previous => previous === id ? null : previous);
  };

  const removeEdge = (id: string) => {
    setEdges(previous => previous.filter(edge => edge.id !== id));
    setSelectedEdgeId(previous => previous === id ? null : previous);
  };

  useEffect(() => {
    const move = (event: globalThis.MouseEvent) => {
      if (drag.current) {
        const position = canvasPos(event);
        const { id, dx, dy } = drag.current;
        setNodes(previous => previous.map(node => node.id === id ? {
          ...node,
          position: { x: Math.max(10, position.x - dx), y: Math.max(10, position.y - dy) },
        } : node));
      } else if (connectRef.current) {
        setCursor(canvasPos(event));
      }
    };
    const up = (event: globalThis.MouseEvent) => {
      const from = connectRef.current;
      if (from) {
        const position = canvasPos(event);
        const target = nodesRef.current.find(node => node.id !== from && node.position
          && position.x >= node.position.x && position.x <= node.position.x + NODE_W
          && position.y >= node.position.y && position.y <= node.position.y + NODE_H);
        if (target) setEdges(previous => previous.some(edge => edge.source === from && edge.target === target.id)
          ? previous
          : [...previous, { id: nid('e'), source: from, target: target.id, kind: 'data', artifactMappings: [] }]);
      }
      drag.current = null;
      connectRef.current = null;
      setConnecting(null);
      setCursor(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!['Delete', 'Backspace'].includes(event.key)) return;
      const tag = document.activeElement?.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag || '')) return;
      if (selectedNodeId) { event.preventDefault(); removeNode(selectedNodeId); }
      else if (selectedEdgeId) { event.preventDefault(); removeEdge(selectedEdgeId); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedEdgeId, selectedNodeId]);

  const persistWorkflow = async () => {
    const workflow = wfId
      ? await api.graphWorkflows.update(wfId, { name, input, graph })
      : await api.graphWorkflows.create({ name, input, graph });
    setWfId(workflow.id);
    setRun(workflow);
    await loadList();
    return workflow;
  };

  const save = async () => runAction('save', async () => {
    const workflow = await persistWorkflow();
    setNotice(`Saved ${workflow.name}`);
  });

  const doRun = async (replay = false) => runAction(replay ? 'replay' : 'run', async () => {
    const saved = await persistWorkflow();
    const workflow = replay
      ? await api.graphWorkflows.replay(saved.id, input)
      : await api.graphWorkflows.run(saved.id, input);
    setRun(workflow);
    setNotice(replay ? 'Workflow replayed' : 'Workflow started');
  });

  const runAction = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError('');
    setNotice('');
    try { await action(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(''); }
  };

  const controlNode = async (action: 'approve' | 'reject' | 'retry') => {
    if (!wfId || !selectedNodeId) return;
    await runAction(action, async () => {
      const note = action === 'reject' ? 'Rejected from Team Composer' : `${action} from Team Composer`;
      const workflow = action === 'approve'
        ? await api.graphWorkflows.approveNode(wfId, selectedNodeId, { note })
        : action === 'reject'
          ? await api.graphWorkflows.rejectNode(wfId, selectedNodeId, note)
          : await api.graphWorkflows.retryNode(wfId, selectedNodeId, note);
      setRun(workflow);
      setNotice(`Node ${action} completed`);
    });
  };

  const saveTeamVersion = async () => {
    if (!teamId) { setError('Select a team before saving a template version'); return; }
    await runAction('version', async () => {
      const version = await api.teams.createVersion(teamId, { graph, changeNote: changeNote || undefined });
      setChangeNote('');
      await loadVersions(teamId);
      setNotice(`Saved team template v${version.version}`);
    });
  };

  const publishVersion = async (version: TeamTemplateVersion) => runAction(`publish-${version.id}`, async () => {
    await api.teams.publishVersion(teamId, version.id);
    await loadVersions(teamId);
    setNotice(`Published v${version.version}`);
  });

  const archiveVersion = async (version: TeamTemplateVersion) => runAction(`archive-${version.id}`, async () => {
    await api.teams.archiveVersion(teamId, version.id);
    await loadVersions(teamId);
    setNotice(`Archived v${version.version}`);
  });

  const instantiateVersion = async (version?: TeamTemplateVersion) => runAction('instantiate', async () => {
    const result = await api.teams.instantiate(teamId, {
      name: `${teams.find(team => team.id === teamId)?.name || 'Team'} workflow`,
      input,
      versionId: version?.id,
    });
    await loadList();
    await loadWorkflow(result.workflow.id);
    setNotice(`Instantiated template v${result.teamTemplateVersion.version}`);
  });

  const cancel = async () => {
    if (!wfId) return;
    await runAction('cancel', async () => { setRun(await api.graphWorkflows.cancel(wfId)); });
  };

  const newWorkflow = () => {
    setWfId(null);
    setName('Untitled Team Workflow');
    setInput('');
    setNodes([]);
    setEdges([]);
    setRun(null);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setSelectedArtifactId(null);
    setNotice('New workflow canvas');
  };

  const outPort = (node: GraphNodeDTO) => ({ x: (node.position?.x || 0) + NODE_W, y: (node.position?.y || 0) + NODE_H / 2 });
  const inPort = (node: GraphNodeDTO) => ({ x: node.position?.x || 0, y: (node.position?.y || 0) + NODE_H / 2 });

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background" data-testid="team-composer">
      <header className="border-b border-border bg-surface/95 px-3 py-3 backdrop-blur lg:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setPaletteOpen(value => !value)} className="rounded-lg border border-border px-2.5 py-2 text-xs hover:bg-surface-hover" title="Toggle palette">☰</button>
          <select value={wfId || ''} onChange={event => event.target.value ? void loadWorkflow(event.target.value) : newWorkflow()}
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none sm:max-w-56">
            <option value="">New workflow</option>
            {workflows.map(workflow => <option key={workflow.id} value={workflow.id}>{workflow.name} · {workflow.status}</option>)}
          </select>
          <input value={name} onChange={event => setName(event.target.value)} aria-label="Workflow name"
            className="min-w-[12rem] flex-[2] rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold outline-none focus:border-accent" />
          <StatusBadge status={run?.status || 'draft'} />
          <button type="button" onClick={() => void save()} disabled={!!busy || nodes.length === 0} className="rounded-lg border border-border px-3 py-2 text-xs hover:bg-surface-hover disabled:opacity-40">{busy === 'save' ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={() => void doRun(false)} disabled={!!busy || nodes.length === 0} className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{busy === 'run' ? 'Starting…' : 'Run'}</button>
          <button type="button" onClick={() => void doRun(true)} disabled={!!busy || !wfId} className="rounded-lg border border-border px-3 py-2 text-xs hover:bg-surface-hover disabled:opacity-40">Replay</button>
          {run?.status === 'running' || run?.status === 'waiting' ? <button type="button" onClick={() => void cancel()} className="rounded-lg border border-red-500/30 px-3 py-2 text-xs text-red-300">Cancel</button> : null}
          <button type="button" onClick={() => setTemplateOpen(value => !value)} className={cn('rounded-lg border px-3 py-2 text-xs', templateOpen ? 'border-accent bg-accent/10 text-accent-light' : 'border-border')}>Versions</button>
          <button type="button" onClick={() => setInspectorOpen(value => !value)} className="rounded-lg border border-border px-2.5 py-2 text-xs" title="Toggle inspector">◫</button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input value={input} onChange={event => setInput(event.target.value)} placeholder="Workflow goal / runtime input" aria-label="Workflow goal"
            className="min-w-[16rem] flex-1 rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none focus:border-accent" />
          <span className="text-[10px] text-gray-600">{nodes.length} nodes · {edges.length} edges · {artifacts.length} artifacts</span>
        </div>
        {error && <div role="alert" className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
        {notice && <div className="mt-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">{notice}</div>}
      </header>

      {templateOpen && (
        <TemplateVersionBar
          teams={teams} teamId={teamId} setTeamId={setTeamId} versions={versions} published={publishedVersion}
          changeNote={changeNote} setChangeNote={setChangeNote} busy={busy}
          onSave={() => void saveTeamVersion()} onPublish={version => void publishVersion(version)}
          onArchive={version => void archiveVersion(version)} onInstantiate={version => void instantiateVersion(version)}
        />
      )}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {paletteOpen && (
          <aside className="absolute inset-y-0 left-0 z-30 w-[min(19rem,88vw)] overflow-y-auto border-r border-border bg-surface p-3 shadow-2xl xl:static xl:z-auto xl:w-64 xl:shrink-0 xl:shadow-none">
            <div className="mb-3 flex items-center justify-between">
              <div><div className="text-xs font-semibold">Building blocks</div><div className="text-[10px] text-gray-600">Drag onto the canvas</div></div>
              <button type="button" onClick={() => setPaletteOpen(false)} className="text-gray-500 xl:hidden">✕</button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {nodeKinds.map(item => (
                <button key={item.kind} type="button" draggable onDragStart={event => event.dataTransfer.setData('nodeKind', item.kind)} onClick={() => addNode(item.kind)}
                  className="rounded-xl border border-border bg-background p-2 text-left hover:border-accent/50 hover:bg-surface-hover">
                  <div className="text-base text-accent-light">{item.icon}</div><div className="mt-1 text-[11px] font-semibold">{item.label}</div><div className="mt-0.5 text-[9px] leading-snug text-gray-600">{item.description}</div>
                </button>
              ))}
            </div>
            <div className="mb-2 mt-5 text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-600">Agents</div>
            <div className="space-y-1.5">
              {agents.map(agent => (
                <button key={agent.id} type="button" draggable onDragStart={event => event.dataTransfer.setData('agentId', agent.id)}
                  className="flex w-full items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-2 text-left hover:border-accent/40 hover:bg-surface-hover">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-xs text-accent-light">{agent.name.slice(0, 1)}</span>
                  <span className="min-w-0"><span className="block truncate text-[11px] font-medium">{agent.name}</span><span className="block truncate text-[9px] text-gray-600">{agent.role}</span></span>
                </button>
              ))}
              {!agents.length && <div className="rounded-lg border border-dashed border-border p-3 text-[10px] text-gray-600">No agents loaded. Gate and publisher nodes remain available.</div>}
            </div>
          </aside>
        )}

        <main className="min-w-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_1px_1px,rgba(148,163,184,0.12)_1px,transparent_0)] bg-[length:24px_24px]">
          <div ref={canvasRef} onDragOver={event => event.preventDefault()} onDrop={onDrop}
            onMouseDown={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
            className="relative" style={{ width: CANVAS_W, height: CANVAS_H }}>
            {nodes.length === 0 && (
              <div className="absolute left-1/2 top-1/3 w-80 -translate-x-1/2 rounded-2xl border border-dashed border-border bg-surface/80 p-6 text-center backdrop-blur">
                <div className="text-2xl text-accent-light">⌘</div><div className="mt-2 text-sm font-semibold">Compose your agent team</div>
                <div className="mt-1 text-xs leading-relaxed text-gray-500">Drag agents or gates from the palette. Connect output ports to define artifact and control flow.</div>
              </div>
            )}
            <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
              <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>
              {edges.map(edge => {
                const source = nodes.find(node => node.id === edge.source);
                const target = nodes.find(node => node.id === edge.target);
                if (!source?.position || !target?.position) return null;
                const a = outPort(source); const b = inPort(target); const curve = Math.max(70, Math.abs(b.x - a.x) * 0.45);
                const color = edgeColor[edge.kind || 'data'];
                return <path key={edge.id} d={`M ${a.x} ${a.y} C ${a.x + curve} ${a.y}, ${b.x - curve} ${b.y}, ${b.x} ${b.y}`}
                  fill="none" stroke={selectedEdgeId === edge.id ? '#f8fafc' : color} strokeWidth={selectedEdgeId === edge.id ? 3 : 2}
                  strokeDasharray={edge.kind === 'control' ? '6 5' : undefined} markerEnd="url(#arrow)" className="pointer-events-auto cursor-pointer"
                  onMouseDown={event => { event.stopPropagation(); setSelectedEdgeId(edge.id); setSelectedNodeId(null); setInspectorOpen(true); }} />;
              })}
              {connecting && cursor && (() => { const source = nodes.find(node => node.id === connecting); if (!source?.position) return null; const a = outPort(source); return <line x1={a.x} y1={a.y} x2={cursor.x} y2={cursor.y} stroke="#58a6ff" strokeWidth={2} strokeDasharray="5 4" markerEnd="url(#arrow)" />; })()}
            </svg>

            {nodes.map(node => {
              const status = nodeState(node.id);
              const definition = nodeKinds.find(item => item.kind === (node.kind || 'agent'))!;
              return (
                <div key={node.id} onMouseDown={event => { event.stopPropagation(); startDrag(event, node.id); }} onClick={event => { event.stopPropagation(); setSelectedNodeId(node.id); setSelectedEdgeId(null); setInspectorOpen(true); }}
                  className={cn('absolute flex cursor-move select-none flex-col rounded-xl border-2 bg-surface px-3 py-2.5 shadow-xl transition-shadow', statusColor[status], selectedNodeId === node.id && 'ring-2 ring-accent/50', connecting === node.id && 'ring-2 ring-blue-400')}
                  style={{ left: node.position?.x || 0, top: node.position?.y || 0, width: NODE_W, height: NODE_H }}>
                  <div className="flex items-center gap-2"><span className="text-sm text-accent-light">{definition.icon}</span><span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{node.label || definition.label}</span><span className={cn('h-2 w-2 rounded-full', statusDot[status])} /></div>
                  <div className="mt-1 truncate text-[10px] text-gray-500">{node.agentRole || definition.label} · {status}</div>
                  <div className="mt-auto flex items-center justify-between text-[9px] text-gray-600"><span>{node.inputArtifacts?.length || 0} in</span><span>{node.outputArtifacts?.length || 0} out</span><span>{node.requiredSkills?.length || 0} skills</span></div>
                  <span className="absolute -left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-gray-500 bg-background" />
                  <button type="button" onMouseDown={event => startConnect(event, node.id)} onClick={event => event.stopPropagation()} title="Connect output"
                    className="absolute -right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-blue-400 bg-background hover:bg-blue-400" />
                </div>
              );
            })}
          </div>
        </main>

        {inspectorOpen && (
          <aside className="absolute inset-y-0 right-0 z-30 w-[min(26rem,94vw)] overflow-y-auto border-l border-border bg-surface shadow-2xl xl:static xl:z-auto xl:w-[23rem] xl:shrink-0 xl:shadow-none">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface/95 px-4 py-3 backdrop-blur">
              <div><div className="text-xs font-semibold">Inspector</div><div className="text-[9px] uppercase tracking-[0.15em] text-gray-600">Contract · Runtime · Artifacts</div></div>
              <button type="button" onClick={() => setInspectorOpen(false)} className="text-gray-500 hover:text-gray-200">✕</button>
            </div>
            <div className="p-4">
              {selectedNode ? (
                <NodeInspector node={selectedNode} agents={agents} state={run?.runState?.nodes[selectedNode.id]} artifacts={artifacts.filter(artifact => artifact.producer.nodeId === selectedNode.id)} selectedArtifact={selectedArtifact}
                  busy={busy} onUpdate={patch => updateNode(selectedNode.id, patch)} onRemove={() => removeNode(selectedNode.id)} onSelectArtifact={setSelectedArtifactId} onControl={action => void controlNode(action)} />
              ) : selectedEdge ? (
                <EdgeInspector edge={selectedEdge} nodes={nodes} onUpdate={patch => updateEdge(selectedEdge.id, patch)} onRemove={() => removeEdge(selectedEdge.id)} />
              ) : (
                <WorkflowInspector run={run} artifacts={artifacts} selectedArtifact={selectedArtifact} onSelectArtifact={setSelectedArtifactId} />
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: GraphWorkflowDTO['status'] }) {
  const style = status === 'done' ? 'bg-emerald-500/10 text-emerald-300' : status === 'failed' ? 'bg-red-500/10 text-red-300' : status === 'waiting' ? 'bg-violet-500/10 text-violet-300' : status === 'running' ? 'bg-blue-500/10 text-blue-300' : 'bg-gray-500/10 text-gray-400';
  return <span className={cn('rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide', style)}>{status}</span>;
}

function TemplateVersionBar(props: {
  teams: TeamDTO[]; teamId: string; setTeamId: (id: string) => void; versions: TeamTemplateVersion[]; published: TeamTemplateVersion | null;
  changeNote: string; setChangeNote: (value: string) => void; busy: string; onSave: () => void;
  onPublish: (version: TeamTemplateVersion) => void; onArchive: (version: TeamTemplateVersion) => void; onInstantiate: (version?: TeamTemplateVersion) => void;
}) {
  return (
    <section className="border-b border-border bg-surface px-3 py-3 lg:px-5" data-testid="template-version-bar">
      <div className="flex flex-wrap items-center gap-2">
        <select value={props.teamId} onChange={event => props.setTeamId(event.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-xs">
          <option value="">Select team</option>{props.teams.map(team => <option key={team.id} value={team.id}>{team.emoji} {team.name}</option>)}
        </select>
        <input value={props.changeNote} onChange={event => props.setChangeNote(event.target.value)} placeholder="Version change note" className="min-w-[15rem] flex-1 rounded-lg border border-border bg-background px-3 py-2 text-xs" />
        <button type="button" onClick={props.onSave} disabled={!props.teamId || !!props.busy} className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">Save draft version</button>
        <button type="button" onClick={() => props.onInstantiate()} disabled={!props.published || !!props.busy} className="rounded-lg border border-border px-3 py-2 text-xs disabled:opacity-40">Instantiate published</button>
      </div>
      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
        {props.versions.map(version => (
          <div key={version.id} className="min-w-52 rounded-xl border border-border bg-background px-3 py-2">
            <div className="flex items-center justify-between"><span className="text-xs font-semibold">v{version.version}</span><span className={cn('rounded-full px-2 py-0.5 text-[9px]', version.status === 'published' ? 'bg-emerald-500/10 text-emerald-300' : version.status === 'archived' ? 'bg-gray-500/10 text-gray-500' : 'bg-yellow-500/10 text-yellow-300')}>{version.status}</span></div>
            <div className="mt-1 truncate text-[9px] text-gray-600">{version.changeNote || 'No change note'}</div>
            <div className="mt-2 flex gap-1.5">
              {version.status === 'draft' && <button type="button" onClick={() => props.onPublish(version)} className="rounded bg-emerald-500/10 px-2 py-1 text-[9px] text-emerald-300">Publish</button>}
              {version.status !== 'archived' && <button type="button" onClick={() => props.onArchive(version)} className="rounded bg-gray-500/10 px-2 py-1 text-[9px] text-gray-400">Archive</button>}
              <button type="button" onClick={() => props.onInstantiate(version)} className="rounded bg-blue-500/10 px-2 py-1 text-[9px] text-blue-300">Instantiate</button>
            </div>
          </div>
        ))}
        {!props.versions.length && <div className="text-[10px] text-gray-600">No immutable versions yet.</div>}
      </div>
    </section>
  );
}

function NodeInspector(props: {
  node: GraphNodeDTO; agents: ReturnType<typeof useStore.getState>['agents']; state?: GraphNodeStateDTO;
  artifacts: ArtifactContract[]; selectedArtifact: ArtifactContract | null; busy: string;
  onUpdate: (patch: Partial<GraphNodeDTO>) => void; onRemove: () => void; onSelectArtifact: (id: string) => void;
  onControl: (action: 'approve' | 'reject' | 'retry') => void;
}) {
  const status = props.state?.status || 'idle';
  const controls = canControlWorkflowNode(status);
  const updateAgent = (agentId: string) => {
    const agent = props.agents.find(item => item.id === agentId);
    props.onUpdate({ agentId: agentId || undefined, agentRole: agent?.role, label: agent?.name || props.node.label });
  };
  return (
    <div className="space-y-5">
      <InspectorSection title="Node identity">
        <Field label="Label"><input value={props.node.label || ''} onChange={event => props.onUpdate({ label: event.target.value })} className="field" /></Field>
        <Field label="Kind"><select value={props.node.kind || 'agent'} onChange={event => props.onUpdate({ kind: event.target.value as WorkflowNodeKind })} className="field">{nodeKinds.map(item => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select></Field>
        {(props.node.kind || 'agent') === 'agent' && <Field label="Agent"><select value={props.node.agentId || ''} onChange={event => updateAgent(event.target.value)} className="field"><option value="">Resolve by role</option>{props.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {agent.role}</option>)}</select></Field>}
        <Field label="Role"><input value={props.node.agentRole || ''} onChange={event => props.onUpdate({ agentRole: event.target.value })} className="field" /></Field>
      </InspectorSection>

      <InspectorSection title="Prompt">
        <textarea value={props.node.prompt || ''} onChange={event => props.onUpdate({ prompt: event.target.value })} rows={6} placeholder="Use {input} and declared artifacts" className="field resize-y" />
      </InspectorSection>

      <InspectorSection title="Artifact contract">
        <ArtifactEditor title="Inputs" items={props.node.inputArtifacts || []} declaration={false} onChange={items => props.onUpdate({ inputArtifacts: items as ArtifactRequirement[] })} />
        <ArtifactEditor title="Outputs" items={props.node.outputArtifacts || []} declaration onChange={items => props.onUpdate({ outputArtifacts: items as ArtifactDeclaration[] })} />
      </InspectorSection>

      <InspectorSection title="Required skills">
        <input value={(props.node.requiredSkills || []).join(', ')} onChange={event => props.onUpdate({ requiredSkills: event.target.value.split(',').map(item => item.trim()).filter(Boolean) })} placeholder="research, code-review, publishing" className="field" />
      </InspectorSection>

      <InspectorSection title="Quality gate">
        <label className="flex items-center justify-between gap-3 text-[11px] text-gray-400"><span>Human approval required</span><input type="checkbox" checked={props.node.qualityGate?.approvalRequired || false} onChange={event => props.onUpdate({ qualityGate: { ...props.node.qualityGate, approvalRequired: event.target.checked } })} /></label>
        <Field label="Output JSON Schema"><textarea value={props.node.qualityGate?.outputSchema || ''} onChange={event => props.onUpdate({ qualityGate: { ...props.node.qualityGate, outputSchema: event.target.value || undefined } })} rows={5} className="field font-mono text-[10px]" placeholder={'{"type":"object"}'} /></Field>
      </InspectorSection>

      <InspectorSection title="Retry policy">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Max attempts"><input type="number" min={1} max={10} value={props.node.retryPolicy?.maxAttempts || 1} onChange={event => props.onUpdate({ retryPolicy: { ...props.node.retryPolicy, maxAttempts: Number(event.target.value) || 1 } })} className="field" /></Field>
          <Field label="Backoff ms"><input type="number" min={0} value={props.node.retryPolicy?.backoffMs || 0} onChange={event => props.onUpdate({ retryPolicy: { maxAttempts: props.node.retryPolicy?.maxAttempts || 1, ...props.node.retryPolicy, backoffMs: Number(event.target.value) || 0 } })} className="field" /></Field>
        </div>
        <Field label="On exhausted"><select value={props.node.retryPolicy?.onExhausted || 'fail'} onChange={event => props.onUpdate({ retryPolicy: { maxAttempts: props.node.retryPolicy?.maxAttempts || 1, ...props.node.retryPolicy, onExhausted: event.target.value as 'fail' | 'human' } })} className="field"><option value="fail">Fail workflow</option><option value="human">Request human intervention</option></select></Field>
      </InspectorSection>

      <InspectorSection title="Runtime">
        <div className="rounded-xl border border-border bg-background p-3 text-[10px] text-gray-500">
          <div className="flex items-center justify-between"><span>Status</span><span className="font-semibold text-gray-200">{status}</span></div>
          <div className="mt-1 flex items-center justify-between"><span>Attempt</span><span>{props.state ? `${props.state.attempt}/${props.state.maxAttempts}` : '—'}</span></div>
          {props.state?.error && <div className="mt-2 rounded-lg bg-red-500/10 p-2 text-red-300">{props.state.error}</div>}
          {!!props.state?.validationErrors?.length && <ul className="mt-2 list-disc pl-4 text-orange-300">{props.state.validationErrors.map(error => <li key={error}>{error}</li>)}</ul>}
          {props.state?.intervention && <div className="mt-2 rounded-lg bg-violet-500/10 p-2 text-violet-300">{props.state.intervention.reason}</div>}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <button type="button" onClick={() => props.onControl('approve')} disabled={!controls.approve || !!props.busy} className="rounded-lg bg-emerald-500/10 px-2 py-2 text-[10px] font-semibold text-emerald-300 disabled:opacity-30">Approve</button>
          <button type="button" onClick={() => props.onControl('reject')} disabled={!controls.reject || !!props.busy} className="rounded-lg bg-red-500/10 px-2 py-2 text-[10px] font-semibold text-red-300 disabled:opacity-30">Reject</button>
          <button type="button" onClick={() => props.onControl('retry')} disabled={!controls.retry || !!props.busy} className="rounded-lg bg-orange-500/10 px-2 py-2 text-[10px] font-semibold text-orange-300 disabled:opacity-30">Retry</button>
        </div>
      </InspectorSection>

      <InspectorSection title={`Artifacts (${props.artifacts.length})`}>
        <ArtifactList artifacts={props.artifacts} selected={props.selectedArtifact} onSelect={props.onSelectArtifact} />
        <ArtifactPreview artifact={props.selectedArtifact?.producer.nodeId === props.node.id ? props.selectedArtifact : props.artifacts[0] || null} />
      </InspectorSection>

      <button type="button" onClick={props.onRemove} className="w-full rounded-lg border border-red-500/30 px-3 py-2 text-xs text-red-300 hover:bg-red-500/10">Delete node</button>
    </div>
  );
}

function EdgeInspector(props: { edge: GraphEdgeDTO; nodes: GraphNodeDTO[]; onUpdate: (patch: Partial<GraphEdgeDTO>) => void; onRemove: () => void }) {
  const source = props.nodes.find(node => node.id === props.edge.source);
  const target = props.nodes.find(node => node.id === props.edge.target);
  return (
    <div className="space-y-5">
      <InspectorSection title="Edge">
        <div className="rounded-xl border border-border bg-background p-3 text-xs"><div>{source?.label || props.edge.source}</div><div className="my-1 text-accent-light">↓</div><div>{target?.label || props.edge.target}</div></div>
        <Field label="Flow kind"><select value={props.edge.kind || 'data'} onChange={event => props.onUpdate({ kind: event.target.value as WorkflowEdgeKind })} className="field"><option value="data">Artifact data</option><option value="control">Control dependency</option><option value="approval">Approval flow</option></select></Field>
      </InspectorSection>
      <InspectorSection title="Artifact mappings">
        {(props.edge.artifactMappings || []).map((mapping, index) => (
          <div key={`${mapping.from}-${mapping.to}-${index}`} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5">
            <input value={mapping.from} onChange={event => props.onUpdate({ artifactMappings: (props.edge.artifactMappings || []).map((item, itemIndex) => itemIndex === index ? { ...item, from: event.target.value } : item) })} placeholder="source output" className="field" />
            <span className="text-gray-600">→</span>
            <input value={mapping.to} onChange={event => props.onUpdate({ artifactMappings: (props.edge.artifactMappings || []).map((item, itemIndex) => itemIndex === index ? { ...item, to: event.target.value } : item) })} placeholder="target input" className="field" />
            <button type="button" onClick={() => props.onUpdate({ artifactMappings: (props.edge.artifactMappings || []).filter((_, itemIndex) => itemIndex !== index) })} className="text-gray-600 hover:text-red-300">✕</button>
          </div>
        ))}
        <button type="button" onClick={() => props.onUpdate({ artifactMappings: [...(props.edge.artifactMappings || []), { from: '', to: '' }] })} className="w-full rounded-lg border border-dashed border-border px-2 py-2 text-[10px] text-gray-400">+ Map artifact</button>
      </InspectorSection>
      <button type="button" onClick={props.onRemove} className="w-full rounded-lg border border-red-500/30 px-3 py-2 text-xs text-red-300">Delete edge</button>
    </div>
  );
}

function WorkflowInspector(props: { run: GraphWorkflowDTO | null; artifacts: ArtifactContract[]; selectedArtifact: ArtifactContract | null; onSelectArtifact: (id: string) => void }) {
  const counts = props.run?.runState ? Object.values(props.run.runState.nodes).reduce<Record<string, number>>((result, state) => ({ ...result, [state.status]: (result[state.status] || 0) + 1 }), {}) : {};
  return (
    <div className="space-y-5">
      <InspectorSection title="Workflow runtime">
        <div className="grid grid-cols-2 gap-2">{Object.entries(counts).map(([status, count]) => <div key={status} className="rounded-lg border border-border bg-background p-2"><div className="text-lg font-semibold">{count}</div><div className="text-[9px] uppercase text-gray-600">{status}</div></div>)}</div>
        {!props.run?.runState && <div className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-gray-600">Run the workflow to inspect live node state and artifacts.</div>}
      </InspectorSection>
      <InspectorSection title={`Workflow artifacts (${props.artifacts.length})`}>
        <ArtifactList artifacts={props.artifacts} selected={props.selectedArtifact} onSelect={props.onSelectArtifact} />
        <ArtifactPreview artifact={props.selectedArtifact} />
      </InspectorSection>
      <InspectorSection title="Quick guide">
        <ol className="list-decimal space-y-2 pl-4 text-[11px] leading-relaxed text-gray-500"><li>Drag an Agent, Gate or Publisher onto the canvas.</li><li>Declare input/output artifacts and required skills.</li><li>Connect nodes and map output names to downstream inputs.</li><li>Save, run, then approve or retry nodes from this inspector.</li><li>Save immutable team versions and publish a reusable template.</li></ol>
      </InspectorSection>
    </div>
  );
}

function ArtifactEditor(props: { title: string; items: Array<ArtifactRequirement | ArtifactDeclaration>; declaration: boolean; onChange: (items: Array<ArtifactRequirement | ArtifactDeclaration>) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between"><span className="text-[10px] font-semibold text-gray-400">{props.title}</span><button type="button" onClick={() => props.onChange([...props.items, { name: '', kind: 'markdown', required: props.declaration }])} className="text-[10px] text-accent-light">+ Add</button></div>
      {props.items.map((item, index) => (
        <div key={`${item.name}-${index}`} className="rounded-lg border border-border bg-background p-2">
          <div className="grid grid-cols-[minmax(0,1fr)_7rem_auto] gap-1.5">
            <input value={item.name} onChange={event => props.onChange(props.items.map((current, itemIndex) => itemIndex === index ? { ...current, name: event.target.value } : current))} placeholder="artifact name" className="field" />
            <select value={item.kind} onChange={event => props.onChange(props.items.map((current, itemIndex) => itemIndex === index ? { ...current, kind: event.target.value as ArtifactKind } : current))} className="field">{artifactKinds.map(kind => <option key={kind}>{kind}</option>)}</select>
            <button type="button" onClick={() => props.onChange(props.items.filter((_, itemIndex) => itemIndex !== index))} className="px-1 text-gray-600 hover:text-red-300">✕</button>
          </div>
          <div className="mt-1.5 flex items-center gap-3 text-[9px] text-gray-600">
            <label><input type="checkbox" checked={item.required || false} onChange={event => props.onChange(props.items.map((current, itemIndex) => itemIndex === index ? { ...current, required: event.target.checked } : current))} /> required</label>
            <label><input type="checkbox" checked={item.multiple || false} onChange={event => props.onChange(props.items.map((current, itemIndex) => itemIndex === index ? { ...current, multiple: event.target.checked } : current))} /> multiple</label>
          </div>
        </div>
      ))}
      {!props.items.length && <div className="rounded-lg border border-dashed border-border p-2 text-center text-[9px] text-gray-600">No declared {props.title.toLowerCase()}</div>}
    </div>
  );
}

function ArtifactList(props: { artifacts: ArtifactContract[]; selected: ArtifactContract | null; onSelect: (id: string) => void }) {
  if (!props.artifacts.length) return <div className="rounded-lg border border-dashed border-border p-3 text-center text-[10px] text-gray-600">No artifacts produced yet.</div>;
  return <div className="space-y-1.5">{props.artifacts.map(artifact => <button key={artifact.id} type="button" onClick={() => props.onSelect(artifact.id)} className={cn('flex w-full items-center justify-between rounded-lg border px-2.5 py-2 text-left', props.selected?.id === artifact.id ? 'border-accent bg-accent/10' : 'border-border bg-background')}><span className="min-w-0"><span className="block truncate text-[10px] font-medium">{artifact.name}</span><span className="block text-[9px] text-gray-600">{artifact.kind} · {artifact.integrity?.sizeBytes || 0} B</span></span><span className="text-[9px] text-gray-600">{String(artifact.metadata?.approvalStatus || '')}</span></button>)}</div>;
}

function ArtifactPreview({ artifact }: { artifact: ArtifactContract | null }) {
  if (!artifact) return null;
  if (artifact.uri && artifact.kind === 'image') return <img src={artifact.uri} alt={artifact.name} className="mt-2 max-h-72 w-full rounded-lg border border-border bg-black object-contain" />;
  if (artifact.uri && artifact.kind === 'video') return <video src={artifact.uri} controls className="mt-2 max-h-72 w-full rounded-lg border border-border bg-black" />;
  if (artifact.uri && artifact.kind === 'audio') return <audio src={artifact.uri} controls className="mt-2 w-full" />;
  return <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 text-[10px] leading-relaxed text-gray-400">{artifact.inlineContent || artifact.uri || 'Artifact content is not inline.'}</pre>;
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-3"><div className="text-[10px] font-semibold uppercase tracking-[0.17em] text-gray-600">{title}</div>{children}</section>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-[10px] text-gray-500">{label}</span>{children}</label>;
}

function layout(nodes: GraphNodeDTO[]): GraphNodeDTO[] {
  let index = 0;
  return nodes.map(node => {
    if (node.position) return node;
    const column = index % 4; const row = Math.floor(index / 4); index += 1;
    return { ...node, position: { x: 70 + column * 245, y: 70 + row * 145 } };
  });
}
