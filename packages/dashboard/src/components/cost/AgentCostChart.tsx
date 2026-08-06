import { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';

export interface AgentData {
  agentId: string;
  agentName: string;
  dataPoints: { date: string; costUSD: number | null; aiUnits: number }[];
  totalCostUSD: number | null;
  totalAiUnits: number;
}

const COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#ec4899', '#6366f1', '#f97316'];

function formatCurrency(value: unknown): string {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  return `$${Number.isFinite(numeric) ? numeric.toFixed(3) : '0.000'}`;
}

export function AgentCostChart({ agents }: { agents: AgentData[] }) {
  const [agentSelection, setAgentSelection] = useState('top');
  const useAiUnits = agents.some(agent => agent.totalAiUnits > 0);
  const rankedAgents = useMemo(
    () => [...agents].sort((left, right) => (
      useAiUnits
        ? right.totalAiUnits - left.totalAiUnits
        : (right.totalCostUSD || 0) - (left.totalCostUSD || 0)
    )),
    [agents, useAiUnits],
  );
  const selectedAgentExists = agents.some(agent => agent.agentId === agentSelection);
  const visibleAgents = agentSelection === 'top' || !selectedAgentExists
    ? rankedAgents.slice(0, 3)
    : rankedAgents.filter(agent => agent.agentId === agentSelection);

  if (!agents.length) {
    return (
      <div className="bg-surface border border-border rounded-xl p-6 text-center text-gray-500">
        No agent cost data available
      </div>
    );
  }

  const dateSet = new Set<string>();
  for (const a of visibleAgents) {
    for (const dp of a.dataPoints) dateSet.add(dp.date);
  }
  const dates = Array.from(dateSet).sort();

  const chartData = dates.map(date => {
    const row: Record<string, any> = { date };
    for (const a of visibleAgents) {
      const dp = a.dataPoints.find(d => d.date === date);
      row[a.agentId] = useAiUnits ? (dp?.aiUnits ?? 0) : (dp?.costUSD ?? 0);
    }
    return row;
  });

  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-300">
            {useAiUnits ? 'Agent Copilot AI Usage Trend' : 'Agent USD Cost Trend'}
          </h3>
          <p className="mt-1 text-[11px] text-gray-500">
            默认显示用量最高的 3 个 Agent，也可以单独选择查看。
          </p>
        </div>
        <select
          aria-label="选择 Agent 用量曲线"
          value={selectedAgentExists ? agentSelection : 'top'}
          onChange={event => setAgentSelection(event.target.value)}
          className="min-w-[220px] rounded-lg border border-border bg-background px-3 py-2 text-xs text-gray-300 outline-none focus:border-accent"
        >
          <option value="top">Top 3 active agents</option>
          {rankedAgents.map(agent => (
            <option key={agent.agentId} value={agent.agentId}>
              {agent.agentName} · {agent.agentId}
            </option>
          ))}
        </select>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#888' }} />
          <YAxis tick={{ fontSize: 11, fill: '#888' }} tickFormatter={v => useAiUnits ? `${v}` : `$${v}`} />
          <Tooltip
            contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid #333', borderRadius: 8 }}
            formatter={(value) => [useAiUnits ? `${Number(value || 0).toFixed(3)} AIU` : formatCurrency(value), '']}
          />
          {visibleAgents.length > 1 && <Legend wrapperStyle={{ paddingTop: 12 }} />}
          {visibleAgents.map((a, i) => (
            <Line
              key={a.agentId}
              type="monotone"
              dataKey={a.agentId}
              name={a.agentName}
              stroke={COLORS[i % COLORS.length]}
              strokeWidth={2}
              dot={dates.length <= 1 ? { r: 4 } : false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
