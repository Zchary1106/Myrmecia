import { useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, CircleDollarSign, Cpu, Database } from 'lucide-react';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Row = Record<string, JsonValue>;

const ENDPOINTS = ["/api/v1/cost-dashboard/summary","/api/v1/cost-dashboard/by-agent","/api/v1/cost-dashboard/by-task","/api/v1/cost-dashboard/by-model","/api/v1/cost-dashboard/by-stage"];

function collectRows(value: JsonValue, rows: Row[] = []): Row[] {
  if (Array.isArray(value)) {
    value.forEach(item => collectRows(item, rows));
    return rows;
  }
  if (value && typeof value === 'object') {
    const record = value as Row;
    if (Object.values(record).some(item => typeof item === 'number')) rows.push(record);
    Object.values(record).forEach(item => {
      if (Array.isArray(item) || (item && typeof item === 'object')) collectRows(item, rows);
    });
  }
  return rows;
}

function numberFrom(row: Row, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

function textFrom(row: Row, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function compact(value: number) {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function money(value: number) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 3 : 2 }).format(value);
}

export function CostVisuals() {
  const [payloads, setPayloads] = useState<JsonValue[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void Promise.all(ENDPOINTS.map(async endpoint => {
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error(`Unable to load cost data (${response.status})`);
      return response.json() as Promise<JsonValue>;
    })).then(values => { if (!cancelled) setPayloads(values); }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to load cost data');
    });
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo(() => payloads.flatMap(value => collectRows(value)), [payloads]);
  const tokens = rows.map(row => numberFrom(row, ['totalTokens', 'tokens', 'tokenCount', 'usageTokens']));
  const inputTokens = Math.max(0, ...rows.map(row => numberFrom(row, ['inputTokens', 'promptTokens'])));
  const outputTokens = Math.max(0, ...rows.map(row => numberFrom(row, ['outputTokens', 'completionTokens'])));
  const totalTokens = Math.max(inputTokens + outputTokens, 0, ...tokens);
  const totalCost = Math.max(0, ...rows.map(row => numberFrom(row, ['usdCost', 'costUsd', 'estimatedCost', 'cost'])));
  const requests = Math.max(0, ...rows.map(row => numberFrom(row, ['requests', 'requestCount', 'calls'])));

  const trend = useMemo(() => {
    const byDate = new Map<string, { label: string; tokens: number; cost: number; requests: number }>();
    rows.forEach(row => {
      const raw = textFrom(row, ['date', 'day', 'period', 'timestamp', 'createdAt']);
      if (!raw) return;
      const label = raw.slice(0, 10);
      const current = byDate.get(label) || { label, tokens: 0, cost: 0, requests: 0 };
      current.tokens += numberFrom(row, ['totalTokens', 'tokens', 'tokenCount', 'usageTokens']);
      current.cost += numberFrom(row, ['usdCost', 'costUsd', 'estimatedCost', 'cost']);
      current.requests += numberFrom(row, ['requests', 'requestCount', 'calls']);
      byDate.set(label, current);
    });
    return [...byDate.values()].sort((a, b) => a.label.localeCompare(b.label)).slice(-30);
  }, [rows]);

  const models = useMemo(() => {
    const grouped = new Map<string, { name: string; tokens: number; cost: number; requests: number }>();
    rows.forEach(row => {
      const name = textFrom(row, ['modelName', 'modelId', 'model', 'name']);
      if (!name || !/gpt|claude|gemini|deepseek|copilot|llama|model/i.test(name)) return;
      const current = grouped.get(name) || { name, tokens: 0, cost: 0, requests: 0 };
      current.tokens += numberFrom(row, ['totalTokens', 'tokens', 'tokenCount', 'usageTokens']);
      current.cost += numberFrom(row, ['usdCost', 'costUsd', 'estimatedCost', 'cost']);
      current.requests += numberFrom(row, ['requests', 'requestCount', 'calls']);
      grouped.set(name, current);
    });
    return [...grouped.values()].sort((a, b) => b.tokens - a.tokens || b.requests - a.requests).slice(0, 8);
  }, [rows]);

  const points = trend.length ? trend : [{ label: 'No usage', tokens: 0, cost: 0, requests: 0 }];
  const maxTokens = Math.max(1, ...points.map(point => point.tokens));
  const maxCost = Math.max(.001, ...points.map(point => point.cost));
  const tokenPolyline = points.map((point, index) => `${40 + index * (620 / Math.max(1, points.length - 1))},${210 - point.tokens / maxTokens * 150}`).join(' ');
  const costPolyline = points.map((point, index) => `${40 + index * (620 / Math.max(1, points.length - 1))},${210 - point.cost / maxCost * 150}`).join(' ');
  const tokenMix = inputTokens + outputTokens;
  const inputRatio = tokenMix ? inputTokens / tokenMix : 0;
  const circumference = 2 * Math.PI * 54;

  return (
    <div className="space-y-5" data-cost-visuals>
      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <VisualMetric icon={Database} label="Tokens" value={compact(totalTokens)} accent="indigo" />
        <VisualMetric icon={Activity} label="Requests" value={compact(requests)} accent="cyan" />
        <VisualMetric icon={CircleDollarSign} label="USD cost" value={totalCost ? money(totalCost) : 'N/A'} accent="emerald" />
        <VisualMetric icon={Cpu} label="Models used" value={String(models.length)} accent="violet" />
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(18rem,.8fr)]">
        <article className="overflow-hidden rounded-2xl border border-app bg-app-panel shadow-sm">
          <div className="flex items-center justify-between border-b border-app px-5 py-4">
            <div><h2 className="text-sm font-semibold text-app-primary">Token and cost trend</h2><p className="mt-1 text-xs text-app-muted">Provider-reported usage over the selected period</p></div>
            <div className="flex gap-3 text-[11px]"><span className="flex items-center gap-1.5 text-indigo-600"><i className="h-2 w-2 rounded-full bg-indigo-500" />Tokens</span><span className="flex items-center gap-1.5 text-emerald-600"><i className="h-2 w-2 rounded-full bg-emerald-500" />Cost</span></div>
          </div>
          <div className="p-4">
            <svg viewBox="0 0 700 250" className="h-[20rem] w-full" role="img" aria-label="Token and cost trend chart">
              <defs><linearGradient id="token-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#6366f1" stopOpacity=".24" /><stop offset="100%" stopColor="#6366f1" stopOpacity="0" /></linearGradient></defs>
              {[60, 110, 160, 210].map(y => <line key={y} x1="40" x2="660" y1={y} y2={y} stroke="currentColor" className="text-app-border" strokeDasharray="3 5" />)}
              <polygon points={`40,210 ${tokenPolyline} 660,210`} fill="url(#token-area)" />
              <polyline points={tokenPolyline} fill="none" stroke="#6366f1" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              <polyline points={costPolyline} fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              {points.map((point, index) => <circle key={point.label + index} cx={40 + index * (620 / Math.max(1, points.length - 1))} cy={210 - point.tokens / maxTokens * 150} r="4" fill="#6366f1"><title>{point.label}: {compact(point.tokens)} tokens</title></circle>)}
            </svg>
          </div>
        </article>

        <article className="rounded-2xl border border-app bg-app-panel p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-app-primary">Token mix</h2>
          <div className="mt-6 flex justify-center">
            <svg viewBox="0 0 150 150" className="h-52 w-52 -rotate-90" role="img" aria-label="Input and output token mix">
              <circle cx="75" cy="75" r="54" fill="none" stroke="currentColor" className="text-app-subtle" strokeWidth="18" />
              <circle cx="75" cy="75" r="54" fill="none" stroke="#6366f1" strokeWidth="18" strokeLinecap="round" strokeDasharray={`${circumference * inputRatio} ${circumference}`} />
              <circle cx="75" cy="75" r="54" fill="none" stroke="#22d3ee" strokeWidth="18" strokeLinecap="round" strokeDasharray={`${circumference * (1-inputRatio)} ${circumference}`} strokeDashoffset={-circumference * inputRatio} />
            </svg>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3"><MixValue label="Input" value={inputTokens} color="bg-indigo-500" /><MixValue label="Output" value={outputTokens} color="bg-cyan-400" /></div>
        </article>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,1fr)]">
        <article className="rounded-2xl border border-app bg-app-panel p-5 shadow-sm">
          <div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-app-primary">Usage by model</h2><BarChart3 size={17} className="text-app-muted" /></div>
          <div className="mt-5 space-y-4">
            {(models.length ? models : [{ name: 'No model usage', tokens: 0, cost: 0, requests: 0 }]).map(model => {
              const width = models.length ? Math.max(2, model.tokens / Math.max(1, models[0].tokens) * 100) : 0;
              return <div key={model.name}><div className="mb-1.5 flex items-center justify-between gap-4 text-xs"><span className="truncate font-medium text-app-secondary">{model.name}</span><span className="shrink-0 tabular-nums text-app-muted">{compact(model.tokens)} tokens</span></div><div className="h-3 overflow-hidden rounded-full bg-app-subtle"><div className="h-full rounded-full bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-400" style={{ width: `${width}%` }} /></div></div>;
            })}
          </div>
        </article>

        <article className="rounded-2xl border border-app bg-app-panel p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-app-primary">Request intensity</h2>
          <div className="mt-5 grid grid-cols-10 gap-1.5">
            {Array.from({ length: 70 }, (_, index) => {
              const point = points[index % points.length];
              const strength = point ? point.requests / Math.max(1, ...points.map(item => item.requests)) : 0;
              return <span key={index} title={point?.label} className="aspect-square rounded-[4px] bg-indigo-500" style={{ opacity: .08 + strength * .82 }} />;
            })}
          </div>
          <div className="mt-4 flex items-center justify-between text-[10px] text-app-muted"><span>Lower activity</span><span>Higher activity</span></div>
        </article>
      </section>
    </div>
  );
}

function VisualMetric({ icon: Icon, label, value, accent }: { icon: typeof Database; label: string; value: string; accent: 'indigo' | 'cyan' | 'emerald' | 'violet' }) {
  const colors = { indigo: 'bg-indigo-50 text-indigo-600', cyan: 'bg-cyan-50 text-cyan-600', emerald: 'bg-emerald-50 text-emerald-600', violet: 'bg-violet-50 text-violet-600' };
  return <article className="flex items-center justify-between rounded-2xl border border-app bg-app-panel p-5 shadow-sm"><div><p className="text-xs font-medium text-app-muted">{label}</p><p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-app-primary">{value}</p></div><span className={`rounded-xl p-3 ${colors[accent]}`}><Icon size={19} /></span></article>;
}

function MixValue({ label, value, color }: { label: string; value: number; color: string }) {
  return <div className="rounded-xl bg-app-subtle p-3"><div className="flex items-center gap-1.5 text-[11px] text-app-muted"><i className={`h-2 w-2 rounded-full ${color}`} />{label}</div><div className="mt-1.5 text-sm font-semibold tabular-nums text-app-primary">{compact(value)}</div></div>;
}
