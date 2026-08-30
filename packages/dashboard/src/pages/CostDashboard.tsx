import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { CostVisuals } from '../components/cost/CostVisuals';
import { CostSummaryCards } from '../components/cost/CostSummaryCards';
import { TaskCostTable } from '../components/cost/TaskCostTable';
import { getApiAuthToken } from '../lib/auth';

const API = '/api/v1/cost-dashboard';
const AgentCostChart = lazy(() => import('../components/cost/AgentCostChart').then(m => ({ default: m.AgentCostChart })));
const ModelDistChart = lazy(() => import('../components/cost/ModelDistChart').then(m => ({ default: m.ModelDistChart })));
type Period = 'day' | 'week' | 'month';
type CostSection = 'overview' | 'models' | 'agents' | 'budgets';

async function fetchJson<T>(url: string): Promise<T> {
  const token = getApiAuthToken();
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

function rangeQuery(period: Period, from: string, to: string) {
  const params = new URLSearchParams({ period });
  if (from) params.set('since', new Date(`${from}T00:00:00`).toISOString());
  if (to) params.set('until', new Date(`${to}T23:59:59.999`).toISOString());
  return params.toString();
}

function formatCost(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `$${numeric.toFixed(3)}` : 'N/A';
}

export function CostDashboardPage() {
  const [period, setPeriod] = useState<Period>('week');
  const [section, setSection] = useState<CostSection>('overview');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [summary, setSummary] = useState<any>(null);
  const [agents, setAgents] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const query = rangeQuery(period, from, to);
      const [s, a, m, t] = await Promise.all([
        fetchJson<any>(`${API}/summary?${query}`), fetchJson<any>(`${API}/by-agent?${query}`),
        fetchJson<any>(`${API}/by-model?${query}`), fetchJson<any>(`${API}/by-task?limit=20`),
      ]);
      setSummary(s); setAgents(a.agents || []); setModels(m.models || []); setTasks(t.tasks || []);
    } catch (err: any) { setError(err.message || 'Failed to load cost data'); }
    finally { setLoading(false); }
  }, [period, from, to]);

  useEffect(() => { void loadData(); const interval = setInterval(() => void loadData(), 60_000); return () => clearInterval(interval); }, [loadData]);
  const hasUsage = Boolean(summary?.requestCount || agents.length || models.length || tasks.length);
  const budgetValues = useMemo(() => Object.entries(summary || {}).filter(([key, value]) => /budget|limit/i.test(key) && (typeof value === 'number' || typeof value === 'string')), [summary]);
  const tabs: Array<[CostSection, string]> = [['overview', 'Overview'], ['models', 'Models'], ['agents', 'Agents'], ['budgets', 'Budgets']];

  return <div data-configuration-page data-configuration-context="Usage and cost control" className="app-page-shell space-y-5 p-6">
    <header className="page-hero rounded-2xl border border-border p-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between"><div><h1 className="text-3xl font-bold">Costs</h1><p className="mt-2 max-w-2xl text-sm text-app-secondary">Provider-reported tokens, Copilot AI units, and available USD estimates. Subscription usage is not converted into an invented dollar amount.</p></div><button type="button" onClick={() => void loadData()} className="app-focus rounded-lg border border-border bg-surface-hover px-3 py-2 text-sm text-app-secondary hover:text-app-primary">Refresh</button></div>
      <div className="mt-5 flex flex-col gap-3 rounded-xl border border-border bg-surface p-3 lg:flex-row lg:items-center"><div className="flex flex-wrap gap-1">{([{ value: 'day', label: 'Today' }, { value: 'week', label: '7 days' }, { value: 'month', label: '30 days' }] as Array<{ value: Period; label: string }>).map(item => <button key={item.value} type="button" onClick={() => setPeriod(item.value)} className={tabClass(period === item.value)}>{item.label}</button>)}</div><label className="text-xs text-app-secondary">From<input aria-label="Cost range start" type="date" value={from} onChange={event => setFrom(event.target.value)} className="app-focus ml-2 rounded-lg border border-border bg-background px-2 py-1.5" /></label><label className="text-xs text-app-secondary">To<input aria-label="Cost range end" type="date" value={to} onChange={event => setTo(event.target.value)} className="app-focus ml-2 rounded-lg border border-border bg-background px-2 py-1.5" /></label>{(from || to) && <button type="button" onClick={() => { setFrom(''); setTo(''); }} className="app-focus text-xs text-app-secondary hover:text-app-primary">Clear range</button>}</div>
    </header>
    <nav aria-label="Cost sections" className="flex flex-wrap gap-1 rounded-xl border border-border bg-surface p-1">{tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={section === id} onClick={() => setSection(id)} className={tabClass(section === id)}>{label}</button>)}</nav>
    {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
    {loading && !summary ? <PageState title="Loading cost data..." /> : section === 'overview' ? <Overview summary={summary} tasks={tasks} hasUsage={hasUsage} /> : section === 'models' ? <Models models={models} /> : section === 'agents' ? <Agents agents={agents} /> : <Budgets entries={budgetValues} />}
  </div>;
}

function Overview({ summary, tasks, hasUsage }: { summary: any; tasks: any[]; hasUsage: boolean }) { return hasUsage ? <div className="space-y-4"><CostSummaryCards data={summary} /><Suspense fallback={<PageState title="Loading usage table..." compact />}><TaskCostTable tasks={tasks} /></Suspense></div> : <PageState title="No cost records for this range" detail="Usage will appear after models run and report tokens, AI units, or provider cost information." />; }
function Models({ models }: { models: any[] }) { return models.length ? <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]"><Suspense fallback={<PageState title="Loading model chart..." compact />}><ModelDistChart models={models} /></Suspense><UsageList heading="Model usage" items={models} name={item => item.modelId} secondary={item => item.provider || 'Provider not reported'} /></div> : <PageState title="No model cost data for this range" detail="Model usage appears once a provider returns usage data." />; }
function Agents({ agents }: { agents: any[] }) { return agents.length ? <div className="space-y-4"><Suspense fallback={<PageState title="Loading agent chart..." compact />}><AgentCostChart agents={agents} /></Suspense><UsageList heading="Agent usage" items={agents} name={item => item.agentName} secondary={item => item.agentId} /></div> : <PageState title="No agent cost data for this range" detail="Agent usage appears once executed tasks report provider usage." />; }
function UsageList({ heading, items, name, secondary }: { heading: string; items: any[]; name: (item: any) => string; secondary: (item: any) => string }) { return <div className="overflow-hidden rounded-2xl border border-border bg-surface"><h2 className="border-b border-border px-4 py-3 font-semibold">{heading}</h2><div className="divide-y divide-border">{items.map(item => <div key={name(item)} className="grid gap-2 px-4 py-3 text-sm sm:grid-cols-[1fr_auto_auto]"><div><div className="font-medium">{name(item)}</div><div className="text-xs text-app-muted">{secondary(item)}</div></div><span className="text-app-secondary">{item.totalAiUnits ? `${Number(item.totalAiUnits).toFixed(3)} AIU` : 'AI units not reported'}</span><span>{item.totalCostUSD == null ? 'USD unavailable' : formatCost(item.totalCostUSD)}</span></div>)}</div></div>; }
function Budgets({ entries }: { entries: [string, unknown][] }) { return <section className="rounded-2xl border border-border bg-surface p-6">{entries.length ? <><h2 className="text-lg font-semibold">Returned budget values</h2><p className="mt-1 text-sm text-app-secondary">Only values returned by the Cost Dashboard API are shown.</p><dl className="mt-5 grid gap-3 sm:grid-cols-2">{entries.map(([key, value]) => <div key={key} className="rounded-xl border border-border bg-background p-4"><dt className="text-xs text-app-muted">{key}</dt><dd className="mt-1 text-xl font-semibold">{String(value)}</dd></div>)}</dl></> : <PageState title="No budget values returned" detail="The current Cost Dashboard API reports usage aggregates only. Configure limits elsewhere when that API becomes available." compact />}</section>; }
function PageState({ title, detail, compact = false }: { title: string; detail?: string; compact?: boolean }) { return <div className={`${compact ? 'p-5' : 'p-12'} rounded-2xl border border-dashed border-border bg-surface text-center`}><h2 className="font-medium text-app-primary">{title}</h2>{detail && <p className="mx-auto mt-2 max-w-xl text-sm text-app-muted">{detail}</p>}</div>; }
function tabClass(selected: boolean) { return `app-focus rounded-lg px-3 py-2 text-sm ${selected ? 'bg-accent/15 text-accent-light' : 'text-app-secondary hover:bg-surface-hover hover:text-app-primary'}`; }
