import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useConnectionsStore } from '../../stores/connections';

export function XiaohongshuLogin({ required = false }: { required?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const authenticated = useConnectionsStore(state => state.xiaohongshu?.authenticated === true);
  const [qr, setQr] = useState<{ image: string; expiresAt: string }>();
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const statusRequest = useRef<Promise<void> | null>(null);

  const invalidateRequests = useCallback(() => {
    generation.current++;
    // Drop the component's stale subscriber, not the shared network request.
    // StrictMode's next setup must attach a fresh subscriber to that request
    // so its completion can release the current UI's checking state.
    statusRequest.current = null;
  }, []);

  useEffect(() => invalidateRequests, [invalidateRequests]);

  const checkStatus = useCallback(async (showMissing = false) => {
    if (statusRequest.current) return statusRequest.current;
    const id = generation.current;
    setChecking(true);
    const request = (async () => {
      try {
        const status = await useConnectionsStore.getState().checkXiaohongshu();
        if (id !== generation.current) return;
        if (status.authenticated) {
          setQr(undefined);
          setExpired(false);
          setError('');
          setOpen(false);
        } else {
          setError(status.state === 'unavailable'
            ? 'MCP 登录检查暂时不可用，请稍后检查。'
            : showMissing ? '手机扫码后，MCP 尚未确认登录。请确认手机端授权已完成，稍后再次检查；无需立即刷新二维码。' : '');
        }
      } catch {
        if (id === generation.current) setError('无法检查登录状态，请稍后重试。');
      } finally {
        if (id === generation.current) setChecking(false);
      }
    })();
    statusRequest.current = request;
    try { await request; } finally {
      if (statusRequest.current === request) statusRequest.current = null;
    }
  }, []);

  // Re-entering a conversation or returning from the phone must refresh the
  // actual account state, not reset the display to "logged out".
  useEffect(() => {
    void checkStatus();
    const onFocus = () => { void checkStatus(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [checkStatus]);

  const login = async () => {
    invalidateRequests();
    const id = generation.current;
    setOpen(true);
    setBusy(true);
    setChecking(false);
    setQr(undefined);
    setExpired(false);
    setError('');
    try {
      const result = await api.mcp.xiaohongshuLogin();
      if (id !== generation.current) return;
      useConnectionsStore.setState({ xiaohongshu: {
        authenticated: result.authenticated,
        state: result.authenticated ? 'logged_in' : 'login_required',
        checkedAt: new Date().toISOString(),
      } });
      if (result.authenticated) setOpen(false);
      if (!result.authenticated && result.image && result.expiresAt) {
        setQr({ image: result.image, expiresAt: result.expiresAt });
      } else if (!result.authenticated) {
        setError('没有取得二维码，请重试。');
      }
    } catch (err) {
      if (id === generation.current) setError(err instanceof Error ? err.message : '登录服务不可用。');
    } finally {
      if (id === generation.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (!open || !qr || authenticated) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (cancelled) return;
      if (Date.now() >= Date.parse(qr.expiresAt)) {
        setExpired(true);
      }
      // QR display expiry does not mean the server's login callback expired.
      // Keep checking for a bounded grace period to catch delayed cookie saves.
      await checkStatus();
      if (!cancelled && Date.now() < Date.parse(qr.expiresAt) + 180_000) {
        timer = setTimeout(poll, 5000);
      }
    };
    timer = setTimeout(poll, 5000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, qr, authenticated, checkStatus]);

  return (
    <section aria-label="Xiaohongshu login" className="mb-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => authenticated ? void checkStatus(true) : void login()} disabled={busy || checking} className="app-focus rounded-lg border border-border px-2.5 py-1.5 font-medium text-app-secondary hover:bg-surface-hover disabled:opacity-50">
          {checking ? '正在检查登录…' : busy ? '正在获取二维码…' : authenticated ? '检查小红书登录' : '小红书登录'}
        </button>
        <span role="status" className={required && !authenticated ? 'text-amber-600' : 'text-app-muted'}>
          {authenticated ? '已登录，可返回会话继续查询。' : required ? '站内查询被登录状态阻塞，请扫码后重试。' : '站内资料查询需登录独立的 MCP 账号。'}
        </span>
        {!authenticated && <button type="button" onClick={() => void checkStatus(true)} disabled={checking || busy} className="app-focus rounded px-2 py-1 text-accent-light disabled:opacity-50">
          我已扫码，检查登录
        </button>}
      </div>
      {!open && error && <p className="mt-2 text-red-500" role="alert">{error}</p>}
      {open && (
        <div className="mt-2 rounded-xl border border-border bg-surface p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-app-primary">小红书 MCP 扫码登录</span>
            <button type="button" aria-label="Close Xiaohongshu login" onClick={() => {
              invalidateRequests(); setOpen(false); setQr(undefined); setBusy(false); setChecking(false);
            }} className="app-focus rounded px-2 py-1 text-app-muted">关闭</button>
          </div>
          <p className="mt-1 text-app-muted">请用手机小红书扫码并确认。此登录用于本地共享 MCP 服务，不会授予 Agent 发布权限。</p>
          {qr && !authenticated && !expired && <img src={qr.image} alt="小红书登录二维码，请用手机小红书扫码" className="mx-auto my-3 h-44 w-44 rounded-lg bg-white p-2 object-contain" />}
          {busy && <p className="mt-2 text-app-secondary" role="status">正在获取二维码，请稍候。</p>}
          {authenticated && <p className="mt-2 text-emerald-600" role="status">登录成功。任务不会自动重发，请发送追问重新查询。</p>}
          {expired && !authenticated && <p className="mt-2 text-app-secondary">二维码已隐藏，仍在检查登录结果。已扫码请点击“我已扫码，检查登录”；未扫码可刷新二维码。</p>}
          {error && <p className="mt-2 text-red-500" role="alert">{error}</p>}
          {!busy && !authenticated && <button type="button" onClick={() => void login()} className="app-focus mt-2 text-accent-light">刷新二维码</button>}
        </div>
      )}
    </section>
  );
}
