import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';

interface AgentData {
  agentId: string;
  agentName: string;
  dataPoints: { date: string; costUSD: number }[];
  totalCostUSD: number;
}

const COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#ec4899', '#6366f1', '#f97316'];

function formatCurrency(value: unknown): string {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  return `$${Number.isFinite(numeric) ? numeric.toFixed(3) : '0.000'}`;
}

export function AgentCostChart({ agents }: { agents: AgentData[] }) {
  if (!agents.length) {
    return (
      <div className="bg-surface border border-border rounded-xl p-6 text-center text-gray-500">
        No agent cost data available
      </div>
    );
  }

  const dateSet = new Set<string>();
  for (const a of agents) {
    for (const dp of a.dataPoints) dateSet.add(dp.date);
  }
  const dates = Array.from(dateSet).sort();

  const chartData = dates.map(date => {
    const row: Record<string, any> = { date };
    for (const a of agents) {
      const dp = a.dataPoints.find(d => d.date === date);
      row[a.agentId] = dp?.costUSD ?? 0;
    }
    return row;
  });

  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-4">Agent Cost Trend</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#888' }} />
          <YAxis tick={{ fontSize: 11, fill: '#888' }} tickFormatter={v => `$${v}`} />
          <Tooltip
            contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid #333', borderRadius: 8 }}
            formatter={(value) => [formatCurrency(value), '']}
          />
          <Legend />
          {agents.map((a, i) => (
            <Line key={a.agentId} type="monotone" dataKey={a.agentId} name={a.agentName} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
