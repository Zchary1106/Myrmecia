import { useEffect, useState } from 'react';
import type { ModelDefinition } from '@myrmecia/shared';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';

const inputClass = 'mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

const providerLabels: Record<string, string> = {
  copilot: 'GitHub Copilot',
  deepseek: 'DeepSeek',
  'openai-compatible': 'OpenAI-compatible',
};

export function ModelSettings() {
  const desktop = window.myrmeciaDesktopIntegrations;
  const [runtime, setRuntime] = useState<MyrmeciaRuntimeConfiguration | null>(null);
  const [provider, setProvider] = useState<MyrmeciaRuntimeConfiguration['provider']>('copilot');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ModelDefinition[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newModel, setNewModel] = useState({
    id: '', displayName: '', provider: 'openai-compatible', fallbackGroup: 'balanced', tier: 'balanced' as const,
  });

  const refresh = async () => {
    setError(null);
    const [runtimeConfig, modelList] = await Promise.all([
      desktop?.getRuntimeConfig(),
      api.models.list(),
    ]);
    if (runtimeConfig) {
      setRuntime(runtimeConfig);
      setProvider(runtimeConfig.provider);
      setBaseUrl(runtimeConfig.baseUrl);
      setModel(runtimeConfig.model);
    }
    setModels(modelList);
  };

  useEffect(() => {
    void refresh().catch(err => setError(err instanceof Error ? err.message : '无法加载模型设置。'));
  }, []);

  const saveRuntime = async () => {
    if (!desktop || busy) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const next = await desktop.saveRuntimeConfig({
        provider,
        baseUrl: provider === 'copilot' ? undefined : baseUrl.trim(),
        model: model.trim() || undefined,
        apiKey: provider === 'copilot' ? undefined : apiKey.trim() || undefined,
      });
      setRuntime(next);
      setApiKey('');
      setMessage('模型配置已安全保存，正在重启本地服务…');
      desktop.restartLocalServer();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存模型配置失败。');
    } finally {
      setBusy(false);
    }
  };

  const addModel = async () => {
    if (!newModel.id.trim() || !newModel.displayName.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await api.models.create({
        id: newModel.id.trim(),
        displayName: newModel.displayName.trim(),
        provider: newModel.provider,
        fallbackGroup: newModel.fallbackGroup.trim() || 'balanced',
        tier: newModel.tier,
      });
      setNewModel({ id: '', displayName: '', provider: 'openai-compatible', fallbackGroup: 'balanced', tier: 'balanced' });
      setModels(await api.models.list());
      setMessage('模型已添加到注册表。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加模型失败。');
    } finally {
      setBusy(false);
    }
  };

  const toggleModel = async (item: ModelDefinition) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.models.update(item.id, { enabled: !item.enabled });
      setModels(await api.models.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新模型状态失败。');
    } finally {
      setBusy(false);
    }
  };

  const removeModel = async (item: ModelDefinition) => {
    if (busy || item.costProfile.source !== 'custom' || !window.confirm(`删除模型 ${item.displayName}？`)) return;
    setBusy(true);
    try {
      await api.models.delete(item.id);
      setModels(await api.models.list());
      setMessage('自定义模型已删除。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除模型失败。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-5 space-y-5">
      <div>
        <h3 className="text-sm font-semibold">模型与 Provider</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-gray-500">
          启动后从这里配置 GitHub Copilot、DeepSeek 或任意 OpenAI-compatible 网关；API Key 只会保存到 Electron 系统凭据库。
        </p>
      </div>

      {desktop ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <label className="block">
            <span className="text-[10px] font-medium text-gray-400">Provider</span>
            <select value={provider} onChange={event => setProvider(event.target.value as typeof provider)} className={inputClass}>
              <option value="copilot">GitHub Copilot（本机登录）</option>
              <option value="deepseek">DeepSeek API</option>
              <option value="openai-compatible">OpenAI-compatible 网关</option>
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] font-medium text-gray-400">默认模型 ID</span>
            <input value={model} onChange={event => setModel(event.target.value)} placeholder={provider === 'copilot' ? 'auto' : 'gpt-5.4-mini'} className={inputClass} />
          </label>
          {provider !== 'copilot' && (
            <>
              <label className="block">
                <span className="text-[10px] font-medium text-gray-400">Base URL</span>
                <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" className={inputClass} />
              </label>
              <label className="block">
                <span className="text-[10px] font-medium text-gray-400">API Key</span>
                <input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={runtime?.apiKeyConfigured ? '已配置，留空保持不变' : '输入 API Key'} className={inputClass} />
              </label>
            </>
          )}
          <div className="flex items-end gap-3 lg:col-span-2">
            <button type="button" onClick={() => void saveRuntime()} disabled={busy} className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white hover:bg-accent-light disabled:opacity-50">
              {busy ? '保存中…' : '保存并应用'}
            </button>
            <span className="text-[10px] text-gray-600">{runtime?.secureStorageAvailable === false ? '系统凭据库不可用，API Key 请通过环境变量提供。' : '保存后会重启本地服务。'}</span>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-3 text-[11px] text-yellow-200">
          当前是 Web 模式；Provider 凭据配置请在 Electron 应用的 Settings 中完成。
        </div>
      )}

      <div className="border-t border-border pt-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="text-xs font-semibold">模型注册表</h4>
            <p className="mt-1 text-[11px] text-gray-500">添加任意模型 ID，随后可在 Agents 和 Models 页面启用、停用及设置路由。</p>
          </div>
          <span className="rounded-full bg-background px-2 py-1 text-[10px] text-gray-500">{models.filter(item => item.enabled).length}/{models.length} enabled</span>
        </div>

        <div className="mt-4 grid gap-2 lg:grid-cols-[1fr_1fr_1fr_140px_100px_auto]">
          <input value={newModel.id} onChange={event => setNewModel(current => ({ ...current, id: event.target.value }))} placeholder="模型 ID，如 qwen3-32b" className={inputClass} />
          <input value={newModel.displayName} onChange={event => setNewModel(current => ({ ...current, displayName: event.target.value }))} placeholder="显示名称" className={inputClass} />
          <select value={newModel.provider} onChange={event => setNewModel(current => ({ ...current, provider: event.target.value }))} className={inputClass}>
            <option value="openai-compatible">OpenAI-compatible</option>
            <option value="deepseek">DeepSeek</option>
            <option value="copilot">GitHub Copilot</option>
          </select>
          <input value={newModel.fallbackGroup} onChange={event => setNewModel(current => ({ ...current, fallbackGroup: event.target.value }))} placeholder="fallback group" className={inputClass} />
          <select value={newModel.tier} onChange={event => setNewModel(current => ({ ...current, tier: event.target.value as typeof newModel.tier }))} className={inputClass}>
            <option value="strong">strong</option>
            <option value="balanced">balanced</option>
            <option value="cheap">cheap</option>
            <option value="fallback">fallback</option>
          </select>
          <button type="button" onClick={() => void addModel()} disabled={busy || !newModel.id.trim() || !newModel.displayName.trim()} className="rounded-lg bg-accent/15 px-3 py-2 text-xs font-medium text-accent-light hover:bg-accent/25 disabled:opacity-40">添加模型</button>
        </div>

        <div className="mt-4 grid gap-2 md:grid-cols-2">
          {models.map(item => (
            <div key={item.id} className={cn('flex items-center gap-3 rounded-lg border px-3 py-2.5', item.enabled ? 'border-border bg-background' : 'border-red-500/20 bg-red-500/5 opacity-70')}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{item.displayName}</div>
                <div className="mt-0.5 truncate text-[10px] text-gray-500">{item.provider} · {item.id}</div>
              </div>
              <button type="button" onClick={() => void toggleModel(item)} disabled={busy} className="text-[10px] text-gray-400 hover:text-white">{item.enabled ? '停用' : '启用'}</button>
              {item.costProfile.source === 'custom' && <button type="button" onClick={() => void removeModel(item)} disabled={busy} className="text-[10px] text-red-300 hover:text-red-200">删除</button>}
            </div>
          ))}
        </div>
      </div>

      {message && <div className="text-xs text-emerald-300">{message}</div>}
      {error && <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
    </section>
  );
}
