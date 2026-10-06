import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { McpLocalService, parseLocalServices } from '../src/tools/mcp-local-service.js';
import { McpManager } from '../src/tools/mcp-manager.js';
import { fileURLToPath } from 'node:url';

const services: McpLocalService[] = [];
const managers: McpManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.shutdown()));
  await Promise.all(services.splice(0).map(service => service.dispose()));
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function listener() {
  const server = createServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

describe('managed local MCP service', () => {
  it('validates explicit launch configuration', () => {
    expect(parseLocalServices('{}')).toEqual({});
    expect(() => parseLocalServices('[]')).toThrow();
    expect(() => parseLocalServices('{"x":{"command":"x","port":0}}')).toThrow();
    expect(() => parseLocalServices('{"x":{"command":"x","port":18060,"args":"-h"}}')).toThrow();
  });

  it('reuses an existing listener without spawning or stopping it', async () => {
    const { server, port } = await listener();
    try {
      const service = new McpLocalService({ command: '/does-not-exist', port });
      services.push(service);
      await service.ensureStarted();
      service.dispose();
      expect(server.listening).toBe(true);
    } finally { server.close(); }
  });

  it('starts the service before the bridge performs its MCP handshake', async () => {
    const { server, port } = await listener();
    await new Promise<void>(resolve => server.close(() => resolve()));
    const config = {
      command: process.execPath,
      args: ['-e', `require("node:net").createServer(s=>s.end()).listen(${port},"127.0.0.1")`],
      port,
      startupTimeoutMs: 3000,
    };
    vi.stubEnv('MCP_LOCAL_SERVICES', JSON.stringify({ mock: config }));
    const manager = new McpManager();
    managers.push(manager);
    await manager.init([{
      name: 'mock', command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/mock-mcp-server.mjs', import.meta.url))],
    }]);
    expect(manager.servers()[0]).toMatchObject({ name: 'mock', connected: true, managed: true });
    expect(manager.listTools().length).toBeGreaterThan(0);
    manager.removeServer('mock');
    expect(manager.servers()).toEqual([]);
    await manager.shutdown();
    // Owned service releases the port; shutdown does not merely hide it from
    // the manager's registry while leaving an orphan process running.
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('reports missing executable and keeps failed config visible for retries', async () => {
    const { server, port } = await listener();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.stubEnv('MCP_LOCAL_SERVICES', JSON.stringify({
      missing: { command: '/nonexistent/mcp-service', port, startupTimeoutMs: 1000 },
    }));
    const manager = new McpManager();
    managers.push(manager);
    await manager.init([{ name: 'missing', command: process.execPath }]);
    expect(manager.servers()[0]).toMatchObject({ connected: false, toolCount: 0, managed: true });
    expect(manager.servers()[0].error).toContain('Retrying');
    manager.removeServer('missing');
    expect(manager.servers()).toEqual([]);
  });

  it('times out a process that never becomes ready', async () => {
    const { server, port } = await listener();
    await new Promise<void>(resolve => server.close(() => resolve()));
    const service = new McpLocalService({
      command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], port, startupTimeoutMs: 150,
    });
    services.push(service);
    await expect(service.ensureStarted()).rejects.toThrow('startup timeout');
    service.dispose();
    await expect(service.ensureStarted()).rejects.toThrow('stopped');
  });

  it('retries configured connections, but never reconnects after shutdown', async () => {
    vi.stubEnv('MCP_LOCAL_SERVICES', '{}');
    vi.useFakeTimers();
    const manager = new McpManager();
    managers.push(manager);
    const connect = vi.spyOn(manager, 'addServer').mockRejectedValue(new Error('not ready'));
    await manager.init([{ name: 'retry', command: 'unused' }]);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(manager.servers()[0].error).toContain('retry');
    await manager.shutdown();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
