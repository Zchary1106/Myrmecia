import { lazy, Suspense, useState, useEffect, useCallback } from 'react';
import { CostSummaryCards } from '../components/cost/CostSummaryCards';
import { TaskCostTable } from '../components/cost/TaskCostTable';
import { getApiAuthToken } from '../lib/auth';

const API = '/api/v1/cost-dashboard';
const AgentCostChart = lazy(() => import('../components/cost/AgentCostChart').then(m => ({ default: m.AgentCostChart })));
const ModelDistChart = lazy(() => import('../components/cost/ModelDistChart').then(m => ({ default: m.ModelDistChart })));

type Period = 'day' | 'week' | 'month';

async function fetchJson<T>(url: string): Promise<T> {
  const token = getApiAuthToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export function CostDashboardPage() {
  const [period, setPeriod] = useState<Period>('week');
  const [summary, setSummary] = useState<any>(null);
  const [agents, setAgents] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [s, a, m, t] = await Promise.all([
        fetchJson<any>(`${API}/summary?period=${period}`),
        fetchJson<any>(`${API}/by-agent?period=${period}`),
        fetchJson<any>(`${API}/by-model?period=${period}`),
        fetchJson<any>(`${API}/by-task?limit=20`),
      ]);
      setSummary(s);
      setAgents(a.agents || []);
      setModels(m.models || []);
      setTasks(t.tasks || []);
    } catch (err) {
      console.error('Failed to load cost data:', err);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60_000);
    return () => clearInterval(interval);
  }, [loadData]);

  const periods: { value: Period; label: string }[] = [
    { value: 'day', label: 'Today' },
    { value: 'week', label: '7 Days' },
    { value: 'month', label: '30 Days' },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Cost Dashboard</h2>
          <p className="text-sm text-gray-500">Token consumption and cost trends</p>
        </div>
        <div className="flex gap-1 bg-surface border border-border rounded-lg p-0.5">
          {periods.map(p => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                period === p.value
                  ? 'bg-accent/20 text-accent-light font-medium'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !summary ? (
        <div className="text-center text-gray-500 py-12">Loading cost data...</div>
      ) : (
        <>
          <CostSummaryCards data={summary} />
          <Suspense fallback={<div className="text-center text-gray-500 py-12">Loading charts...</div>}>
            <AgentCostChart agents={agents} />
            <div className="grid grid-cols-2 gap-4">
              <ModelDistChart models={models} />
              <TaskCostTable tasks={tasks} />
            </div>
          </Suspense>
        </>
      )}
    </div>
  );
}
