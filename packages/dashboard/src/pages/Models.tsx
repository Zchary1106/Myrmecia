import { useEffect, useMemo, useState } from 'react';
import type { ModelDefinition, ModelRoute } from '@myrmecia/shared';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { useStore } from '../stores/store';
import { AuditDrawer } from '../components/audit/AuditDrawer';

const healthClass: Record<ModelDefinition['healthStatus'], string> = {
  unknown: 'bg-gray-500/10 text-gray-400',
  healthy: 'bg-emerald-500/10 text-emerald-300',
  degraded: 'bg-yellow-500/10 text-yellow-300',
  disabled: 'bg-red-500/10 text-red-300',
};

const routeLabels: Record<string, string> = {
  global: 'Global default',
  'role:orchestrator': 'Orchestrator',
  'role:product-manager': 'Product Manager',
  'role:designer': 'Designer',
  'role:developer': 'Developer',
  'role:tester': 'Tester',
  'role:devops': 'DevOps',
  'role:reviewer': 'Reviewer',
  'role:content-writer': 'Content Writer',
  'role:researcher': 'Researcher',
};

export function ModelsPage() {
  const { models, modelRoutes, loadModels, loadModelRoutes } = useStore();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('all');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [routeDrafts, setRouteDrafts] = useState<Record<string, Pick<ModelRoute, 'defaultModelId' | 'fallbackGroup'>>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    void Promise.all([loadModels(), loadModelRoutes()]);
  }, []);

  useEffect(() => {
    setRouteDrafts(Object.fromEntries(modelRoutes.map(route => [
      route.routeKey,
      { defaultModelId: route.defaultModelId, fallbackGroup: route.fallbackGroup },
    ])));
  }, [modelRoutes]);

  const groups = useMemo(() => Array.from(new Set(models.map(model => model.fallbackGroup))).sort(), [models]);
  const enabledModels = useMemo(() => models.filter(model => model.enabled), [models]);
  const filteredModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return models.filter(model => {
      const haystack = [model.id, model.displayName, model.description, model.fallbackGroup, model.healthStatus, ...model.capabilityTags].join(' ').toLowerCase();
      return (group === 'all' || model.fallbackGroup === group) && (!needle || haystack.includes(needle));
    });
  }, [models, query, group]);

  const updateModel = async (model: ModelDefinition, updates: { enabled?: boolean; priority?: number; fallbackGroup?: string }) => {
    setSavingId(model.id);
    setError('');
    try {
      await api.models.update(model.id, updates);
      await loadModels();
    } catch (err: any) {
      setError(err.message || 'Update model failed');
    } finally {
      setSavingId(null);
    }
  };

  const healthCheck = async (model: ModelDefinition) => {
    setSavingId(model.id);
    setError('');
    try {
      await api.models.healthCheck(model.id);
      await loadModels();
    } catch (err: any) {
      setError(err.message || 'Health check failed');
    } finally {
      setSavingId(null);
    }
  };

  const updateRouteDraft = (routeKey: string, updates: Partial<Pick<ModelRoute, 'defaultModelId' | 'fallbackGroup'>>) => {
    setRouteDrafts(current => ({
      ...current,
      [routeKey]: { ...current[routeKey], ...updates },
    }));
  };

  const saveRoute = async (route: ModelRoute) => {
    setSavingId(route.routeKey);
    setError('');
    try {
      const draft = routeDrafts[route.routeKey] || {};
      await api.models.updateRoute({
        routeKey: route.routeKey,
        defaultModelId: draft.defaultModelId,
        fallbackGroup: draft.fallbackGroup || 'balanced',
      });
      await Promise.all([loadModelRoutes(), loadModels()]);
    } catch (err: any) {
      setError(err.message || 'Update route failed');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="rounded-2xl border border-border bg-gradient-to-br from-surface to-background p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.24em] text-accent-light">Model Registry</div>
            <h2 className="mt-2 text-3xl font-bold">Models & Routes</h2>
            <p className="mt-2 max-w-2xl text-sm text-gray-400">
              管理 Copilot API 反向代理支持的 GPT / Claude 模型、健康状态、fallback group 和 role 默认路由。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <AuditDrawer targetType="model" label="Audit" />
            <button
              onClick={() => Promise.all([loadModels(), loadModelRoutes()])}
              className="rounded-xl bg-surface-hover px-4 py-2 text-sm text-gray-300 hover:text-white"
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Metric label="Models" value={models.length} />
          <Metric label="Enabled" value={models.filter(model => model.enabled).length} tone="green" />
          <Metric label="Healthy" value={models.filter(model => model.healthStatus === 'healthy').length} tone="green" />
          <Metric label="Routes" value={modelRoutes.length} tone="blue" />
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}

      <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
        <section className="space-y-4">
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 md:flex-row md:items-center">
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search model id, capability, group..."
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <select
              value={group}
              onChange={event => setGroup(event.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
            >
              <option value="all">All groups</option>
              {groups.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {filteredModels.map(model => (
              <ModelCard
                key={model.id}
                model={model}
                saving={savingId === model.id}
                onUpdate={updates => updateModel(model, updates)}
                onHealthCheck={() => healthCheck(model)}
              />
            ))}
          </div>
        </section>

        <aside className="rounded-2xl border border-border bg-surface p-5">
          <h3 className="text-sm font-semibold text-gray-300">Role routing</h3>
          <p className="mt-1 text-xs text-gray-500">执行时按 Agent 显式模型、role route、global route、fallback group 顺序选择模型。</p>
          <div className="mt-4 space-y-3">
            {modelRoutes.map(route => {
              const draft = routeDrafts[route.routeKey] || { defaultModelId: route.defaultModelId, fallbackGroup: route.fallbackGroup };
              return (
                <div key={route.routeKey} className="rounded-xl border border-border bg-background p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold">{routeLabels[route.routeKey] || route.routeKey}</div>
                      <div className="text-[10px] text-gray-600">{route.routeKey}</div>
                    </div>
                    <button
                      onClick={() => saveRoute(route)}
                      disabled={savingId === route.routeKey}
                      className="rounded-lg bg-accent/10 px-2 py-1 text-[10px] font-semibold text-accent-light disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                  <select
                    value={draft.defaultModelId || ''}
                    onChange={event => updateRouteDraft(route.routeKey, { defaultModelId: event.target.value || undefined })}
                    className="w-full rounded-lg border border-border bg-surface px-2 py-2 text-xs outline-none focus:border-accent"
                  >
                    <option value="">No default model</option>
                    {enabledModels.map(model => (
                      <option key={model.id} value={model.id}>{model.displayName} · {model.id}</option>
                    ))}
                  </select>
                  <input
                    value={draft.fallbackGroup || ''}
                    onChange={event => updateRouteDraft(route.routeKey, { fallbackGroup: event.target.value })}
                    placeholder="fallback group"
                    className="mt-2 w-full rounded-lg border border-border bg-surface px-2 py-2 text-xs outline-none focus:border-accent"
                  />
                </div>
              );
            })}
          </div>
        </aside>
      </div>
    </div>
  );
}

function ModelCard({
  model,
  saving,
  onUpdate,
  onHealthCheck,
}: {
  model: ModelDefinition;
  saving: boolean;
  onUpdate: (updates: { enabled?: boolean; priority?: number; fallbackGroup?: string }) => void;
  onHealthCheck: () => void;
}) {
  const [priority, setPriority] = useState(String(model.priority));
  const [fallbackGroup, setFallbackGroup] = useState(model.fallbackGroup);

  useEffect(() => {
    setPriority(String(model.priority));
    setFallbackGroup(model.fallbackGroup);
  }, [model.priority, model.fallbackGroup]);

  return (
    <div className={cn('rounded-xl border bg-surface p-5 transition hover:border-accent/30', model.enabled ? 'border-border' : 'border-red-500/20 opacity-75')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold">{model.displayName}</div>
          <div className="mt-1 text-xs text-gray-500">{model.id}</div>
        </div>
        <span className={cn('rounded-full px-2 py-1 text-[10px] font-semibold', healthClass[model.healthStatus])}>{model.healthStatus}</span>
      </div>
      <p className="mt-3 min-h-10 text-xs leading-relaxed text-gray-400">{model.description}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {model.capabilityTags.map(tag => (
          <span key={tag} className="rounded bg-background px-1.5 py-1 text-[10px] text-gray-500">{tag}</span>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-[1fr_92px] gap-2">
        <input
          value={fallbackGroup}
          onChange={event => setFallbackGroup(event.target.value)}
          onBlur={() => fallbackGroup !== model.fallbackGroup && onUpdate({ fallbackGroup })}
          className="rounded-lg border border-border bg-background px-2 py-2 text-xs outline-none focus:border-accent"
        />
        <input
          type="number"
          value={priority}
          onChange={event => setPriority(event.target.value)}
          onBlur={() => Number(priority) !== model.priority && onUpdate({ priority: Number(priority) })}
          className="rounded-lg border border-border bg-background px-2 py-2 text-xs outline-none focus:border-accent"
        />
      </div>
      <div className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-border bg-background p-3">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            checked={model.enabled}
            disabled={saving}
            onChange={event => onUpdate({ enabled: event.target.checked })}
          />
          Enabled
        </label>
        <button
          onClick={onHealthCheck}
          disabled={saving}
          className="rounded-lg bg-surface-hover px-3 py-1.5 text-xs text-gray-300 hover:text-white disabled:opacity-50"
        >
          Health check
        </button>
      </div>
    </div>
  );
}

function Metric({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'green' | 'blue' }) {
  const toneClass = {
    default: 'text-gray-100',
    green: 'text-emerald-300',
    blue: 'text-blue-300',
  }[tone];
  return (
    <div className="rounded-xl border border-border bg-background/70 p-4">
      <div className={cn('text-2xl font-bold', toneClass)}>{value}</div>
      <div className="mt-1 text-xs text-gray-500">{label}</div>
    </div>
  );
}
