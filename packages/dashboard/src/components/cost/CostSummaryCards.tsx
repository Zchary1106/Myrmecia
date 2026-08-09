interface SummaryData {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalAiUnits: number;
  totalCostUSD: number | null;
  usdRequestCount: number;
  subscriptionRequestCount: number;
  unavailableRequestCount: number;
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
      sub: data?.unavailableRequestCount
        ? `${data.requestCount - data.unavailableRequestCount} measured / ${data.unavailableRequestCount} legacy unavailable`
        : 'Provider-reported requests',
      icon: '📊',
    },
    {
      label: 'Copilot AI Units',
      value: data ? data.totalAiUnits.toFixed(3) : '—',
      sub: data?.subscriptionRequestCount ? `${data.subscriptionRequestCount} subscription requests` : '',
      icon: '◈',
    },
    {
      label: 'USD Cost',
      value: data ? (data.totalCostUSD == null ? 'N/A' : `$${data.totalCostUSD.toFixed(2)}`) : '—',
      sub: data?.totalCostUSD == null && data?.subscriptionRequestCount ? 'Copilot subscription · not USD' : '',
      icon: '💰',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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
