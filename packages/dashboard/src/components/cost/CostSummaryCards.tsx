interface SummaryData {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  requestCount: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function CostSummaryCards({ data }: { data: SummaryData | null }) {
  const cards = [
    {
      label: 'Total Tokens',
      value: data ? formatTokens(data.totalInputTokens + data.totalOutputTokens) : '—',
      sub: data ? `${formatTokens(data.totalInputTokens)} in / ${formatTokens(data.totalOutputTokens)} out` : '',
      icon: '🔤',
    },
    {
      label: 'Requests',
      value: data ? data.requestCount.toLocaleString() : '—',
      sub: '',
      icon: '📊',
    },
    {
      label: 'Total Cost',
      value: data ? `$${data.totalCostUSD.toFixed(2)}` : '—',
      sub: '',
      icon: '💰',
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-4">
      {cards.map(c => (
        <div key={c.label} className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 text-sm text-gray-400 mb-1">
            <span>{c.icon}</span>
            {c.label}
          </div>
          <div className="text-2xl font-bold">{c.value}</div>
          {c.sub && <div className="text-xs text-gray-500 mt-1">{c.sub}</div>}
        </div>
      ))}
    </div>
  );
}
