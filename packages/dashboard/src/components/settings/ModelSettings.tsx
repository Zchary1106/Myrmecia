import { useEffect, useState } from 'react';
import type { ModelDefinition, ModelProviderSettings } from '@myrmecia/shared';
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
  const [providerSettings, setProviderSettings] = useState<ModelProviderSettings | null>(null);
  const [providerModelId, setProviderModelId] = useState('');
  const [accountLogin, setAccountLogin] = useState('');
  const [providerBusy, setProviderBusy] = useState<'login' | 'refresh' | 'model' | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newModel, setNewModel] = useState({
    id: '', displayName: '', provider: 'openai-compatible', fallbackGroup: 'balanced', tier: 'balanced' as const,
  });

  const refresh = async () => {
    setError(null);
    const [runtimeConfig, modelList, providerModelSettings] = await Promise.all([
      desktop?.getRuntimeConfig(),
      api.models.list(),
      api.models.providerSettings(),
    ]);
    if (runtimeConfig) {
      setRuntime(runtimeConfig);
      setProvider(runtimeConfig.provider);
      setBaseUrl(runtimeConfig.baseUrl);
      setModel(runtimeConfig.model);
    }
    setModels(modelList);
    setProviderSettings(providerModelSettings);
    setProviderModelId(providerModelSettings.selectedModelId || providerModelSettings.models[0]?.id || '');
    setAccountLogin(providerModelSettings.account?.login || providerModelSettings.accounts?.find(account => account.active)?.login || '');
    if (providerModelSettings.error) setMessage(providerModelSettings.error);
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

  const refreshProviderModels = async () => {
    setProviderBusy('refresh');
    setError(null);
    try {
      const next = await api.models.providerSettings();
      setProviderSettings(next);
      setProviderModelId(next.selectedModelId || next.models[0]?.id || '');
      setAccountLogin(next.account?.login || next.accounts?.find(account => account.active)?.login || '');
      setMessage(next.error || '已从当前 Provider 刷新模型列表。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '刷新 Provider 模型失败。');
    } finally {
      setProviderBusy(null);
    }
  };

  const loginCopilot = async () => {
    if (provider !== 'copilot' || providerBusy) return;
    setProviderBusy('login');
    setMessage(null);
    setError(null);
    try {
      const result = desktop
        ? await desktop.loginCopilot()
        : await api.models.loginCopilot();
      if (!result.ok) throw new Error(result.message);
      setMessage('Copilot 登录完成，正在读取账号模型…');
      if (desktop) {
        desktop.restartLocalServer();
        await new Promise(resolve => window.setTimeout(resolve, 1200));
      }
      await refreshProviderModels();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GitHub Copilot 登录失败。');
    } finally {
      setProviderBusy(null);
    }
  };

  const switchCopilotAccount = async () => {
    if (!accountLogin || providerBusy || accountLogin === providerSettings?.account?.login) return;
    setProviderBusy('refresh');
    setMessage(null);
    setError(null);
    try {
      const next = await api.models.switchCopilotAccount(accountLogin);
      setProviderSettings(next);
      setAccountLogin(next.account?.login || accountLogin);
      setProviderModelId(next.selectedModelId || next.models[0]?.id || '');
      setMessage(`已切换到 GitHub 账号 @${next.account?.login || accountLogin}。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GitHub 账号切换失败。');
    } finally {
      setProviderBusy(null);
    }
  };

  const applyProviderModel = async () => {
    if (!providerModelId || !providerSettings || providerBusy || providerSettings.provider !== 'copilot') return;
    setProviderBusy('model');
    setError(null);
    try {
      const next = await api.models.selectProviderModel(providerModelId);
      setProviderSettings(next);
      setProviderModelId(next.selectedModelId || providerModelId);
      setMessage(`已将新任务默认模型设为 ${next.models.find(modelItem => modelItem.id === providerModelId)?.name || providerModelId}。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存 Copilot 模型失败。');
    } finally {
      setProviderBusy(null);
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
          当前是 Web 模式；Provider 配置仍需通过环境变量，但账号、模型和切换操作可以在这里管理。
        </div>
      )}

      {provider === 'copilot' && providerSettings && (
        <div className="rounded-xl border border-blue-400/25 bg-blue-500/5 p-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-blue-300">
                <span className={providerSettings.account?.authenticated ? 'h-2 w-2 rounded-full bg-emerald-400' : 'h-2 w-2 rounded-full bg-yellow-400'} />
                GitHub Copilot 账号
              </div>
              {providerSettings.account?.authenticated ? (
                <>
                  <div className="mt-2 truncate text-base font-semibold text-app-primary">@{providerSettings.account.login || '已登录'}</div>
                  <div className="mt-1 text-[10px] text-gray-500">{providerSettings.account.host || 'github.com'} · {providerSettings.account.authType || '本机凭据'} · 当前用于 Copilot</div>
                </>
              ) : (
                <div className="mt-2 text-sm font-medium text-yellow-200">尚未登录 GitHub Copilot</div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
              {providerSettings.accounts && providerSettings.accounts.length > 0 && (
                <select
                  value={accountLogin}
                  onChange={event => setAccountLogin(event.target.value)}
                  disabled={providerBusy !== null}
                  aria-label="GitHub 账号"
                  className="rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none focus:border-accent disabled:opacity-50"
                >
                  {providerSettings.accounts.map(account => <option key={`${account.host}:${account.login}`} value={account.login}>{account.login}{account.active ? ' · 当前' : ''}</option>)}
                </select>
              )}
              {providerSettings.account?.authenticated ? (
                <button type="button" onClick={() => void switchCopilotAccount()} disabled={!accountLogin || accountLogin === providerSettings.account.login || providerBusy !== null} className="rounded-lg bg-blue-500 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-400 disabled:opacity-50">
                  {providerBusy === 'refresh' && accountLogin !== providerSettings.account.login ? '切换中…' : '切换账号'}
                </button>
              ) : (
                <button type="button" onClick={() => void loginCopilot()} disabled={providerBusy !== null} className="rounded-lg bg-blue-500 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-400 disabled:opacity-50">
                  {providerBusy === 'login' ? '等待授权…' : '登录 GitHub Copilot'}
                </button>
              )}
              <button type="button" onClick={() => void loginCopilot()} disabled={providerBusy !== null} className="rounded-lg border border-border bg-surface-hover px-3 py-2 text-xs text-gray-300 hover:text-white disabled:opacity-50">
                {providerBusy === 'login' ? '等待授权…' : '登录其他账号'}
              </button>
              <button type="button" onClick={() => void refreshProviderModels()} disabled={providerBusy !== null} className="rounded-lg border border-border px-3 py-2 text-xs text-gray-400 hover:text-white disabled:opacity-50">
                {providerBusy === 'refresh' ? '刷新中…' : '刷新账号'}
              </button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-gray-500">
            <span>{providerSettings.accounts?.length || 0} 个本机 GitHub 账号</span>
            <span>{providerSettings.models.filter(modelItem => modelItem.source === 'provider' && modelItem.id !== 'auto').length} 个账号模型</span>
            {providerSettings.error && <span className="text-yellow-300">{providerSettings.error}</span>}
          </div>
        </div>
      )}

      {provider === 'copilot' && providerSettings && (
        <div className="rounded-xl border border-blue-400/20 bg-blue-500/5 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h4 className="text-xs font-semibold text-app-primary">模型选择</h4>
              <p className="mt-1 text-[11px] leading-relaxed text-gray-500">模型来自当前 Copilot 账号；暂时无法读取的项目会明确标记为回退，不会冒充账号模型。</p>
            </div>
            <div className="flex min-w-0 gap-2">
              <select value={providerModelId} onChange={event => setProviderModelId(event.target.value)} disabled={providerBusy !== null} aria-label="Copilot account model" className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none focus:border-accent lg:w-64">
                {providerSettings.models.map(modelItem => <option key={modelItem.id} value={modelItem.id} disabled={!modelItem.selectable}>{modelItem.name}{modelItem.source === 'provider' ? ' · account' : ' · fallback'}{modelItem.id === 'auto' ? ' · dynamic' : ''}</option>)}
              </select>
              <button type="button" onClick={() => void applyProviderModel()} disabled={!providerModelId || providerBusy !== null || !providerSettings.models.find(modelItem => modelItem.id === providerModelId)?.selectable} className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:bg-accent-light disabled:opacity-50">
                {providerBusy === 'model' ? '保存中…' : '切换模型'}
              </button>
            </div>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {providerSettings.models.filter(modelItem => modelItem.id !== 'auto').map(modelItem => (
              <div key={modelItem.id} className="rounded-lg border border-border/70 bg-background/50 px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-app-primary">{modelItem.name}</div>
                    <div className="mt-0.5 truncate text-[10px] text-gray-500">{modelItem.source === 'provider' ? 'Account model' : 'Registry fallback'} · {modelItem.id}</div>
                  </div>
                  <span className={cn('shrink-0 rounded-full px-2 py-1 text-[9px]', modelItem.supportedReasoningEfforts?.length ? 'bg-emerald-500/10 text-emerald-300' : 'bg-border/40 text-gray-500')}>
                    {modelItem.supportedReasoningEfforts?.length ? modelItem.supportedReasoningEfforts.join(' / ') : 'reasoning unavailable'}
                  </span>
                </div>
              </div>
            ))}
          </div>
          {providerSettings.error && <div className="mt-3 rounded-lg border border-yellow-500/20 bg-yellow-500/10 px-3 py-2 text-[10px] text-yellow-200">{providerSettings.error}</div>}
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
