import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface ModelData {
  modelId: string;
  totalCostUSD: number;
  percentOfTotal: number;
}

const COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981'];

function formatCurrency(value: unknown): string {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  return `$${Number.isFinite(numeric) ? numeric.toFixed(3) : '0.000'}`;
}

function shortModelName(id: string): string {
  if (id.includes('opus')) return 'Opus';
  if (id.includes('sonnet')) return 'Sonnet';
  if (id.includes('haiku')) return 'Haiku';
  return id.split('-').slice(0, 2).join('-');
}

export function ModelDistChart({ models }: { models: ModelData[] }) {
  if (!models.length) {
    return (
      <div className="bg-surface border border-border rounded-xl p-6 text-center text-gray-500">
        No model data available
      </div>
    );
  }

  const data = models.map(m => ({
    name: shortModelName(m.modelId),
    value: m.totalCostUSD,
    percent: m.percentOfTotal,
  }));

  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-4">Model Distribution</h3>
      <ResponsiveContainer width="100%" height={250}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80}
            label={({ name, percent }) => `${name} ${(((percent ?? 0) as number) * 100).toFixed(0)}%`}>
            {data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid #333', borderRadius: 8 }}
            formatter={(value) => [formatCurrency(value), 'Cost']} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
