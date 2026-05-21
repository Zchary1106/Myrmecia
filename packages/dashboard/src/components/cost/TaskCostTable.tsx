interface TaskCost {
  taskId: string;
  title: string;
  agentId: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  completedAt: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function TaskCostTable({ tasks }: { tasks: TaskCost[] }) {
  if (!tasks.length) {
    return (
      <div className="bg-surface border border-border rounded-xl p-6 text-center text-gray-500">
        No task cost data available
      </div>
    );
  }

  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-4">Top Tasks by Cost</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs border-b border-border">
              <th className="text-left py-2 px-2">Task</th>
              <th className="text-left py-2 px-2">Agent</th>
              <th className="text-right py-2 px-2">Tokens</th>
              <th className="text-right py-2 px-2">Cost</th>
            </tr>
          </thead>
          <tbody>
            {tasks.slice(0, 20).map(t => (
              <tr key={t.taskId} className="border-b border-border/50 hover:bg-surface-hover">
                <td className="py-2 px-2 truncate max-w-[200px]" title={t.title}>{t.title}</td>
                <td className="py-2 px-2 text-gray-400">{t.agentId}</td>
                <td className="py-2 px-2 text-right text-gray-400">{formatTokens(t.inputTokens + t.outputTokens)}</td>
                <td className="py-2 px-2 text-right font-mono">${t.costUSD.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
