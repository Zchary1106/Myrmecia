import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelProviderSettings } from '@myrmecia/shared';
import { api } from '../../lib/api';

export function CopilotModelSwitcher() {
  const [settings, setSettings] = useState<ModelProviderSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const loadSettings = async () => {
    setRefreshing(true);
    setError('');
    try {
      const next = await api.models.providerSettings();
      setSettings(next);
      setError(next.error || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : '模型列表加载失败');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadSettings();
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

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
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '模型切换失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className="relative flex max-w-full min-w-0 items-center gap-1.5 rounded-xl border border-blue-400/20 bg-background/80 px-2 py-1.5 sm:gap-2 sm:px-3"
      title="切换后，新启动的任务会使用所选模型；正在运行的任务不受影响。"
    >
      <span className="hidden whitespace-nowrap text-[10px] font-semibold tracking-wider text-blue-300 md:inline">当前执行模型</span>
      <button
        type="button"
        aria-label="当前执行模型"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={saving || refreshing}
        onClick={() => setOpen(current => !current)}
        className="flex min-w-[112px] max-w-[190px] items-center justify-between gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-left text-xs outline-none hover:border-blue-400/60 focus:border-blue-400 disabled:opacity-50 sm:min-w-[150px] sm:max-w-[240px]"
        title={selected?.id === 'auto' ? 'Auto 会由 Copilot 在每次请求时动态选择实际模型' : selected?.name}
      >
        <span className="truncate">{selected?.name || settings.selectedModelId || '选择模型'}</span>
        <span className="text-[9px] text-gray-500">{saving ? '…' : '▾'}</span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="可用 Copilot 模型"
          className="absolute right-0 top-[calc(100%+8px)] z-[100] max-h-[360px] w-[min(340px,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-2xl"
        >
          {settings.models.map(model => {
            const active = model.id === settings.selectedModelId;
            return (
              <button
                key={model.id}
                type="button"
                role="option"
                aria-selected={active}
                disabled={!model.selectable || saving}
                onClick={() => void switchModel(model.id)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-xs transition ${
                  active ? 'bg-blue-500/15 text-blue-200' : 'text-gray-300 hover:bg-surface-hover'
                } disabled:cursor-not-allowed disabled:opacity-40`}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {model.name}{model.id === 'auto' ? ' · 动态' : ''}
                  </span>
                  <span className="mt-0.5 block truncate text-[9px] text-gray-600">
                    {model.id}
                    {model.billingMultiplier != null ? ` · ${model.billingMultiplier}x` : ''}
                    {!model.selectable ? ' · 已禁用' : ''}
                  </span>
                </span>
                {active && <span className="text-blue-300">✓</span>}
              </button>
            );
          })}
        </div>
      )}
      <button
        type="button"
        onClick={() => void loadSettings()}
        disabled={saving || refreshing}
        aria-label="刷新 Copilot 模型列表"
        className="rounded-md px-1.5 py-1 text-xs text-gray-500 hover:bg-surface-hover hover:text-gray-200 disabled:opacity-40"
        title="重新从当前登录的 Copilot 账号读取模型列表"
      >
        {refreshing ? '…' : '↻'}
      </button>
      <span
        className={`hidden max-w-[180px] truncate text-[10px] xl:inline ${error ? 'text-amber-300' : 'text-gray-500'}`}
        title={error || undefined}
      >
        {saving ? '切换中…' : error ? '⚠ 使用缓存模型列表' : (selected?.id === 'auto' ? '新任务动态选模' : `新任务 · ${selected?.id}`)}
      </span>
    </div>
  );
}
