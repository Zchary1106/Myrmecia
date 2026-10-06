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
        <div className="text-[11px] text-app-muted mt-0.5">{detail}</div>
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
    <section className="ui-panel p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl">✍️</span>
            <h3 className="text-sm font-semibold">微信公众号 MCP</h3>
            <span className={cn(
              'rounded-full px-2 py-1 text-[9px] font-semibold',
              connected ? 'bg-emerald-500/10 text-emerald-300' : summary?.configured ? 'bg-yellow-500/10 text-yellow-300' : 'bg-gray-500/10 text-app-muted',
            )}>
              {connected ? 'connected' : summary?.configured ? 'restart required' : 'not configured'}
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-[11px] leading-relaxed text-app-muted">
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
            <span className="text-[10px] font-medium text-app-secondary">AppID</span>
            <input
              value={appId}
              onChange={event => setAppId(event.target.value)}
              placeholder="wx1234567890abcdef"
              className="ui-field mt-1.5"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium text-app-secondary">AppSecret</span>
            <input
              type="password"
              value={appSecret}
              onChange={event => setAppSecret(event.target.value)}
              placeholder={summary?.configured ? '留空不会读取或显示现有密钥' : '32 位十六进制 AppSecret'}
              className="ui-field mt-1.5"
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
  const { health, diagnostics, loadHealth, loadDiagnostics, setActiveView } = useStore();
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
    <div data-configuration-page data-configuration-context="Runtime and workspace settings" className="ui-page">
      <header className="ui-page-heading">
        <div>
        <h1 className="ui-page-title">Settings</h1>
        <p className="ui-page-description">
          API token, connection diagnostics, and deployment readiness checks.
        </p>
        </div>
      </header>

      <section aria-labelledby="general-settings" className="ui-panel space-y-4 p-5">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-accent-light">General</div>
          <h3 id="general-settings" className="mt-2 text-sm font-semibold">API token</h3>
          <p className="text-[11px] text-app-muted mt-1">
            Used for HTTP Authorization and WebSocket authentication when the server has API_AUTH_TOKEN enabled.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="Bearer token"
            className="ui-field flex-1"
          />
          <button
            onClick={() => saveToken()}
            className="ui-button-primary"
          >
            Save
          </button>
          <button
            onClick={() => clearToken()}
            className="ui-button"
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

      <section className="ui-panel p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-accent-light">Model configuration</div>
            <h3 className="mt-2 text-sm font-semibold">Providers, models and routing</h3>
            <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-app-muted">Provider credentials, Copilot sign-in, discovered models, registry health and advanced role routing now live on the dedicated Models page.</p>
          </div>
          <button type="button" onClick={() => setActiveView('models')} className="ui-button-primary shrink-0">Open Models</button>
        </div>
      </section>

      <section aria-labelledby="integrations-settings" className="space-y-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-accent-light">Integrations</div>
          <h3 id="integrations-settings" className="mt-1 text-sm font-semibold">Connected services</h3>
        </div>
        <WeChatIntegrationSettings />
      </section>

      <section aria-labelledby="runtime-settings" className="space-y-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-accent-light">Runtime</div>
          <h3 id="runtime-settings" className="mt-1 text-sm font-semibold">Deployment and diagnostics</h3>
        </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="ui-panel p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold">Deployment checks</h3>
            <button
              onClick={() => checkConnection()}
              className="ui-button"
            >
              Recheck
            </button>
          </div>
          <div className="space-y-2">
            {checks.map(check => <CheckRow key={check.label} {...check} />)}
          </div>
        </div>

        <div className="ui-panel p-5">
          <h3 className="text-sm font-semibold mb-4">Runtime diagnostics</h3>
          {diagnostics ? (
            <div className="space-y-2 text-[12px]">
              <div className="flex justify-between"><span className="text-app-muted">Auth mode</span><span>{diagnostics.auth.mode}</span></div>
              <div className="flex justify-between gap-3"><span className="text-app-muted">Operator</span><span className="text-right">{operatorRoleLabel(diagnostics)}</span></div>
              <div className="flex justify-between"><span className="text-app-muted">Runtime controls</span><span>{diagnostics.operator.permissions.canControlRuntime ? 'allowed' : 'read-only'}</span></div>
              <div className="flex justify-between"><span className="text-app-muted">Task delete</span><span>{diagnostics.operator.permissions.canDeleteTasks ? 'allowed' : 'admin only'}</span></div>
              <div className="flex justify-between"><span className="text-app-muted">Queue</span><span>{diagnostics.queue.backend}</span></div>
              <div className="flex justify-between"><span className="text-app-muted">Database</span><span>{diagnostics.database.pathSource}:{diagnostics.database.pathHint}</span></div>
              <div className="flex justify-between"><span className="text-app-muted">Node</span><span>{diagnostics.runtime.nodeVersion}</span></div>
              <div className="flex justify-between"><span className="text-app-muted">Platform</span><span>{diagnostics.runtime.platform}</span></div>
              <div className="flex justify-between"><span className="text-app-muted">Environment</span><span>{diagnostics.runtime.environment}</span></div>
              <div className="pt-3 mt-3 border-t border-border">
                <div className="text-[11px] text-app-muted mb-2">Applied migrations</div>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {diagnostics.database.migrations.map(migration => (
                    <div key={migration.id} className="text-[11px] text-app-secondary">{migration.id}</div>
                  ))}
                  {diagnostics.database.migrations.length === 0 && (
                    <div className="text-[11px] text-app-muted">No migrations recorded</div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-app-muted py-8 text-center">Run a connection check to load diagnostics.</div>
          )}
        </div>
      </div>
      </section>

      <section aria-labelledby="recovery-settings" className="ui-panel space-y-4 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-accent-light">Data & recovery</div>
            <h3 id="recovery-settings" className="mt-2 text-sm font-semibold">Workspace snapshot</h3>
            <p className="text-[11px] text-app-muted mt-1">
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
                className="px-3 py-1.5 rounded-lg bg-surface-hover text-[11px] text-app-secondary hover:text-app-primary transition disabled:opacity-50"
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
                className="px-3 py-1.5 rounded-lg bg-background text-[11px] text-app-muted hover:text-app-primary transition"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="bg-background border border-border rounded-lg p-3">
            <div className="text-[11px] text-app-muted mb-2">Import preview</div>
            {snapshotPreview ? (
              <div className="space-y-2 text-[11px]">
                <div className={cn('inline-flex px-2 py-1 rounded-lg', snapshotPreview.valid ? 'bg-green-500/10 text-green-400' : 'bg-yellow-500/10 text-yellow-400')}>
                  {snapshotPreview.valid ? 'Compatible' : 'Review warnings'}
                </div>
                <div className="text-app-muted">Version {snapshotPreview.version ?? 'unknown'}</div>
                {snapshotPreview.generatedBy && (
                  <div className="text-app-muted">
                    By {snapshotPreview.generatedBy.id} · {snapshotPreview.generatedBy.role} · {snapshotPreview.generatedBy.source}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 pt-2">
                  {Object.entries(snapshotPreview.counts).map(([key, value]) => (
                    <div key={key} className="rounded bg-surface px-2 py-1">
                      <div className="text-app-muted">{key}</div>
                      <div className="text-app-secondary font-semibold">{value}</div>
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
                    <div className="text-[11px] text-app-muted">Restore plan</div>
                    <div className="grid grid-cols-4 gap-1">
                      {([
                        ['create', restorePlan.summary.create, 'text-green-400'],
                        ['skip', restorePlan.summary.skip, 'text-app-secondary'],
                        ['conflict', restorePlan.summary.conflict, 'text-red-400'],
                        ['warnings', restorePlan.summary.warnings, 'text-yellow-400'],
                      ] as const).map(([label, value, tone]) => (
                        <div key={label} className="rounded bg-surface px-2 py-1">
                          <div className="text-app-muted">{label}</div>
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
                              'bg-gray-500/10 text-app-secondary',
                            )}>
                              {action.type}
                            </span>
                            <span className="truncate text-app-secondary">{action.resourceType}: {action.resourceId}</span>
                          </div>
                          <div className="text-[10px] text-app-muted mt-0.5">{action.reason}</div>
                          {(action.dependencies?.length || 0) > 0 && (
                            <div className="text-[10px] text-yellow-400 mt-0.5">
                              missing: {action.dependencies?.join(', ')}
                            </div>
                          )}
                        </div>
                      ))}
                      {restorePlan.actions.length > 12 && (
                        <div className="text-[10px] text-app-muted text-center py-1">
                          {restorePlan.actions.length - 12} more planned actions
                        </div>
                      )}
                      {restorePlan.actions.length === 0 && (
                        <div className="text-[10px] text-app-muted text-center py-2">No restorable resources in this snapshot</div>
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
                        <div className="text-[11px] text-app-muted">
                          Preference restore result · audit #{preferenceRestoreResult.auditActionId ?? 'n/a'}
                        </div>
                        <div className="grid grid-cols-3 gap-1">
                          {([
                            ['restored', preferenceRestoreResult.restored, 'text-green-400'],
                            ['skipped', preferenceRestoreResult.skipped, 'text-app-secondary'],
                            ['failed', preferenceRestoreResult.failed, 'text-red-400'],
                          ] as const).map(([label, value, tone]) => (
                            <div key={label} className="rounded bg-surface px-2 py-1">
                              <div className="text-app-muted">{label}</div>
                              <div className={cn('font-semibold', tone)}>{value}</div>
                            </div>
                          ))}
                        </div>
                        <div className="max-h-32 overflow-y-auto space-y-1">
                          {preferenceRestoreResult.items.map(item => (
                            <div key={`${item.namespace}-${item.key}-${item.status}`} className="text-[10px]">
                              <span className={cn(
                                item.status === 'restored' ? 'text-green-400' :
                                item.status === 'failed' ? 'text-red-400' : 'text-app-muted',
                              )}>
                                {item.status}
                              </span>
                              <span className="text-app-muted"> · {item.namespace}/{item.key} · {item.reason}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-app-muted py-8 text-center">Paste a snapshot and preview it before importing.</div>
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
