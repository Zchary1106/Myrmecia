import { useMemo, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { Focus, Minus, Plus, Search } from 'lucide-react';
import { cn } from '../../lib/utils';

type Node = { id: string; type: string; content: string; summary?: string; importance: number };
type Edge = { sourceId: string; targetId: string; relation: string; weight: number };

type Props = {
  nodes: Node[];
  edges: Edge[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

const WIDTH = 1120;
const HEIGHT = 780;
const communityOrder = ['semantic', 'procedural', 'episodic', 'working', 'other'];
const communityMeta: Record<string, { label: string; fill: string; stroke: string; node: string; center: [number, number] }> = {
  semantic: { label: 'Facts & preferences', fill: '#eef2ff', stroke: '#a5b4fc', node: '#6366f1', center: [345, 255] },
  procedural: { label: 'Procedures', fill: '#f5f0ff', stroke: '#c4b5fd', node: '#8b5cf6', center: [735, 260] },
  episodic: { label: 'Past work', fill: '#ecfeff', stroke: '#99d8df', node: '#3b9eaa', center: [395, 570] },
  working: { label: 'Current context', fill: '#fff7ed', stroke: '#fdba74', node: '#f59e0b', center: [780, 575] },
  other: { label: 'Other knowledge', fill: '#f8fafc', stroke: '#cbd5e1', node: '#64748b', center: [570, 420] },
};

function hash(value: string) {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) result = ((result << 5) - result + value.charCodeAt(index)) | 0;
  return Math.abs(result);
}

function shortLabel(node: Node) {
  const text = (node.summary || node.content).replace(/\s+/g, ' ').trim();
  return text.length > 28 ? `${text.slice(0, 28)}…` : text;
}

export function MemoryGraphCanvas({ nodes, edges, selectedId, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [nodeOffsets, setNodeOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const [drag, setDrag] = useState<null | { kind: 'canvas' | 'node'; id?: string; clientX: number; clientY: number }>(null);
  const [visibleCommunities, setVisibleCommunities] = useState(() => new Set(communityOrder));

  const graph = useMemo(() => {
    const grouped = new Map<string, Node[]>();
    nodes.forEach(node => {
      const key = communityMeta[node.type] ? node.type : 'other';
      grouped.set(key, [...(grouped.get(key) || []), node]);
    });
    const positions = new Map<string, { x: number; y: number; community: string; radius: number }>();
    grouped.forEach((groupNodes, community) => {
      const [cx, cy] = communityMeta[community].center;
      groupNodes.forEach((node, index) => {
        const seed = hash(node.id);
        const angle = (index / Math.max(groupNodes.length, 1)) * Math.PI * 2 + (seed % 31) / 18;
        const ring = 48 + (index % 4) * 36 + (seed % 24);
        positions.set(node.id, {
          x: cx + Math.cos(angle) * ring * 1.25,
          y: cy + Math.sin(angle) * ring * 0.78,
          community,
          radius: 6 + Math.max(0, Math.min(1, node.importance)) * 11,
        });
      });
    });
    return { grouped, positions };
  }, [nodes]);

  const normalizedQuery = query.trim().toLowerCase();
  const matches = (node: Node) => !normalizedQuery || `${node.summary || ''} ${node.content}`.toLowerCase().includes(normalizedQuery);
  const positionOf = (id: string) => {
    const position = graph.positions.get(id);
    if (!position) return undefined;
    const offset = nodeOffsets[id] || { x: 0, y: 0 };
    return { ...position, x: position.x + offset.x, y: position.y + offset.y };
  };
  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setNodeOffsets({});
  };
  const startCanvasDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ kind: 'canvas', clientX: event.clientX, clientY: event.clientY });
  };
  const startNodeDrag = (event: ReactPointerEvent<SVGGElement>, id: string) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ kind: 'node', id, clientX: event.clientX, clientY: event.clientY });
    onSelect(id);
  };
  const moveDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const dx = (event.clientX - drag.clientX) * (WIDTH / bounds.width) / zoom;
    const dy = (event.clientY - drag.clientY) * (HEIGHT / bounds.height) / zoom;
    if (drag.kind === 'node' && drag.id) {
      setNodeOffsets(current => {
        const offset = current[drag.id!] || { x: 0, y: 0 };
        return { ...current, [drag.id!]: { x: offset.x + dx, y: offset.y + dy } };
      });
    } else {
      setPan(current => ({ x: current.x + dx * zoom, y: current.y + dy * zoom }));
    }
    setDrag(current => current ? { ...current, clientX: event.clientX, clientY: event.clientY } : null);
  };
  const endDrag = () => setDrag(null);
  const handleWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    setZoom(value => Math.max(0.72, Math.min(1.35, value + (event.deltaY > 0 ? -0.08 : 0.08))));
  };
  const toggleCommunity = (community: string) => setVisibleCommunities(current => {
    const next = new Set(current);
    if (next.has(community)) next.delete(community); else next.add(community);
    return next;
  });

  return (
    <div className="overflow-hidden rounded-2xl border border-app bg-app-panel shadow-sm">
      <div className="flex flex-wrap items-center gap-3 border-b border-app bg-app-panel px-4 py-3">
        <div className="flex h-10 min-w-[15rem] flex-1 items-center gap-2 rounded-xl bg-app-subtle px-3">
          <Search size={15} className="text-app-muted" />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search the knowledge map…" className="min-w-0 flex-1 bg-transparent text-sm text-app-primary outline-none placeholder:text-app-muted" />
        </div>
        <div className="flex items-center rounded-xl border border-app bg-app-panel p-1">
          <button type="button" onClick={() => setZoom(value => Math.max(0.72, value - 0.12))} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-app-muted hover:bg-app-hover" aria-label="Zoom out"><Minus size={14} /></button>
          <span className="w-11 text-center text-[11px] tabular-nums text-app-muted">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom(value => Math.min(1.35, value + 0.12))} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-app-muted hover:bg-app-hover" aria-label="Zoom in"><Plus size={14} /></button>
          <button type="button" onClick={resetView} className="ml-1 inline-flex h-8 w-8 items-center justify-center rounded-lg text-app-muted hover:bg-app-hover" aria-label="Fit graph"><Focus size={14} /></button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-app px-4 py-2.5">
        <span className="mr-1 text-[11px] font-medium text-app-muted">Communities</span>
        {communityOrder.map(key => {
          const count = graph.grouped.get(key)?.length || 0;
          if (!count) return null;
          const active = visibleCommunities.has(key);
          return <button key={key} type="button" onClick={() => toggleCommunity(key)} className={cn('inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] transition', active ? 'border-app bg-app-subtle text-app-secondary' : 'border-transparent text-app-muted opacity-50')}><span className="h-2 w-2 rounded-full" style={{ backgroundColor: communityMeta[key].node }} />{communityMeta[key].label}<span className="text-app-faint">{count}</span></button>;
        })}
        <span className="ml-auto text-[11px] text-app-muted">Drag nodes · drag canvas · scroll to zoom · {nodes.length} nodes · {edges.length} relationships</span>
      </div>

      <div className="relative min-h-[42rem] overflow-hidden bg-[radial-gradient(circle_at_center,rgba(99,102,241,0.045),transparent_60%)]">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className={cn('h-[min(76vh,54rem)] min-h-[42rem] w-full touch-none select-none', drag ? 'cursor-grabbing' : 'cursor-grab')} role="img" aria-label="Interactive knowledge graph" onPointerDown={startCanvasDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onWheel={handleWheel}>
          <defs>
            <filter id="node-shadow" x="-80%" y="-80%" width="260%" height="260%"><feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#475569" floodOpacity="0.18" /></filter>
            <marker id="edge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" /></marker>
          </defs>
          <g transform={`translate(${WIDTH * (1 - zoom) / 2 + pan.x} ${HEIGHT * (1 - zoom) / 2 + pan.y}) scale(${zoom})`}>
            {communityOrder.map(key => {
              const groupNodes = graph.grouped.get(key) || [];
              if (!groupNodes.length || !visibleCommunities.has(key)) return null;
              const meta = communityMeta[key];
              const width = Math.min(370, 230 + groupNodes.length * 8);
              const height = Math.min(265, 175 + groupNodes.length * 5);
              return <g key={`community-${key}`}><ellipse cx={meta.center[0]} cy={meta.center[1]} rx={width / 2} ry={height / 2} fill={meta.fill} fillOpacity="0.72" stroke={meta.stroke} strokeWidth="1.4" strokeDasharray="5 5" /><text x={meta.center[0] - width / 2 + 18} y={meta.center[1] - height / 2 + 25} fill={meta.node} fontSize="12" fontWeight="600">{meta.label}</text></g>;
            })}

            {edges.map(edge => {
              const source = positionOf(edge.sourceId);
              const target = positionOf(edge.targetId);
              if (!source || !target || !visibleCommunities.has(source.community) || !visibleCommunities.has(target.community)) return null;
              const emphasized = selectedId === edge.sourceId || selectedId === edge.targetId;
              return <line key={`${edge.sourceId}-${edge.targetId}-${edge.relation}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke={emphasized ? '#6366f1' : '#94a3b8'} strokeOpacity={emphasized ? 0.7 : 0.32} strokeWidth={emphasized ? 1.8 : Math.max(0.65, edge.weight)} markerEnd="url(#edge-arrow)" />;
            })}

            {nodes.map(node => {
              const position = positionOf(node.id);
              if (!position || !visibleCommunities.has(position.community)) return null;
              const meta = communityMeta[position.community];
              const selected = selectedId === node.id;
              const match = matches(node);
              return <g key={node.id} role="button" tabIndex={0} aria-label={`Memory: ${node.content}`} onPointerDown={event => startNodeDrag(event, node.id)} onClick={() => onSelect(node.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') onSelect(node.id); }} className="cursor-move outline-none" opacity={match ? 1 : 0.16}>
                {selected && <circle cx={position.x} cy={position.y} r={position.radius + 8} fill="none" stroke={meta.node} strokeWidth="2" strokeOpacity="0.35" />}
                <circle cx={position.x} cy={position.y} r={position.radius} fill={meta.node} fillOpacity={selected ? 1 : 0.82} stroke="#fff" strokeWidth={selected ? 3 : 2} filter="url(#node-shadow)" />
                {(selected || node.importance >= 0.55 || nodes.length < 18) && <text x={position.x} y={position.y + position.radius + 15} textAnchor="middle" fill="#334155" fontSize={selected ? 12 : 10} fontWeight={selected ? 650 : 500} paintOrder="stroke" stroke="#fff" strokeWidth="4" strokeLinejoin="round">{shortLabel(node)}</text>}
              </g>;
            })}
          </g>
        </svg>
        {nodes.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-sm text-app-muted">Add or confirm knowledge to build this map.</div>}
      </div>
    </div>
  );
}
