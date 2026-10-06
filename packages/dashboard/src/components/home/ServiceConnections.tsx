import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, Plug, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { useStore } from '../../stores/store';
import { useConnectionsStore } from '../../stores/connections';
import { XiaohongshuLogin } from './XiaohongshuLogin';

const names: Record<string, string> = { xiaohongshu: '小红书', 'douyin-search': '抖音搜索', 'douyin-upload': '抖音发布', 'wechat-official-account': '微信公众号' };

export function ServiceConnections({ compact = false }: { compact?: boolean }) {
  const { servers, loading, error, refresh, xiaohongshu, homeTarget } = useConnectionsStore();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    const update = async () => {
      await refresh();
      setHasLoaded(true);
      if (useConnectionsStore.getState().servers.some(server => server.name === 'xiaohongshu' && server.connected)) {
        await useConnectionsStore.getState().checkXiaohongshu().catch(() => undefined);
      }
    };
    void update();
    const onFocus = () => { void update(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  useEffect(() => {
    if (!homeTarget) return;
    if (compact && !detailsOpen) {
      setDetailsOpen(true);
      return;
    }
    setExpanded(homeTarget);
    panel.current?.scrollIntoView?.({ block: 'center' });
    panel.current?.focus({ preventScroll: true });
    useConnectionsStore.setState({ homeTarget: null });
  }, [compact, detailsOpen, homeTarget]);

  useEffect(() => {
    if (xiaohongshu?.authenticated) {
      setExpanded(current => current === 'xiaohongshu' ? null : current);
    }
  }, [xiaohongshu?.authenticated, homeTarget]);

  useEffect(() => {
    if (!compact || !detailsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) setDetailsOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDetailsOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onEscape);
    };
  }, [compact, detailsOpen]);

  const reconnect = async (name: string) => {
    setReconnecting(name);
    setActionError('');
    try { await api.mcp.reconnect(name); await refresh(); }
    catch (err) { setActionError(err instanceof Error ? err.message : '重连失败，请查看详细配置。'); }
    finally { setReconnecting(null); }
  };
  const manage = () => {
    useConnectionsStore.setState({ toolsMcpRequested: true });
    useStore.getState().setActiveView('tools');
  };
  const xhsConnected = servers.some(server => server.name === 'xiaohongshu' && server.connected);
  const connectedCount = servers.filter(server => server.connected).length;
  const checking = loading || !hasLoaded;
  const needsAttention = Boolean(error) || (!checking && (connectedCount < servers.length || (xhsConnected && !xiaohongshu?.authenticated)));
  const summary = checking ? '检查中…' : error ? '状态读取失败' : !servers.length ? '未配置'
    : needsAttention ? '需要检查' : `${connectedCount} 已连接`;

  return (
    <div ref={wrapper} className={compact ? 'relative' : undefined}>
    {compact && <button ref={toggle} type="button" aria-expanded={detailsOpen} aria-controls={panelId} onClick={() => setDetailsOpen(open => !open)} className="glass-control app-focus inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] text-app-secondary transition hover:bg-surface-hover">
      <Plug size={14} className={needsAttention ? 'text-amber-500' : 'text-app-muted'} />
      工具与服务 <span className={needsAttention ? 'text-amber-600' : 'text-app-muted'}>{summary}</span>
      <ChevronDown size={12} className={detailsOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
    </button>}
    {(!compact || detailsOpen) && <section id={panelId} ref={panel} tabIndex={-1} aria-label="工具与服务" className={compact
      ? 'glass-popup absolute right-0 top-full z-40 mt-2 max-h-[70dvh] w-[min(480px,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-border bg-surface text-left shadow-xl outline-none focus-visible:ring-2 focus-visible:ring-accent'
      : 'app-panel mt-6 overflow-hidden text-left outline-none focus-visible:ring-2 focus-visible:ring-accent'}>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-app-primary"><Plug size={15} className="text-app-muted" />工具与服务</h2>
        <div className="flex items-center gap-3">
          <button type="button" disabled={loading} onClick={() => {
            void refresh().then(() => {
              if (useConnectionsStore.getState().servers.some(server => server.name === 'xiaohongshu' && server.connected)) void useConnectionsStore.getState().checkXiaohongshu().catch(() => undefined);
            });
          }} className="app-focus rounded p-1 text-app-muted disabled:opacity-50" aria-label="检查服务状态"><RefreshCw size={14} /></button>
          <button type="button" onClick={manage} className="app-focus flex items-center gap-1 text-xs text-app-muted hover:text-app-primary">详细配置<ArrowUpRight size={13} /></button>
        </div>
      </div>
      {error ? <p role="alert" className="border-t border-border px-4 py-3 text-xs text-red-500">{error}</p> : (
        <div className={`grid divide-y divide-border border-t border-border ${compact ? '' : 'sm:grid-cols-2 lg:grid-cols-3'}`}>
          {servers.map(server => {
            const label = !server.connected ? '未连接' : server.name !== 'xiaohongshu' ? '已连接'
              : !xiaohongshu ? '检查登录中' : xiaohongshu.authenticated ? '已登录'
                : xiaohongshu.state === 'login_required' ? '需要登录' : '登录检查异常';
            return (
              <div key={server.name} className="flex min-w-0 items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-app-primary">{names[server.name] || server.name}</div>
                  <div className="mt-1 text-[11px] text-app-muted">{server.toolCount} 个工具 · {server.name === 'xiaohongshu' ? 'Agent 授权单独控制' : '登录及业务权限未验证'}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={`text-[11px] ${!server.connected ? 'text-red-500' : server.name === 'xiaohongshu' && !xiaohongshu?.authenticated ? 'text-amber-600' : 'text-app-secondary'}`}>{label}</span>
                  {!server.connected
                    ? <button type="button" disabled={reconnecting !== null} onClick={() => void reconnect(server.name)} className="app-focus text-xs text-accent-light disabled:opacity-50">{reconnecting === server.name ? '连接中…' : '重连'}</button>
                    : server.name === 'xiaohongshu' && !xiaohongshu?.authenticated && <button type="button" aria-expanded={expanded === server.name} onClick={() => setExpanded(expanded === server.name ? null : server.name)} className="app-focus text-xs text-accent-light">登录</button>}
                </div>
              </div>
            );
          })}
          {!servers.length && <p className="px-4 py-3 text-xs text-app-muted">{loading ? '正在读取服务连接…' : '还没有配置 MCP 服务，可从详细配置开始。'}</p>}
        </div>
      )}
      {actionError && <p role="alert" className="px-4 pb-3 text-xs text-red-500">{actionError}</p>}
      {!error && expanded === 'xiaohongshu' && xhsConnected && !xiaohongshu?.authenticated && <div className="border-t border-border px-4 pt-3"><XiaohongshuLogin /></div>}
    </section>}
    </div>
  );
}
