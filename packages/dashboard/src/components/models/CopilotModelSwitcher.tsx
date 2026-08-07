import { useEffect, useMemo, useState } from 'react';
import type { ModelProviderSettings } from '@myrmecia/shared';
import { api } from '../../lib/api';

export function CopilotModelSwitcher() {
  const [settings, setSettings] = useState<ModelProviderSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.models.providerSettings()
      .then(setSettings)
      .catch(err => setError(err instanceof Error ? err.message : '模型列表加载失败'));
  }, []);

  const selected = useMemo(
    () => settings?.models.find(model => model.id === settings.selectedModelId),
    [settings],
  );

  if (!settings || settings.provider !== 'copilot') return null;

  const switchModel = async (modelId: string) => {
    if (!modelId || modelId === settings.selectedModelId) return;
    setSaving(true);
    setError('');
    try {
      setSettings(await api.models.selectProviderModel(modelId));
    } catch (err) {
      setError(err instanceof Error ? err.message : '模型切换失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="flex max-w-full items-center gap-2 rounded-xl border border-blue-400/20 bg-background/80 px-3 py-1.5"
      title="切换后，新启动的任务会使用所选模型；正在运行的任务不受影响。"
    >
      <span className="whitespace-nowrap text-[10px] font-semibold tracking-wider text-blue-300">当前执行模型</span>
      <select
        aria-label="当前执行模型"
        value={settings.selectedModelId || ''}
        disabled={saving}
        onChange={event => void switchModel(event.target.value)}
        className="min-w-0 max-w-[240px] rounded-lg border border-border bg-surface px-2 py-1.5 text-xs outline-none focus:border-blue-400 disabled:opacity-50"
        title={selected?.id === 'auto' ? 'Auto 会由 Copilot 在每次请求时动态选择实际模型' : selected?.name}
      >
        {settings.models.map(model => (
          <option key={model.id} value={model.id} disabled={!model.selectable}>
            {model.name}{model.id === 'auto' ? ' · 动态' : ''}
            {model.billingMultiplier != null ? ` · ${model.billingMultiplier}x` : ''}
            {!model.selectable ? ' · 已禁用' : ''}
          </option>
        ))}
      </select>
      <span className="max-w-[180px] truncate text-[10px] text-gray-500">
        {saving ? '切换中…' : error || (selected?.id === 'auto' ? '新任务动态选模' : `新任务 · ${selected?.id}`)}
      </span>
    </div>
  );
}
