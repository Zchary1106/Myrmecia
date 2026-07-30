import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores/store';
import { api } from '../../lib/api';
import { clearApiAuthToken, getApiAuthToken, setApiAuthToken } from '../../lib/auth';
import { cn } from '../../lib/utils';
import { operatorRoleLabel } from '../../lib/permissions';
import type { WorkspacePreferenceRestoreResult, WorkspaceRestorePlan, WorkspaceSnapshotPreview } from '@myrmecia/shared';

function CheckRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-start gap-3 bg-background border border-border rounded-lg px-3 py-2">
      <span className={cn('mt-0.5', ok ? 'text-green-400' : 'text-yellow-400')}>{ok ? '✓' : '!'}</span>
      <div>
        <div className="text-xs font-medium">{label}</div>
        <div className="text-[11px] text-gray-500 mt-0.5">{detail}</div>
      </div>
    </div>
  );
}

function WeChatIntegrationSettings() {
  const desktop = window.myrmeciaDesktopIntegrations;
  const [summary, setSummary] = useState<MyrmeciaWeChatConfiguration | null>(null);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [integrationError, setIntegrationError] = useState<string | null>(null);

  const refresh = async () => {
    setIntegrationError(null);
    const [config, servers] = await Promise.all([
      desktop?.getWeChatConfig(),
      api.mcp.servers().catch(() => []),
    ]);
    if (config) {
      setSummary(config);
      setAppId(config.appId);
    }
    setConnected(servers.some(server => server.name === 'wechat-official-account' && server.connected));
  };

  useEffect(() => {
    void refresh().catch(error => setIntegrationError(error instanceof Error ? error.message : 'Unable to inspect WeChat integration.'));
  }, []);

  const save = async () => {
    if (!desktop || busy) return;
    setBusy(true);
    setMessage(null);
    setIntegrationError(null);
    try {
      const result = await desktop.saveWeChatConfig({ appId: appId.trim(), appSecret: appSecret.trim() });
      setSummary(result);
      setAppSecret('');
      setMessage('凭据已由系统凭据库加密保存，正在重启本地服务并连接公众号 MCP…');
      desktop.restartLocalServer();
    } catch (error) {
      setIntegrationError(error instanceof Error ? error.message : 'Unable to save WeChat credentials.');
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!desktop || busy || !window.confirm('清除本机保存的微信公众号凭据并重启服务？')) return;
    setBusy(true);
    setMessage(null);
    setIntegrationError(null);
    try {
      const result = await desktop.clearWeChatConfig();
      setSummary(result);
      setAppId('');
      setAppSecret('');
      setMessage('微信公众号凭据已清除，正在重启本地服务…');
      desktop.restartLocalServer();
    } catch (error) {
      setIntegrationError(error instanceof Error ? error.message : 'Unable to clear WeChat credentials.');
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl">✍️</span>
            <h3 className="text-sm font-semibold">微信公众号 MCP</h3>
            <span className={cn(
              'rounded-full px-2 py-1 text-[9px] font-semibold',
              connected ? 'bg-emerald-500/10 text-emerald-300' : summary?.configured ? 'bg-yellow-500/10 text-yellow-300' : 'bg-gray-500/10 text-gray-500',
            )}>
              {connected ? 'connected' : summary?.configured ? 'restart required' : 'not configured'}
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-[11px] leading-relaxed text-gray-500">
            为公众号写手提供封面素材上传、草稿箱同步和发布能力。AppSecret 由 Electron 系统凭据库加密，
            不会回传到 Dashboard，也不会出现在 MCP 子进程参数中。
          </p>
        </div>
        {summary?.configured && (
          <button onClick={() => void clear()} disabled={busy} className="rounded-lg bg-red-500/10 px-3 py-2 text-[11px] text-red-300 hover:bg-red-500/20 disabled:opacity-50">
            Clear credentials
          </button>
        )}
      </div>

      {desktop ? (
        <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_1fr_auto]">
          <label className="block">
            <span className="text-[10px] font-medium text-gray-400">AppID</span>
            <input
              value={appId}
              onChange={event => setAppId(event.target.value)}
              placeholder="wx1234567890abcdef"
              className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium text-gray-400">AppSecret</span>
            <input
              type="password"
              value={appSecret}
              onChange={event => setAppSecret(event.target.value)}
              placeholder={summary?.configured ? '留空不会读取或显示现有密钥' : '32 位十六进制 AppSecret'}
              className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </label>
          <button
            onClick={() => void save()}
            disabled={busy || !appId.trim() || !appSecret.trim() || summary?.secureStorageAvailable === false}
            className="self-end rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white hover:bg-accent-light disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save & restart'}
          </button>
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-3 text-[11px] text-yellow-200">
          Web 模式请设置 WECHAT_OFFICIAL_ACCOUNT_APP_ID、WECHAT_OFFICIAL_ACCOUNT_APP_SECRET 和 WECHAT_MCP_SECRET_KEY 后重启服务。
        </div>
      )}

      {summary?.recoveryMessage && <div className="mt-3 text-xs text-yellow-300">{summary.recoveryMessage}</div>}
      {message && <div className="mt-3 text-xs text-emerald-300">{message}</div>}
      {integrationError && <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">{integrationError}</div>}
    </section>
  );
}

export function SettingsView() {
  const { health, diagnostics, loadHealth, loadDiagnostics } = useStore();
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotStatus, setSnapshotStatus] = useState<string | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotInput, setSnapshotInput] = useState('');
  const [snapshotPreview, setSnapshotPreview] = useState<WorkspaceSnapshotPreview | null>(null);
  const [restorePlan, setRestorePlan] = useState<WorkspaceRestorePlan | null>(null);
  const [preferenceRestoreResult, setPreferenceRestoreResult] = useState<WorkspacePreferenceRestoreResult | null>(null);

  useEffect(() => {
    setToken(getApiAuthToken());
    void checkConnection();
  }, []);

  const checks = useMemo(() => {
    const authReady = diagnostics?.auth.enabled ? !!getApiAuthToken() : true;
    return [
      {
        label: 'API reachable',
        ok: health?.status === 'ok',
        detail: health?.status === 'ok' ? 'Health endpoint is responding.' : 'Health endpoint has not responded yet.',
      },
      {
        label: 'Auth configuration',
        ok: authReady,
        detail: diagnostics?.auth.enabled
          ? 'Server requires a Bearer token; dashboard has a token configured.'
          : 'Server is running in local mode without API token enforcement.',
      },
      {
        label: 'Queue backend',
        ok: diagnostics?.queue.backend === 'redis',
        detail: diagnostics?.queue.backend === 'redis'
          ? 'Redis/BullMQ queue is configured.'
          : 'Using in-memory queue; set REDIS_URL for persistent distributed queueing.',
      },
      {
        label: 'Schema migrations',
        ok: (diagnostics?.database.migrations.length || 0) > 0,
        detail: `${diagnostics?.database.migrations.length || 0} migrations recorded in schema_migrations.`,
      },
      {
        label: 'Operator role',
        ok: diagnostics?.operator.permissions.canControlRuntime ?? false,
        detail: diagnostics
          ? `${operatorRoleLabel(diagnostics)}${diagnostics.operator.permissions.canControlRuntime ? ' can run controls.' : ' is read-only.'}`
          : 'Operator diagnostics have not loaded yet.',
      },
    ];
  }, [health, diagnostics, token]);

  const checkConnection = async () => {
    setStatus('Checking connection...');
    setError(null);
    try {
      await loadHealth();
      await loadDiagnostics(true);
      setStatus('Connection check passed');
    } catch (err: any) {
      setError(err.message);
      setStatus(null);
    }
  };

  const saveToken = async () => {
    setApiAuthToken(token.trim());
    setStatus('Token saved. Rechecking connection...');
    await checkConnection();
  };

  const clearToken = async () => {
    clearApiAuthToken();
    setToken('');
    setStatus('Token cleared. Rechecking connection...');
    await checkConnection();
  };

  const exportSnapshot = async () => {
    setSnapshotBusy(true);
    setSnapshotError(null);
    setSnapshotStatus(null);
    try {
      const snapshot = await api.workspaceSnapshot.export();
      const body = JSON.stringify(snapshot, null, 2);
      const blob = new Blob([body], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `agent-factory-workspace-${snapshot.generatedAt.replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setSnapshotStatus(`Exported ${snapshot.data.tasks.length} tasks, ${snapshot.data.pipelines.length} pipelines, and ${snapshot.data.inboxEntries.length} inbox entries.`);
    } catch (err: any) {
      setSnapshotError(err.message);
    } finally {
      setSnapshotBusy(false);
    }
  };

  const previewSnapshot = async () => {
    if (!snapshotInput.trim()) {
      setSnapshotError('Paste a workspace snapshot JSON payload first.');
      return;
    }
    setSnapshotBusy(true);
    setSnapshotError(null);
    setSnapshotPreview(null);
    setRestorePlan(null);
    setPreferenceRestoreResult(null);
    try {
      const parsed = JSON.parse(snapshotInput);
      const [preview, plan] = await Promise.all([
        api.workspaceSnapshot.preview(parsed),
        api.workspaceSnapshot.restorePlan(parsed),
      ]);
      setSnapshotPreview(preview);
      setRestorePlan(plan);
      setSnapshotStatus(plan.valid ? 'Snapshot restore plan generated.' : 'Snapshot restore plan has conflicts or warnings.');
    } catch (err: any) {
      setSnapshotError(err.message);
    } finally {
      setSnapshotBusy(false);
    }
  };

  const restorePreferences = async () => {
    if (!snapshotInput.trim()) {
      setSnapshotError('Paste a workspace snapshot JSON payload first.');
      return;
    }
    const preferenceCount = restorePlan?.actions.filter(action => action.resourceType === 'preference').length ?? 0;
    if (preferenceCount === 0) {
      setSnapshotError('This snapshot does not include restorable preferences.');
      return;
    }
    if (!window.confirm('Restore operator preferences from this snapshot? This only writes preferences for the current operator.')) return;
    setSnapshotBusy(true);
    setSnapshotError(null);
    setPreferenceRestoreResult(null);
    try {
      const parsed = JSON.parse(snapshotInput);
      const result = await api.workspaceSnapshot.restorePreferences(parsed, true);
      setPreferenceRestoreResult(result);
      setSnapshotStatus(`Restored ${result.restored} preferences, skipped ${result.skipped}, failed ${result.failed}.`);
      const plan = await api.workspaceSnapshot.restorePlan(parsed);
      setRestorePlan(plan);
    } catch (err: any) {
      setSnapshotError(err.message);
    } finally {
      setSnapshotBusy(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-xl font-bold">Settings</h2>
        <p className="text-[12px] text-gray-500 mt-0.5">
          API token, connection diagnostics, and deployment readiness checks.
        </p>
      </div>

      <section className="bg-surface border border-border rounded-xl p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">API token</h3>
          <p className="text-[11px] text-gray-500 mt-1">
            Used for HTTP Authorization and WebSocket authentication when the server has API_AUTH_TOKEN enabled.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="Bearer token"
            className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm focus:border-accent outline-none"
          />
          <button
            onClick={() => saveToken()}
            className="px-3 py-2 rounded-lg bg-accent/10 text-accent-light text-xs font-medium hover:bg-accent/20 transition"
          >
            Save
          </button>
          <button
            onClick={() => clearToken()}
            className="px-3 py-2 rounded-lg bg-surface-hover text-gray-400 text-xs font-medium hover:text-white transition"
          >
            Clear
          </button>
        </div>
        {status && <div className="text-xs text-green-400">{status}</div>}
        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}
      </section>

      <WeChatIntegrationSettings />

      <section className="grid lg:grid-cols-2 gap-4">
        <div className="bg-surface border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold">Deployment checks</h3>
            <button
              onClick={() => checkConnection()}
              className="px-3 py-1.5 rounded-lg bg-surface-hover text-[11px] text-gray-400 hover:text-white transition"
            >
              Recheck
            </button>
          </div>
          <div className="space-y-2">
            {checks.map(check => <CheckRow key={check.label} {...check} />)}
          </div>
        </div>

        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-4">Runtime diagnostics</h3>
          {diagnostics ? (
            <div className="space-y-2 text-[12px]">
              <div className="flex justify-between"><span className="text-gray-500">Auth mode</span><span>{diagnostics.auth.mode}</span></div>
              <div className="flex justify-between gap-3"><span className="text-gray-500">Operator</span><span className="text-right">{operatorRoleLabel(diagnostics)}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Runtime controls</span><span>{diagnostics.operator.permissions.canControlRuntime ? 'allowed' : 'read-only'}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Task delete</span><span>{diagnostics.operator.permissions.canDeleteTasks ? 'allowed' : 'admin only'}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Queue</span><span>{diagnostics.queue.backend}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Database</span><span>{diagnostics.database.pathSource}:{diagnostics.database.pathHint}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Node</span><span>{diagnostics.runtime.nodeVersion}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Platform</span><span>{diagnostics.runtime.platform}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Environment</span><span>{diagnostics.runtime.environment}</span></div>
              <div className="pt-3 mt-3 border-t border-border">
                <div className="text-[11px] text-gray-500 mb-2">Applied migrations</div>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {diagnostics.database.migrations.map(migration => (
                    <div key={migration.id} className="text-[11px] text-gray-400">{migration.id}</div>
                  ))}
                  {diagnostics.database.migrations.length === 0 && (
                    <div className="text-[11px] text-gray-600">No migrations recorded</div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-600 py-8 text-center">Run a connection check to load diagnostics.</div>
          )}
        </div>
      </section>

      <section className="bg-surface border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold">Workspace snapshot</h3>
            <p className="text-[11px] text-gray-500 mt-1">
              Export a sanitized operator workspace for handoff, demos, or recovery drills. Import currently previews only and does not write server state.
            </p>
          </div>
          <button
            onClick={() => exportSnapshot()}
            disabled={snapshotBusy}
            className="px-3 py-1.5 rounded-lg bg-accent/10 text-accent-light text-[11px] hover:bg-accent/20 transition disabled:opacity-50"
          >
            Export snapshot
          </button>
        </div>

        <div className="grid lg:grid-cols-[1fr_320px] gap-4">
          <div className="space-y-2">
            <textarea
              value={snapshotInput}
              onChange={event => setSnapshotInput(event.target.value)}
              placeholder="Paste a workspace snapshot JSON payload to preview counts and compatibility..."
              rows={8}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-xs focus:border-accent outline-none resize-y font-mono"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => previewSnapshot()}
                disabled={snapshotBusy || !snapshotInput.trim()}
                className="px-3 py-1.5 rounded-lg bg-surface-hover text-[11px] text-gray-300 hover:text-white transition disabled:opacity-50"
              >
                Preview import
              </button>
              <button
                onClick={() => {
                  setSnapshotInput('');
                  setSnapshotPreview(null);
                  setRestorePlan(null);
                  setPreferenceRestoreResult(null);
                  setSnapshotError(null);
                  setSnapshotStatus(null);
                }}
                className="px-3 py-1.5 rounded-lg bg-background text-[11px] text-gray-500 hover:text-white transition"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="bg-background border border-border rounded-lg p-3">
            <div className="text-[11px] text-gray-500 mb-2">Import preview</div>
            {snapshotPreview ? (
              <div className="space-y-2 text-[11px]">
                <div className={cn('inline-flex px-2 py-1 rounded-lg', snapshotPreview.valid ? 'bg-green-500/10 text-green-400' : 'bg-yellow-500/10 text-yellow-400')}>
                  {snapshotPreview.valid ? 'Compatible' : 'Review warnings'}
                </div>
                <div className="text-gray-500">Version {snapshotPreview.version ?? 'unknown'}</div>
                {snapshotPreview.generatedBy && (
                  <div className="text-gray-500">
                    By {snapshotPreview.generatedBy.id} · {snapshotPreview.generatedBy.role} · {snapshotPreview.generatedBy.source}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 pt-2">
                  {Object.entries(snapshotPreview.counts).map(([key, value]) => (
                    <div key={key} className="rounded bg-surface px-2 py-1">
                      <div className="text-gray-600">{key}</div>
                      <div className="text-gray-300 font-semibold">{value}</div>
                    </div>
                  ))}
                </div>
                {snapshotPreview.warnings.length > 0 && (
                  <div className="pt-2 space-y-1">
                    {snapshotPreview.warnings.map(warning => (
                      <div key={warning} className="text-yellow-400">! {warning}</div>
                    ))}
                  </div>
                )}
                {restorePlan && (
                  <div className="pt-3 mt-3 border-t border-border space-y-2">
                    <div className="text-[11px] text-gray-500">Restore plan</div>
                    <div className="grid grid-cols-4 gap-1">
                      {([
                        ['create', restorePlan.summary.create, 'text-green-400'],
                        ['skip', restorePlan.summary.skip, 'text-gray-400'],
                        ['conflict', restorePlan.summary.conflict, 'text-red-400'],
                        ['warnings', restorePlan.summary.warnings, 'text-yellow-400'],
                      ] as const).map(([label, value, tone]) => (
                        <div key={label} className="rounded bg-surface px-2 py-1">
                          <div className="text-gray-600">{label}</div>
                          <div className={cn('font-semibold', tone)}>{value}</div>
                        </div>
                      ))}
                    </div>
                    <div className="max-h-44 overflow-y-auto space-y-1">
                      {restorePlan.actions.slice(0, 12).map(action => (
                        <div key={`${action.resourceType}-${action.resourceId}-${action.type}`} className="rounded bg-surface px-2 py-1">
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              'px-1.5 py-0.5 rounded text-[9px]',
                              action.type === 'create' ? 'bg-green-500/10 text-green-400' :
                              action.type === 'conflict' ? 'bg-red-500/10 text-red-400' :
                              'bg-gray-500/10 text-gray-400',
                            )}>
                              {action.type}
                            </span>
                            <span className="truncate text-gray-400">{action.resourceType}: {action.resourceId}</span>
                          </div>
                          <div className="text-[10px] text-gray-600 mt-0.5">{action.reason}</div>
                          {(action.dependencies?.length || 0) > 0 && (
                            <div className="text-[10px] text-yellow-400 mt-0.5">
                              missing: {action.dependencies?.join(', ')}
                            </div>
                          )}
                        </div>
                      ))}
                      {restorePlan.actions.length > 12 && (
                        <div className="text-[10px] text-gray-600 text-center py-1">
                          {restorePlan.actions.length - 12} more planned actions
                        </div>
                      )}
                      {restorePlan.actions.length === 0 && (
                        <div className="text-[10px] text-gray-600 text-center py-2">No restorable resources in this snapshot</div>
                      )}
                    </div>
                    <div className="rounded border border-yellow-500/20 bg-yellow-500/5 px-2 py-1 text-[10px] text-yellow-400">
                      Task, pipeline, inbox, notification, and event resources remain preview-only.
                    </div>
                    <button
                      onClick={() => restorePreferences()}
                      disabled={snapshotBusy || restorePlan.actions.every(action => action.resourceType !== 'preference')}
                      className="w-full px-3 py-1.5 rounded-lg bg-accent/10 text-accent-light text-[11px] hover:bg-accent/20 transition disabled:opacity-50"
                    >
                      Restore preferences only
                    </button>
                    {preferenceRestoreResult && (
                      <div className="rounded border border-border bg-background px-2 py-2 space-y-2">
                        <div className="text-[11px] text-gray-500">
                          Preference restore result · audit #{preferenceRestoreResult.auditActionId ?? 'n/a'}
                        </div>
                        <div className="grid grid-cols-3 gap-1">
                          {([
                            ['restored', preferenceRestoreResult.restored, 'text-green-400'],
                            ['skipped', preferenceRestoreResult.skipped, 'text-gray-400'],
                            ['failed', preferenceRestoreResult.failed, 'text-red-400'],
                          ] as const).map(([label, value, tone]) => (
                            <div key={label} className="rounded bg-surface px-2 py-1">
                              <div className="text-gray-600">{label}</div>
                              <div className={cn('font-semibold', tone)}>{value}</div>
                            </div>
                          ))}
                        </div>
                        <div className="max-h-32 overflow-y-auto space-y-1">
                          {preferenceRestoreResult.items.map(item => (
                            <div key={`${item.namespace}-${item.key}-${item.status}`} className="text-[10px]">
                              <span className={cn(
                                item.status === 'restored' ? 'text-green-400' :
                                item.status === 'failed' ? 'text-red-400' : 'text-gray-500',
                              )}>
                                {item.status}
                              </span>
                              <span className="text-gray-500"> · {item.namespace}/{item.key} · {item.reason}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-gray-600 py-8 text-center">Paste a snapshot and preview it before importing.</div>
            )}
          </div>
        </div>

        {snapshotStatus && <div className="text-xs text-green-400">{snapshotStatus}</div>}
        {snapshotError && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
            {snapshotError}
          </div>
        )}
      </section>
    </div>
  );
}
