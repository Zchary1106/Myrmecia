import { create } from 'zustand';
import { api } from '../lib/api';

export type McpConnection = { name: string; connected: boolean; toolCount: number; error?: string; managed?: boolean };
export type XiaohongshuConnectionStatus = Awaited<ReturnType<typeof api.mcp.xiaohongshuStatus>>;
let serversRequest: Promise<void> | null = null;
let loginRequest: Promise<XiaohongshuConnectionStatus> | null = null;

type ConnectionStore = {
  servers: McpConnection[];
  loading: boolean;
  error: string;
  xiaohongshu: XiaohongshuConnectionStatus | null;
  homeTarget: string | null;
  toolsMcpRequested: boolean;
  refresh: () => Promise<void>;
  checkXiaohongshu: () => Promise<XiaohongshuConnectionStatus>;
};

// Shared across pages, but not persisted: an old login success must not survive
// a reload without validation. QR images remain local to the Home panel.
export const useConnectionsStore = create<ConnectionStore>((set) => ({
  servers: [], loading: false, error: '', xiaohongshu: null,
  homeTarget: null, toolsMcpRequested: false,
  refresh: async () => {
    if (serversRequest) return serversRequest;
    set({ loading: true, error: '' });
    serversRequest = (async () => {
      try {
        const servers = await api.mcp.servers();
        set({ servers });
        if (!servers.some(server => server.name === 'xiaohongshu' && server.connected)) {
          set({ xiaohongshu: null });
        }
      } catch {
        set({ error: '无法读取连接状态，请重试。', xiaohongshu: null });
      } finally { set({ loading: false }); }
    })();
    try { await serversRequest; } finally { serversRequest = null; }
  },
  checkXiaohongshu: async () => {
    if (loginRequest) return loginRequest;
    loginRequest = (async () => {
      try {
        const status = await api.mcp.xiaohongshuStatus();
        set({ xiaohongshu: status });
        return status;
      } catch (err) {
        set({ xiaohongshu: { authenticated: false, state: 'unavailable', checkedAt: new Date().toISOString() } });
        throw err;
      }
    })();
    try { return await loginRequest; } finally { loginRequest = null; }
  },
}));
